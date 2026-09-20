#!/bin/sh
set -eu
IMAGE="${UPSTREAM_IMAGE:-decolua/9router:latest}"
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
if ! command -v docker >/dev/null 2>&1; then echo "9Router Auto Router compatibility check failed. Docker is required." >&2; exit 1; fi
docker image inspect "$IMAGE" >/dev/null 2>&1 || docker pull "$IMAGE" >/dev/null
container=$(docker create "$IMAGE")
cleanup() { docker rm -f "$container" >/dev/null 2>&1 || true; rm -rf "$workdir"; }
workdir=$(mktemp -d)
trap cleanup EXIT INT TERM
docker cp "$container:/app/.next" "$workdir/.next"
UPSTREAM_IMAGE="$IMAGE" node "$ROOT/patches/apply-patch.mjs" "$workdir" --check
echo "9Router Auto Router compatibility check passed: $IMAGE"
