#!/bin/sh
set -eu
IMAGE="${1:-9router-auto-router:http}"
SUFFIX=$$
NAME="9router-auto-router-http-${SUFFIX}"
NETWORK="9router-auto-router-http-net-${SUFFIX}"
MOCK_NAME="${NETWORK}-mock"
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$ROOT/scripts/lib-container-test.sh"
DATA_DIR=$(mktemp -d)
MOCK_DIR=$(mktemp -d)
WORK_DIR=$(mktemp -d)
# Keep the cookie jar off the bind mount: the image entrypoint chowns /app/data to
# its runtime user, which would otherwise make the runner-owned jar unwritable.
COOKIE_JAR="${WORK_DIR}/cookies.txt"
PASSWORD="auto-router-http-test-password"
OWNER_UID=$(id -u)
OWNER_GID=$(id -g)
RUNTIME_USER=$(container_runtime_user "$IMAGE")
cleanup() {
  status=$?
  trap - EXIT INT TERM
  docker rm -f "$NAME" "$MOCK_NAME" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR" 2>/dev/null || true
  purge_dir "$IMAGE" "$DATA_DIR" "$OWNER_UID" "$OWNER_GID" || { [ "$status" -ne 0 ] && exit "$status"; exit 1; }
  purge_dir "$IMAGE" "$MOCK_DIR" "$OWNER_UID" "$OWNER_GID" || { [ "$status" -ne 0 ] && exit "$status"; exit 1; }
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
# The bind mount must be writable by the image's actual runtime user, not a guessed UID.
prepare_data_dir "$IMAGE" "$DATA_DIR" "$RUNTIME_USER"
chmod 755 "$MOCK_DIR"

cat > "${MOCK_DIR}/server.cjs" <<'NODE'
const fs = require("fs"), http = require("http");
const journal = "/journal/requests.jsonl";
http.createServer((request, response) => {
  let body = "";
  request.on("data", (chunk) => body += chunk);
  request.on("end", () => {
    fs.appendFileSync(journal, JSON.stringify({ method: request.method, url: request.url, body }) + "\n");
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ model: "mock", message: { role: "assistant", content: "ok" }, done: true }));
  });
}).listen(8080);
NODE
chmod 644 "${MOCK_DIR}/server.cjs"

docker network create "$NETWORK" >/dev/null
docker run -d --name "$MOCK_NAME" --network "$NETWORK" -v "${MOCK_DIR}:/journal" -w /journal node:22-alpine node /journal/server.cjs >/dev/null
docker run -d --name "$NAME" --network "$NETWORK" -v "${DATA_DIR}:/app/data" -e NODE_ENV=production -e INITIAL_PASSWORD="$PASSWORD" -p 127.0.0.1::20128 "$IMAGE" >/dev/null
PORT=$(docker port "$NAME" 20128/tcp | sed 's/.*://')
if ! wait_for_login "http://127.0.0.1:${PORT}/api/auth/login" "$COOKIE_JAR" "$PASSWORD" 60; then
  dump_container_logs "$NAME"
  echo "Auto Router HTTP test failed: login did not succeed (last status ${last_status:-none})." >&2
  exit 1
fi
api() { curl --fail --silent --show-error --max-time 20 --cookie "$COOKIE_JAR" -H 'Content-Type: application/json' "$@"; }

api -X POST --data "{\"provider\":\"ollama-local\",\"name\":\"mock\",\"apiKey\":\"test\",\"providerSpecificData\":{\"baseUrl\":\"http://${MOCK_NAME}:8080\"}}" "http://127.0.0.1:${PORT}/api/providers" >/dev/null
for combo in easy hard agent fallback-combo auto-target; do api -X POST --data "{\"name\":\"${combo}\",\"models\":[\"ollama-local/${combo}-model\"]}" "http://127.0.0.1:${PORT}/api/combos" >/dev/null; done
API_KEY=$(api -X POST --data '{"name":"integration"}' "http://127.0.0.1:${PORT}/api/keys" | node -e 'let data="";process.stdin.on("data",chunk=>data+=chunk);process.stdin.on("end",()=>process.stdout.write(JSON.parse(data).key))')
set_auto() { api -X PATCH --data "{\"comboStrategies\":{\"agent\":{\"fallbackStrategy\":\"auto\",\"autoRouter\":${1}}}}" "http://127.0.0.1:${PORT}/api/settings" >/dev/null; }
complete() { curl --silent --show-error --max-time 20 -H 'Content-Type: application/json' -H "Authorization: Bearer ${API_KEY}" --data "$1" "http://127.0.0.1:${PORT}/api/v1/chat/completions"; }
journal() { cat "${MOCK_DIR}/requests.jsonl" 2>/dev/null || true; }
count_model() { journal | grep -c "$1" || true; }
expect_error() {
  response=$(complete "$1")
  printf '%s' "$response" | grep -q 'AUTO-ROUTER' || { echo "Expected a controlled Auto Router error for ${1}, got: ${response}" >&2; dump_container_logs "$NAME"; exit 1; }
  printf '%s' "$response" | grep -q "$2" || { echo "Expected '${2}' for ${1}, got: ${response}" >&2; dump_container_logs "$NAME"; exit 1; }
  return 0
}

