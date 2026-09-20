#!/bin/sh
set -eu

IMAGE="${1:-9router-auto-router:persistence}"
NAME="9router-auto-router-settings-$$"
DATA_DIR=$(mktemp -d)
COOKIE_JAR="$DATA_DIR/cookies.txt"
PASSWORD="auto-router-integration-password"
OWNER_UID=$(id -u)
OWNER_GID=$(id -g)

cleanup() {
  status=$?
  trap - EXIT INT TERM
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  if [ -d "$DATA_DIR" ] && ! rmdir "$DATA_DIR" 2>/dev/null; then
    docker run --rm --user 0:0 --entrypoint /bin/sh -v "$DATA_DIR:/cleanup" "$IMAGE" \
      -c 'find /cleanup -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; chown "$1:$2" /cleanup' -- "$OWNER_UID" "$OWNER_GID" || true
    if ! rmdir "$DATA_DIR"; then
      echo "Settings persistence test cleanup failed: could not remove $DATA_DIR." >&2
      [ "$status" -ne 0 ] && exit "$status"
      exit 1
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
chmod 755 "$DATA_DIR"

start() {
  docker run -d --name "$NAME" -v "$DATA_DIR:/app/data" -e NODE_ENV=production -e INITIAL_PASSWORD="$PASSWORD" -p 127.0.0.1::20128 "$IMAGE" >/dev/null
  PORT=$(docker port "$NAME" 20128/tcp | sed 's/.*://')
  attempt=0
  while [ "$attempt" -lt 30 ]; do
    status=$(curl --silent --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:${PORT}/api/auth/login" || true)
    [ "$status" != 000 ] && return 0
    attempt=$((attempt + 1))
    sleep 1
  done
  docker logs "$NAME" >&2 || true
  echo "Settings persistence test failed: ${IMAGE} did not start." >&2
  exit 1
}

login() {
  curl --fail --silent --show-error --cookie "$COOKIE_JAR" --cookie-jar "$COOKIE_JAR" \
    -H 'Content-Type: application/json' --data "{\"password\":\"${PASSWORD}\"}" \
    "http://127.0.0.1:${PORT}/api/auth/login" >/dev/null
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
login
curl --fail --silent --show-error --cookie "$COOKIE_JAR" --cookie-jar "$COOKIE_JAR" -X PATCH -H 'Content-Type: application/json' --data "$PAYLOAD" "http://127.0.0.1:${PORT}/api/settings" >/dev/null
assert_settings
docker rm -f "$NAME" >/dev/null
start
login
assert_settings
echo "Settings persistence test passed: API save/reload survives a container restart using the same /app/data."
