#!/bin/sh
set -eu

IMAGE="${1:-9router-auto-router:runtime}"
NAME="9router-auto-router-runtime-$$"

cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

docker run -d --name "$NAME" --tmpfs /app/data:uid=1000,gid=1000 -e NODE_ENV=production -p 127.0.0.1::20128 "$IMAGE" >/dev/null
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
