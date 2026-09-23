#!/bin/sh
set -eu

IMAGE=${1:?Usage: verify-built-image.sh IMAGE [REVISION] [UPSTREAM_DIGEST]}
EXPECTED_REVISION=${2:-${EXPECTED_REVISION:-}}
EXPECTED_UPSTREAM_DIGEST=${3:-${EXPECTED_UPSTREAM_DIGEST:-}}
MARKER=9router-auto-router:v3
UI_MARKER=9router-auto-router-ui:v5

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

docker run --rm -i --entrypoint sh "$IMAGE" <<'SH' || fail "runtime overlay or generated UI verification failed"
set -eu
[ -f /opt/9router-auto-router/auto-router-config.cjs ]
[ -f /opt/9router-auto-router/auto-router.cjs ]
[ -f /opt/9router-auto-router/apply-patch.mjs ]
runtime_files=$(grep -RFl "9router-auto-router:v3" /app/.next/server 2>/dev/null || true)
[ "$(printf "%s\n" "$runtime_files" | sed "/^$/d" | wc -l)" -eq 1 ]
runtime_file=$(printf "%s\n" "$runtime_files" | sed -n "/./{p;q;}")
[ "$(grep -o "routeAutoCombo" "$runtime_file" | wc -l)" -eq 2 ]
ui_files=$(grep -RFl "9router-auto-router-ui:v5" /app/.next 2>/dev/null || true)
[ "$(printf "%s\n" "$ui_files" | sed "/^$/d" | wc -l)" -eq 2 ]
for file in $ui_files; do
  [ "$(grep -o "9router-auto-router-ui:v5" "$file" | wc -l)" -eq 1 ]
  [ "$(grep -o "label:\"Auto Router\"" "$file" | wc -l)" -eq 2 ]
  [ "$(grep -o "availableCombos:" "$file" | wc -l)" -eq 2 ]
  [ "$(grep -o "availableCombos:[A-Za-z_$][A-Za-z0-9_$]*\.map(" "$file" | wc -l)" -eq 1 ]
  if grep -q "availableCombos:_arComboCollection.map(" "$file"; then
    grep -Eq "\.map\(\([^,]+,_arComboIndex,_arComboCollection\)=>.*availableCombos:_arComboCollection\.map\(" "$file"
  fi
  ! grep -Eq "availableCombos:[A-Za-z_$][A-Za-z0-9_$]*\.map\([^A-Za-z_$]" "$file"
  [ "$(grep -o "autoRouter" "$file" | wc -l)" -ge 2 ]
  grep -q "Easy target" "$file"
  grep -q "Hard target" "$file"
  grep -q "Advanced" "$file"
done
node /opt/9router-auto-router/apply-patch.mjs /app --check
SH
echo "Built image verification passed: ${IMAGE} revision=${revision} upstream=${upstream_digest}"
