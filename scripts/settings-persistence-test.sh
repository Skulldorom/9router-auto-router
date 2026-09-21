#!/bin/sh
set -eu

IMAGE="${1:-9router-auto-router:persistence}"
NAME="9router-auto-router-settings-$$"
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$ROOT/scripts/lib-container-test.sh"
DATA_DIR=$(mktemp -d)
WORK_DIR=$(mktemp -d)
# Keep the cookie jar off the bind mount: the image entrypoint chowns /app/data to
# its runtime user, which would otherwise make the runner-owned jar unwritable.
COOKIE_JAR="$WORK_DIR/cookies.txt"
PASSWORD="auto-router-integration-password"
OWNER_UID=$(id -u)
OWNER_GID=$(id -g)
RUNTIME_USER=$(container_runtime_user "$IMAGE")

cleanup() {
  status=$?
  trap - EXIT INT TERM
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR" 2>/dev/null || true
  if ! purge_dir "$IMAGE" "$DATA_DIR" "$OWNER_UID" "$OWNER_GID"; then
    echo "Settings persistence test cleanup failed: could not remove $DATA_DIR." >&2
    [ "$status" -ne 0 ] && exit "$status"
    exit 1
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Prepare the bind mount for the image's actual runtime user, not a guessed UID.
prepare_data_dir "$IMAGE" "$DATA_DIR" "$RUNTIME_USER"

start() {
  docker run -d --name "$NAME" -v "$DATA_DIR:/app/data" -e NODE_ENV=production -e INITIAL_PASSWORD="$PASSWORD" -p 127.0.0.1::20128 "$IMAGE" >/dev/null
  PORT=$(docker port "$NAME" 20128/tcp | sed 's/.*://')
  if ! wait_for_login "http://127.0.0.1:${PORT}/api/auth/login" "$COOKIE_JAR" "$PASSWORD" 60; then
    dump_container_logs "$NAME"
    echo "Settings persistence test failed: login did not succeed (last status ${last_status:-none})." >&2
    exit 1
  fi
}

assert_settings() {
  curl --fail --silent --show-error --cookie "$COOKIE_JAR" "http://127.0.0.1:${PORT}/api/settings" | node -e '
    let data=""; process.stdin.on("data", chunk => data += chunk); process.stdin.on("end", () => {
      const settings = JSON.parse(data), strategies = settings.comboStrategies || {};
      const expected = {
        "coder-auto": { fallbackStrategy: "auto", autoRouter: { easyTarget: "coder", hardTarget: "coder-high", hardThreshold: 6, longContextChars: 24000, largeToolResultChars: 12000, manyTools: 16, verbose: false } },
        "chat-auto": { fallbackStrategy: "auto", autoRouter: { easyTarget: "chat", hardTarget: "chat-high", hardThreshold: 9, longContextChars: 30000, largeToolResultChars: 15000, manyTools: 20, verbose: true } },
      };
      for (const [name, strategy] of Object.entries(expected)) {
        if (JSON.stringify(strategies[name]) !== JSON.stringify(strategy)) throw new Error(`unexpected persisted ${name} configuration`);
      }
    });
  '
}

PAYLOAD='{"comboStrategies":{"coder-auto":{"fallbackStrategy":"auto","autoRouter":{"easyTarget":"coder","hardTarget":"coder-high","hardThreshold":6,"longContextChars":24000,"largeToolResultChars":12000,"manyTools":16,"verbose":false}},"chat-auto":{"fallbackStrategy":"auto","autoRouter":{"easyTarget":"chat","hardTarget":"chat-high","hardThreshold":9,"longContextChars":30000,"largeToolResultChars":15000,"manyTools":20,"verbose":true}}}}'
start
curl --fail --silent --show-error --cookie "$COOKIE_JAR" --cookie-jar "$COOKIE_JAR" -X PATCH -H 'Content-Type: application/json' --data "$PAYLOAD" "http://127.0.0.1:${PORT}/api/settings" >/dev/null
assert_settings
docker rm -f "$NAME" >/dev/null
start
assert_settings
echo "Settings persistence test passed: API save/reload survives a container restart using the same /app/data."
