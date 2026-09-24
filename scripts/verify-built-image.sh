#!/bin/sh
set -eu

IMAGE=${1:?Usage: verify-built-image.sh IMAGE [REVISION] [UPSTREAM_DIGEST] [AUTO_ROUTER_VERSION] [UPSTREAM_VERSION]}
EXPECTED_REVISION=${2:-${EXPECTED_REVISION:-}}
EXPECTED_UPSTREAM_DIGEST=${3:-${EXPECTED_UPSTREAM_DIGEST:-}}
EXPECTED_AUTO_ROUTER_VERSION=${4:-${EXPECTED_AUTO_ROUTER_VERSION:-}}
EXPECTED_UPSTREAM_VERSION=${5:-${EXPECTED_UPSTREAM_VERSION:-}}
MARKER=9router-auto-router:v3
UI_MARKER=9router-auto-router-ui:v9

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
auto_router_version=$(inspect_label io.github.skulldorom.9router-auto-router.version)
oci_version=$(inspect_label org.opencontainers.image.version)
upstream_version=$(inspect_label io.github.skulldorom.9router-auto-router.upstream.version)
[ -n "$revision" ] && [ "$revision" != unknown ] || fail "missing OCI revision label"
[ -n "$upstream_image" ] && [ "$upstream_image" != unknown ] || fail "missing upstream image label"
printf '%s' "$upstream_digest" | grep -Eq '^sha256:[0-9a-f]{64}$' || fail "missing or invalid upstream digest label"
printf '%s' "$auto_router_version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail "missing or invalid Auto Router version label"
[ "$auto_router_version" = "$oci_version" ] || fail "Auto Router version label differs from the OCI version label"
printf '%s' "$upstream_version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || fail "missing or invalid upstream version label"
[ -z "$EXPECTED_REVISION" ] || [ "$revision" = "$EXPECTED_REVISION" ] || fail "OCI revision label differs from validated revision"
[ -z "$EXPECTED_UPSTREAM_DIGEST" ] || [ "$upstream_digest" = "$EXPECTED_UPSTREAM_DIGEST" ] || fail "upstream digest label differs from validated digest"
[ -z "$EXPECTED_AUTO_ROUTER_VERSION" ] || [ "$auto_router_version" = "$EXPECTED_AUTO_ROUTER_VERSION" ] || fail "Auto Router version label differs from the resolved release version"
[ -z "$EXPECTED_UPSTREAM_VERSION" ] || [ "$upstream_version" = "$EXPECTED_UPSTREAM_VERSION" ] || fail "upstream version label differs from the validated upstream version"

docker run --rm -i --entrypoint sh "$IMAGE" <<'SH' || fail "runtime overlay or generated UI verification failed"
set -eu
[ -f /opt/auto-router-config.cjs ]
[ -f /opt/9router-auto-router/auto-router.cjs ]
[ -f /opt/9router-auto-router/apply-patch.mjs ]
UI_MARKER=9router-auto-router-ui:v9
runtime_files=$(grep -RFl "9router-auto-router:v3" /app/.next/server 2>/dev/null || true)
[ "$(printf "%s\n" "$runtime_files" | sed "/^$/d" | wc -l)" -eq 1 ]
runtime_file=$(printf "%s\n" "$runtime_files" | sed -n "/./{p;q;}")
[ "$(grep -o "routeAutoCombo" "$runtime_file" | wc -l)" -eq 2 ]
ui_files=$(grep -RFl "$UI_MARKER" /app/.next 2>/dev/null || true)
[ "$(printf "%s\n" "$ui_files" | sed "/^$/d" | wc -l)" -eq 2 ]
for file in $ui_files; do
  [ "$(grep -o "$UI_MARKER" "$file" | wc -l)" -eq 1 ]
  [ "$(grep -o "label:\"Auto Router\"" "$file" | wc -l)" -eq 1 ]
  [ "$(grep -o "autoRouter" "$file" | wc -l)" -ge 2 ]
  grep -q "Models after position 2 are ignored by Auto Router" "$file"
  grep -q "Advanced" "$file"
  ! grep -q "Easy target" "$file"
  ! grep -q "Hard target" "$file"
done
node /opt/9router-auto-router/apply-patch.mjs /app --check
SH
echo "Built image verification passed: ${IMAGE} revision=${revision} upstream=${upstream_digest}"
