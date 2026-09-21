#!/bin/sh
set -eu

IMAGE=${1:?Usage: verify-built-image.sh IMAGE [REVISION] [UPSTREAM_DIGEST]}
EXPECTED_REVISION=${2:-${EXPECTED_REVISION:-}}
EXPECTED_UPSTREAM_DIGEST=${3:-${EXPECTED_UPSTREAM_DIGEST:-}}
MARKER=9router-auto-router:v3
UI_MARKER=9router-auto-router-ui:v3

fail() {
  echo "Built image verification failed: $*" >&2
  exit 1
}

inspect_label() {
  docker image inspect "$IMAGE" --format "{{ index .Config.Labels \"$1\" }}"
}

[ "$(docker image inspect "$IMAGE" --format '{{.Id}}' 2>/dev/null)" ] || fail "image does not exist: $IMAGE"
revision=$(inspect_label org.opencontainers.image.revision)
upstream_image=$(inspect_label io.github.skulldorom.9router-auto-router.upstream.image)
upstream_digest=$(inspect_label io.github.skulldorom.9router-auto-router.upstream.digest)
[ -n "$revision" ] && [ "$revision" != unknown ] || fail "missing OCI revision label"
[ -n "$upstream_image" ] && [ "$upstream_image" != unknown ] || fail "missing upstream image label"
printf '%s' "$upstream_digest" | grep -Eq '^sha256:[0-9a-f]{64}$' || fail "missing or invalid upstream digest label"
[ -z "$EXPECTED_REVISION" ] || [ "$revision" = "$EXPECTED_REVISION" ] || fail "OCI revision label differs from validated revision"
[ -z "$EXPECTED_UPSTREAM_DIGEST" ] || [ "$upstream_digest" = "$EXPECTED_UPSTREAM_DIGEST" ] || fail "upstream digest label differs from validated digest"

check='set -eu
[ -f /opt/9router-auto-router/auto-router.cjs ]
[ -f /opt/9router-auto-router/apply-patch.mjs ]
runtime_files=$(grep -RFl "9router-auto-router:v3" /app/.next/server 2>/dev/null || true)
[ "$(printf "%s\\n" "$runtime_files" | sed "/^$/d" | wc -l)" -eq 1 ]
runtime_file=$(printf "%s\\n" "$runtime_files" | sed -n "/./{p;q;}")
[ "$(grep -o "routeAutoCombo" "$runtime_file" | wc -l)" -eq 2 ]
ui_files=$(grep -RFl "9router-auto-router-ui:v3" /app/.next 2>/dev/null || true)
[ "$(printf "%s\\n" "$ui_files" | sed "/^$/d" | wc -l)" -eq 2 ]
for file in $ui_files; do
  grep -Fq "label:\"Auto Router\"" "$file"
  grep -Fq "Easy target" "$file"
  grep -Fq "Hard target" "$file"
  grep -Fq "autoRouter" "$file"
done
'
docker run --rm --entrypoint sh "$IMAGE" -c "$check" || fail "runtime overlay or generated UI verification failed"
echo "Built image verification passed: ${IMAGE} revision=${revision} upstream=${upstream_digest}"
