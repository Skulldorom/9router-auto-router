#!/bin/sh
set -eu
IMAGE="${UPSTREAM_IMAGE:-decolua/9router:0.5.75}"
if ! command -v docker >/dev/null 2>&1; then echo "9Router upstream compatibility check failed. Docker is required." >&2; exit 1; fi
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull "$IMAGE" >/dev/null
check='test -f /app/.next/server/chunks/8635.js || exit 10; test -f /app/open-sse/services/combo.js || exit 11; grep -Fq "handleComboChat" /app/open-sse/services/combo.js || exit 12; grep -Fq "detectRequiredCapabilities" /app/open-sse/services/combo.js || exit 13; grep -Fq "comboStrategies" /app/.next/server/chunks/8635.js || exit 14; grep -Fq "Combo \"" /app/.next/server/chunks/8635.js || exit 15'
if ! docker run --rm --entrypoint sh "$IMAGE" -c "$check"; then
  printf '%s\n' '9Router upstream compatibility check failed.' 'Expected integration anchor no longer exists:' '/app/.next/server/chunks/8635.js' 'Review the latest upstream changes before rebuilding.' >&2
  exit 1
fi
echo "9Router upstream compatibility check passed: $IMAGE"
