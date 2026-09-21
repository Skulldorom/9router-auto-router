#!/bin/sh
set -eu
IMAGE=${1:-9router-auto-router:rollback}
UPSTREAM_IMAGE=${UPSTREAM_IMAGE:?UPSTREAM_IMAGE must be immutable}
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$ROOT/scripts/lib-container-test.sh"
SUFFIX=$$
NAME="9router-auto-router-rollback-$SUFFIX"
NETWORK="9router-auto-router-rollback-net-$SUFFIX"
MOCK_NAME="$NETWORK-mock"
DATA_DIR=$(mktemp -d)
MOCK_DIR=$(mktemp -d)
WORK_DIR=$(mktemp -d)
COOKIE_JAR="$WORK_DIR/cookies.txt"
PASSWORD=rollback-compatibility-password
OWNER_UID=$(id -u); OWNER_GID=$(id -g)
cleanup() { status=$?; trap - EXIT INT TERM; docker rm -f "$NAME" "$MOCK_NAME" >/dev/null 2>&1 || true; docker network rm "$NETWORK" >/dev/null 2>&1 || true; rm -rf "$WORK_DIR"; purge_dir "$IMAGE" "$DATA_DIR" "$OWNER_UID" "$OWNER_GID" || true; purge_dir "$IMAGE" "$MOCK_DIR" "$OWNER_UID" "$OWNER_GID" || true; exit "$status"; }
trap cleanup EXIT; trap 'exit 130' INT; trap 'exit 143' TERM
prepare_data_dir "$IMAGE" "$DATA_DIR" "$(container_runtime_user "$IMAGE")"
printf '%s\n' 'const http=require("http");http.createServer((q,s)=>{q.resume();q.on("end",()=>s.end(JSON.stringify({message:{content:"ok"}})))}).listen(8080);' > "$MOCK_DIR/server.cjs"
chmod 644 "$MOCK_DIR/server.cjs"
docker network create "$NETWORK" >/dev/null
docker run -d --name "$MOCK_NAME" --network "$NETWORK" -v "$MOCK_DIR:/journal" -w /journal node:22-alpine node server.cjs >/dev/null
start() { image=$1; rm -f "$COOKIE_JAR"; docker run -d --name "$NAME" --network "$NETWORK" -v "$DATA_DIR:/app/data" -e NODE_ENV=production -e INITIAL_PASSWORD="$PASSWORD" -p 127.0.0.1::20128 "$image" >/dev/null; PORT=$(docker port "$NAME" 20128/tcp | sed 's/.*://'); wait_for_login "http://127.0.0.1:$PORT/api/auth/login" "$COOKIE_JAR" "$PASSWORD" 60 || { dump_container_logs "$NAME"; exit 1; }; }
stop() { docker rm -f "$NAME" >/dev/null; }
api() { curl --fail --silent --show-error --cookie "$COOKIE_JAR" -H 'Content-Type: application/json' "$@"; }
settings() { api "http://127.0.0.1:$PORT/api/settings"; }
combos() { api "http://127.0.0.1:$PORT/api/combos"; }
assert_data() { settings | grep -q 'unrelatedRollbackSetting'; combos | grep -q 'coder-high'; combos | grep -q 'coder-auto'; combos | grep -q 'coder-model'; }

start "$UPSTREAM_IMAGE"
api -X POST --data '{"provider":"ollama-local","name":"mock","apiKey":"test","providerSpecificData":{"baseUrl":"http://'"$MOCK_NAME"':8080"}}' "http://127.0.0.1:$PORT/api/providers" >/dev/null
for combo in coder coder-high coder-auto; do api -X POST --data '{"name":"'"$combo"'","models":["ollama-local/'"$combo"'-model"]}' "http://127.0.0.1:$PORT/api/combos" >/dev/null; done
api -X PATCH --data '{"unrelatedRollbackSetting":"preserve-me"}' "http://127.0.0.1:$PORT/api/settings" >/dev/null
assert_data; stop

start "$IMAGE"
api -X PATCH --data '{"comboStrategies":{"coder-auto":{"fallbackStrategy":"auto","autoRouter":{"easyTarget":"coder","hardTarget":"coder-high"}}},"unrelatedRollbackSetting":"preserve-me"}' "http://127.0.0.1:$PORT/api/settings" >/dev/null
settings | grep -q 'fallbackStrategy":"auto'; assert_data
KEY=$(api -X POST --data '{"name":"rollback"}' "http://127.0.0.1:$PORT/api/keys" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).key))')
curl --fail --silent -H 'Content-Type: application/json' -H "Authorization: Bearer $KEY" --data '{"model":"coder-auto","messages":[{"role":"user","content":"rename this"}]}' "http://127.0.0.1:$PORT/api/v1/chat/completions" | grep -q 'ok'
stop

start "$UPSTREAM_IMAGE"
assert_data
curl --fail --silent --location -H 'Cache-Control: no-cache' "http://127.0.0.1:$PORT/dashboard/combos" | grep -q '<html'
stock_auto_response=$(curl --silent -H 'Content-Type: application/json' -H "Authorization: Bearer $KEY" --data '{"model":"coder-auto","messages":[{"role":"user","content":"stock auto behavior"}]}' "http://127.0.0.1:$PORT/api/v1/chat/completions")
printf '%s' "$stock_auto_response" | grep -q 'ok' || { echo "Expected observed stock fallbackStrategy:auto delegation response, got: $stock_auto_response" >&2; exit 1; }
api -X PATCH --data '{"comboStrategies":{"coder-auto":{"fallbackStrategy":"fallback"}},"unrelatedRollbackSetting":"preserve-me"}' "http://127.0.0.1:$PORT/api/settings" >/dev/null
settings | grep -q 'fallbackStrategy":"fallback'; combos | grep -q 'coder-auto-model'; assert_data; stop

start "$IMAGE"; assert_data
api -X PATCH --data '{"comboStrategies":{"coder-auto":{"fallbackStrategy":"auto","autoRouter":{"easyTarget":"coder","hardTarget":"coder-high"}}},"unrelatedRollbackSetting":"preserve-me"}' "http://127.0.0.1:$PORT/api/settings" >/dev/null
settings | grep -q 'fallbackStrategy":"auto'; curl --fail --silent --location -H 'Cache-Control: no-cache' "http://127.0.0.1:$PORT/dashboard/combos" | grep -q '<html'
echo "Rollback compatibility test passed: stock → Auto Router → stock → Auto Router used one /app/data volume; stock delegates persisted fallbackStrategy:auto to the combo model, and recovery to fallback preserves combo models and unrelated settings."
