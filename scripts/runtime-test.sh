#!/bin/sh
set -eu

IMAGE="${1:-9router-auto-router:runtime}"
NAME="9router-auto-router-runtime-$$"
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$ROOT/scripts/lib-container-test.sh"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

RUNTIME_USER=$(container_runtime_user "$IMAGE") || {
  echo "Runtime test failed: could not determine the runtime UID/GID for ${IMAGE}." >&2
  exit 1
}
case "$RUNTIME_USER" in
  *:*) RUNTIME_UID=${RUNTIME_USER%%:*}; RUNTIME_GID=${RUNTIME_USER#*:} ;;
  *) echo "Runtime test failed: invalid runtime UID/GID for ${IMAGE}." >&2; exit 1 ;;
esac

docker run -d --name "$NAME" --tmpfs "/app/data:uid=${RUNTIME_UID},gid=${RUNTIME_GID}" -e NODE_ENV=production -p 127.0.0.1::20128 "$IMAGE" >/dev/null
port=$(docker port "$NAME" 20128/tcp | sed 's/.*://')

attempt=0
while [ "$attempt" -lt 30 ]; do
  status=$(curl --silent --show-error --output /dev/null --write-out '%{http_code}' "http://127.0.0.1:${port}/" || true)
  case "$status" in
    2??|3??)
      echo "Runtime test passed: ${IMAGE} responded on port ${port} with HTTP ${status}."
      exit 0
      ;;
  esac
  attempt=$((attempt + 1))
  sleep 1
done

docker logs "$NAME" >&2 || true
echo "Runtime test failed: ${IMAGE} did not respond on port ${port}." >&2
exit 1