set_auto '{"easyTarget":"easy","hardTarget":"hard"}'
EASY_REQUEST='{"model":"agent","messages":[{"role":"user","content":"rename this button sentinel-easy"}],"stream":false,"tools":[{"type":"function","function":{"name":"ping","parameters":{"type":"object"}}}]}'
HARD_REQUEST='{"model":"agent","messages":[{"role":"user","content":"fully audit this repository concurrency race condition sentinel-hard"}],"stream":true,"tools":[{"type":"function","function":{"name":"ping","parameters":{"type":"object"}}}]}'
easy_response=$(complete "$EASY_REQUEST")
hard_response=$(complete "$HARD_REQUEST")

printf '%s' "$easy_response" | grep -q '"content":"ok"' || { echo "Easy request did not reach the normal provider path: ${easy_response}" >&2; exit 1; }
printf '%s' "$hard_response" | grep -q 'data: ' || { echo "Hard streaming request did not reach the normal provider path: ${hard_response}" >&2; exit 1; }

[ "$(count_model easy-model)" -eq 1 ] || { echo "Expected exactly one easy-model provider call, saw $(count_model easy-model)." >&2; journal >&2; exit 1; }
[ "$(count_model hard-model)" -eq 1 ] || { echo "Expected exactly one hard-model provider call, saw $(count_model hard-model)." >&2; journal >&2; exit 1; }
[ "$(journal | grep -c '"url":"/api/chat"')" -eq 2 ] || { echo "Expected exactly two provider requests (no fan-out)." >&2; journal >&2; exit 1; }

easy_body=$(journal | grep -m1 'easy-model')
hard_body=$(journal | grep -m1 'hard-model')
printf '%s' "$easy_body" | grep -q 'sentinel-easy' || { echo "Easy delegation lost the request body: ${easy_body}" >&2; exit 1; }
printf '%s' "$easy_body" | grep -q 'tools.*ping' || { echo "Easy delegation lost tools: ${easy_body}" >&2; exit 1; }
printf '%s' "$easy_body" | grep -q 'stream.*false' || { echo "Easy delegation changed stream: ${easy_body}" >&2; exit 1; }
printf '%s' "$hard_body" | grep -q 'sentinel-hard' || { echo "Hard delegation lost the request body: ${hard_body}" >&2; exit 1; }
printf '%s' "$hard_body" | grep -q 'tools.*ping' || { echo "Hard delegation lost tools: ${hard_body}" >&2; exit 1; }
printf '%s' "$hard_body" | grep -q 'stream.*true' || { echo "Hard delegation changed stream: ${hard_body}" >&2; exit 1; }

logs=$(docker logs "$NAME" 2>&1)
printf '%s' "$logs" | grep -q 'AUTO-ROUTER] agent → easy' || { printf '%s\n' "$logs" >&2; exit 1; }
printf '%s' "$logs" | grep -q 'AUTO-ROUTER] agent → hard' || { printf '%s\n' "$logs" >&2; exit 1; }
printf '%s' "$logs" | grep -q 'Combo "easy" with 1 models' || { printf '%s\n' "$logs" >&2; exit 1; }
printf '%s' "$logs" | grep -q 'Combo "hard" with 1 models' || { printf '%s\n' "$logs" >&2; exit 1; }
printf '%s' "$logs" | grep -q '\[COMBO\] Trying model 1/1: ollama-local/easy-model' || { printf '%s\n' "$logs" >&2; exit 1; }
printf '%s' "$logs" | grep -q '\[COMBO\] Trying model 1/1: ollama-local/hard-model' || { printf '%s\n' "$logs" >&2; exit 1; }

set_auto '{"easyTarget":"ghost-easy","hardTarget":"hard"}'
expect_error '{"model":"agent","messages":[{"role":"user","content":"rename this button"}]}' 'Easy target .*ghost-easy.* does not exist'
set_auto '{"easyTarget":"easy","hardTarget":"ghost-hard"}'
expect_error '{"model":"agent","messages":[{"role":"user","content":"fully audit this repository concurrency race condition"}]}' 'Hard target .*ghost-hard.* does not exist'
set_auto '{"easyTarget":"agent","hardTarget":"hard"}'
expect_error '{"model":"agent","messages":[{"role":"user","content":"rename this button"}]}' 'is the Auto Router combo itself'

# Auto Router → Auto Router chaining is explicitly unsupported: even a stale-free
# target configured with fallbackStrategy "auto" must fail closed.
api -X PATCH --data '{"comboStrategies":{"agent":{"fallbackStrategy":"auto","autoRouter":{"easyTarget":"auto-target","hardTarget":"hard"}},"auto-target":{"fallbackStrategy":"auto","autoRouter":{"easyTarget":"easy","hardTarget":"hard"}}}}' "http://127.0.0.1:${PORT}/api/settings" >/dev/null
expect_error '{"model":"agent","messages":[{"role":"user","content":"rename this button"}]}' 'chaining is not supported'

api -X PATCH --data '{"comboStrategies":{"agent":{"fallbackStrategy":"auto","autoRouter":{"easyTarget":"fallback-combo","hardTarget":"hard"}},"fallback-combo":{"fallbackStrategy":"fallback"}}}' "http://127.0.0.1:${PORT}/api/settings" >/dev/null
fallback_response=$(complete '{"model":"agent","messages":[{"role":"user","content":"rename this button sentinel-fallback"}]}')
printf '%s' "$fallback_response" | grep -q 'mock' || { echo "Ordinary fallback target failed: ${fallback_response}" >&2; exit 1; }
[ "$(count_model fallback-combo-model)" -eq 1 ] || { echo "Ordinary fallback target was not executed normally." >&2; exit 1; }

echo "Auto Router HTTP integration test passed: patched HTTP path selects exactly one target, preserves body/stream/tools, delegates into normal 9Router combo handling, and fails closed on self/auto/stale targets."
