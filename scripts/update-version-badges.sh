#!/bin/sh
# Writes the repository-hosted known-good version badge state that README reads.
#
# This runs only after the known-good image has been published and attested, and it
# is deliberately monotonic so that a stale or retried run can never roll state back:
# the Auto Router version only ever advances, and the upstream version is only
# accepted as a real SemVer value. A failed validation or attestation never reaches
# this script, so a badge cannot advance for an image that was not fully published.
#
# The files use the shields.io endpoint schema, so the README renders them without
# ever querying decolua/9router:latest directly. The 9Router badge therefore cannot
# report an upstream version that has not passed this repository's validation.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
out_dir=${BADGE_STATE_DIR:-"$root/.github/badges"}
auto_router_version=${1:?Auto Router version required}
upstream_version=${2:?upstream version required}
revision=${3:?source revision required}

printf '%s' "$auto_router_version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || {
  echo "Invalid Auto Router version: $auto_router_version" >&2
  exit 1
}
printf '%s' "$upstream_version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+$' || {
  echo "Refusing to record non-SemVer known-good upstream version: $upstream_version" >&2
  exit 1
}
printf '%s' "$revision" | grep -Eq '^[0-9a-f]{40}$' || {
  echo "Invalid source revision: $revision" >&2
  exit 1
}

mkdir -p "$out_dir"

badge_version() {
  sed -n 's/^[[:space:]]*"message":[[:space:]]*"v\([0-9][0-9.]*\)".*/\1/p' "$1" 2>/dev/null | head -n1
}

write_badge() {
  file=$1
  label=$2
  message=$3
  color=$4
  shift 4
  {
    printf '{\n'
    printf '  "schemaVersion": 1,\n'
    printf '  "label": "%s",\n' "$label"
    printf '  "message": "%s",\n' "$message"
    printf '  "color": "%s"' "$color"
    for extra in "$@"; do
      printf ',\n  %s' "$extra"
    done
    printf '\n}\n'
  } > "$file"
}

# Compare dotted SemVer numerically; echoes "newer", "same", or "older".
compare_versions() {
  new_parts=$(printf '%s' "$1" | awk -F. '{printf "%d %d %d", $1, $2, $3}')
  old_parts=$(printf '%s' "$2" | awk -F. '{printf "%d %d %d", $1, $2, $3}')
  set -- $new_parts
  new_major=$1 new_minor=$2 new_patch=$3
  set -- $old_parts
  old_major=$1 old_minor=$2 old_patch=$3
  if [ "$new_major" -gt "$old_major" ] \
    || { [ "$new_major" -eq "$old_major" ] && [ "$new_minor" -gt "$old_minor" ]; } \
    || { [ "$new_major" -eq "$old_major" ] && [ "$new_minor" -eq "$old_minor" ] && [ "$new_patch" -gt "$old_patch" ]; }; then
    printf newer
  elif [ "$new_major" -eq "$old_major" ] && [ "$new_minor" -eq "$old_minor" ] && [ "$new_patch" -eq "$old_patch" ]; then
    printf same
  else
    printf older
  fi
}

verdict_for() {
  # $1 candidate version, $2 existing badge file; echoes newer/same/older.
  existing=$(badge_version "$2")
  if [ -n "$existing" ]; then
    compare_versions "$1" "$existing"
  else
    printf newer
  fi
}

auto_router_verdict=$(verdict_for "$auto_router_version" "$out_dir/auto-router.json")
case "$auto_router_verdict" in
  older)
    echo "Auto Router badge is newer than ${auto_router_version}; leaving it unchanged." >&2
    ;;
  same)
    ;;
  newer)
    write_badge "$out_dir/auto-router.json" "Auto Router" "v${auto_router_version}" "blue"
    ;;
esac

# The upstream badge is monotonic too: a stale run must never roll the
# known-good 9Router version backwards.
upstream_verdict=$(verdict_for "$upstream_version" "$out_dir/9router.json")
case "$upstream_verdict" in
  older)
    echo "9Router badge is newer than ${upstream_version}; leaving it unchanged." >&2
    ;;
  same|newer)
    write_badge "$out_dir/9router.json" "9Router" "v${upstream_version}" "green" \
      "\"revision\": \"${revision}\""
    ;;
esac
echo "Badge state updated: auto-router=${auto_router_version} 9router=${upstream_version} revision=${revision}"
