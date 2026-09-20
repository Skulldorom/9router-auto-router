# Shared helpers for the container integration tests.
#
# The derived image runs 9Router as the image's non-root runtime user (its
# entrypoint chowns /app/data and then drops privileges). Tests must prepare a
# host bind mount that this exact user can read/write, and must confirm the app
# has finished initializing before issuing authenticated requests. These helpers
# resolve the runtime user from the image itself rather than assuming a UID.

# container_runtime_user IMAGE
# Prints "<uid>:<gid>" for the user the image actually runs as, by invoking the
# image's own entrypoint. Fails closed if the user cannot be determined.
container_runtime_user() {
  image=$1
  output=$(docker run --rm "$image" sh -c 'id -u; id -g' 2>/dev/null) || return 1
  uid=$(printf '%s\n' "$output" | sed -n '1p' | tr -d '[:space:]')
  gid=$(printf '%s\n' "$output" | sed -n '2p' | tr -d '[:space:]')
  case "$uid" in ''|*[!0-9]*) return 1 ;; esac
  case "$gid" in ''|*[!0-9]*) return 1 ;; esac
  printf '%s:%s\n' "$uid" "$gid"
}

# prepare_data_dir IMAGE DIR OWNER
# Makes DIR readable/writable by OWNER ("uid:gid") with restrictive 700
# permissions, using a root container so it also works for a non-root runner.
prepare_data_dir() {
  image=$1; dir=$2; owner=$3
  docker run --rm --user 0:0 --entrypoint sh -v "$dir:/target" "$image" \
    -c 'chown "$1" /target && chmod 700 /target' -- "$owner" >/dev/null
}

# purge_dir IMAGE DIR OWNER_UID OWNER_GID
# Best-effort removal of a directory whose contents may be owned by the container
# user, restoring ownership of the directory itself to the runner.
purge_dir() {
  image=$1; dir=$2; owner_uid=$3; owner_gid=$4
  [ -d "$dir" ] || return 0
  rmdir "$dir" 2>/dev/null && return 0
  docker run --rm --user 0:0 --entrypoint sh -v "$dir:/cleanup" "$image" \
    -c 'find /cleanup -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +; chown "$1:$2" /cleanup' -- "$owner_uid" "$owner_gid" >/dev/null 2>&1 || true
  rmdir "$dir"
}

# wait_for_login URL COOKIE_JAR PASSWORD ATTEMPTS
# Retries the real login until HTTP 200 or the attempt budget is exhausted.
# This proves 9Router has completed initialization and accepts authentication;
# arbitrary statuses such as 401/500 are not treated as readiness.
wait_for_login() {
  url=$1; jar=$2; password=$3; attempts=$4
  attempt=0
  while [ "$attempt" -lt "$attempts" ]; do
    response=$(curl --silent --show-error --max-time 10 --cookie "$jar" --cookie-jar "$jar" \
      -H 'Content-Type: application/json' --data "{\"password\":\"${password}\"}" \
      --write-out '\n%{http_code}' "$url" 2>&1) || true
    code=$(printf '%s\n' "$response" | tail -n1)
    [ "$code" = 200 ] && return 0
    attempt=$((attempt + 1))
    sleep 1
  done
  last_response=$response
  last_status=$code
  return 1
}

dump_container_logs() {
  printf 'Container %s logs:\n' "$1" >&2
  docker logs "$1" >&2 2>&1 || true
}
