#!/bin/sh
set -eu

revision=${1:?source revision is required}
upstream_digest=${2:?upstream digest is required}

printf '%s' "$revision" | grep -Eq '^[0-9a-f]{40}$' || {
  echo "Source revision must be a full lowercase SHA-1." >&2
  exit 1
}
printf '%s' "$upstream_digest" | grep -Eq '^sha256:[0-9a-f]{64}$' || {
  echo "Upstream digest must be a lowercase sha256 digest." >&2
  exit 1
}

printf 'sha-%s-upstream-%s\n' "$revision" "${upstream_digest#sha256:}"
