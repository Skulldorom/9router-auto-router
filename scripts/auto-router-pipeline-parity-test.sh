#!/bin/sh
set -eu

IMAGE="${1:-9router-auto-router:parity}"
SUFFIX=$$
NAME="9router-auto-router-parity-${SUFFIX}"
NETWORK="9router-auto-router-parity-net-${SUFFIX}"
MOCK_NAME="${NETWORK}-mock"
HEADROOM_NAME="${NETWORK}-headroom"
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
. "$ROOT/scripts/lib-container-test.sh"
DATA_DIR=$(mktemp -d)
MOCK_DIR=$(mktemp -d)
HEADROOM_DIR=$(mktemp -d)
WORK_DIR=$(mktemp -d)
COOKIE_JAR="${WORK_DIR}/cookies.txt"
PASSWORD="auto-router-pipeline-parity-password"
OWNER_UID=$(id -u)
OWNER_GID=$(id -g)
RUNTIME_USER=$(container_runtime_user "$IMAGE")

cleanup() {
  status=$?
  trap - EXIT INT TERM
  docker rm -f "$NAME" "$MOCK_NAME" "$HEADROOM_NAME" >/dev/null 2>&1 || true
  docker network rm "$NETWORK" >/dev/null 2>&1 || true
  rm -rf "$WORK_DIR" 2>/dev/null || true
  purge_dir "$IMAGE" "$DATA_DIR" "$OWNER_UID" "$OWNER_GID" || { [ "$status" -ne 0 ] && exit "$status"; exit 1; }
  purge_dir "$IMAGE" "$MOCK_DIR" "$OWNER_UID" "$OWNER_GID" || { [ "$status" -ne 0 ] && exit "$status"; exit 1; }
  purge_dir "$IMAGE" "$HEADROOM_DIR" "$OWNER_UID" "$OWNER_GID" || { [ "$status" -ne 0 ] && exit "$status"; exit 1; }
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

prepare_data_dir "$IMAGE" "$DATA_DIR" "$RUNTIME_USER"
chmod 755 "$MOCK_DIR" "$HEADROOM_DIR"

cat > "${MOCK_DIR}/server.cjs" <<'NODE'
const fs = require("fs");
const http = require("http");

http.createServer((request, response) => {
  let raw = "";
  request.on("data", (chunk) => raw += chunk);
  request.on("end", () => {
    const body = JSON.parse(raw);
    fs.appendFileSync("/journal/provider.jsonl", `${JSON.stringify({ url: request.url, body })}\n`);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ model: "mock", message: { role: "assistant", content: "ok" }, done: true }));
  });
}).listen(8080);
NODE

cat > "${HEADROOM_DIR}/server.cjs" <<'NODE'
const fs = require("fs");
const http = require("http");

http.createServer((request, response) => {
  let raw = "";
  request.on("data", (chunk) => raw += chunk);
  request.on("end", () => {
    const requestBody = JSON.parse(raw);
    const responseBody = { messages: requestBody.messages, tokens_before: 1000, tokens_after: 900, tokens_saved: 100 };
    fs.appendFileSync("/journal/headroom.jsonl", `${JSON.stringify({ request: requestBody, response: responseBody })}\n`);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(responseBody));
  });
}).listen(8787);
NODE
chmod 644 "${MOCK_DIR}/server.cjs" "${HEADROOM_DIR}/server.cjs"

docker network create "$NETWORK" >/dev/null
docker run -d --name "$MOCK_NAME" --network "$NETWORK" -v "${MOCK_DIR}:/journal" -w /journal node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85 node /journal/server.cjs >/dev/null
docker run -d --name "$HEADROOM_NAME" --network "$NETWORK" -v "${HEADROOM_DIR}:/journal" -w /journal node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85 node /journal/server.cjs >/dev/null
docker run -d --name "$NAME" --network "$NETWORK" -v "${DATA_DIR}:/app/data" -e NODE_ENV=production -e INITIAL_PASSWORD="$PASSWORD" -e "HEADROOM_URL=http://${HEADROOM_NAME}:8787" -p 127.0.0.1::20128 "$IMAGE" >/dev/null
PORT=$(docker port "$NAME" 20128/tcp | sed 's/.*://')
if ! wait_for_login "http://127.0.0.1:${PORT}/api/auth/login" "$COOKIE_JAR" "$PASSWORD" 60; then
  dump_container_logs "$NAME"
  echo "Auto Router pipeline parity test failed: login did not succeed (last status ${last_status:-none})." >&2
  exit 1
fi
api() { curl --fail --silent --show-error --max-time 30 --cookie "$COOKIE_JAR" -H 'Content-Type: application/json' "$@"; }
complete() { curl --fail --silent --show-error --max-time 30 -H 'Content-Type: application/json' -H "Authorization: Bearer ${API_KEY}" --data "@$1" "http://127.0.0.1:${PORT}/api/v1/chat/completions"; }

api -X POST --data "{\"provider\":\"ollama-local\",\"name\":\"mock\",\"apiKey\":\"test\",\"providerSpecificData\":{\"baseUrl\":\"http://${MOCK_NAME}:8080\"}}" "http://127.0.0.1:${PORT}/api/providers" >/dev/null
for combo in coder-high coder-auto; do
  if [ "$combo" = coder-high ]; then models='["ollama-local/coder-high-first","ollama-local/coder-high-final"]'; else models='["ollama-local/coder-auto-placeholder"]'; fi
  api -X POST --data "{\"name\":\"${combo}\",\"models\":${models}}" "http://127.0.0.1:${PORT}/api/combos" >/dev/null
done
api -X PATCH --data '{"rtkEnabled":true,"headroomEnabled":true,"headroomTimeoutMs":3000,"comboStrategies":{"coder-auto":{"fallbackStrategy":"auto","autoRouter":{"easyTarget":"coder-high","hardTarget":"coder-high"}},"coder-high":{"fallbackStrategy":"fallback"}}}' "http://127.0.0.1:${PORT}/api/settings" >/dev/null
API_KEY=$(api -X POST --data '{"name":"pipeline-parity"}' "http://127.0.0.1:${PORT}/api/keys" | node -e 'let data="";process.stdin.on("data",chunk=>data+=chunk);process.stdin.on("end",()=>process.stdout.write(JSON.parse(data).key))')

node - <<'NODE' > "${WORK_DIR}/payload-base.json"
const tools = Array.from({ length: 83 }, (_, index) => ({
  type: "function",
  function: {
    name: `openhands_tool_${index}`,
    description: `Tool schema ${"x".repeat(900)}`,
    parameters: { type: "object", properties: { value: { type: "string", description: `Value ${"y".repeat(300)}` } } },
  },
}));
const messages = [{ role: "system", content: `OpenHands system context ${"s".repeat(3000)}` }];
for (let index = 0; index < 20; index += 1) {
  messages.push(
    { role: "user", content: `Historical request ${index} ${"u".repeat(3000)}` },
    { role: "assistant", content: "", tool_calls: [{ id: `call_${index}`, type: "function", function: { name: "openhands_tool_1", arguments: "{\"value\":\"x\"}" } }] },
    { role: "tool", tool_call_id: `call_${index}`, content: `Tool result ${index}\n${"duplicate tool output\n".repeat(1200)}` },
  );
}
messages.push({ role: "user", content: `Fully audit this repository concurrency race condition ${"z".repeat(2000)}` });
process.stdout.write(JSON.stringify({ messages, tools, stream: true, temperature: 0.2, metadata: { sentinel: "same-openhands-payload" } }));
NODE
node -e 'const body=require(process.argv[1]); body.model=process.argv[2]; process.stdout.write(JSON.stringify(body));' "${WORK_DIR}/payload-base.json" coder-high > "${WORK_DIR}/direct.json"
node -e 'const body=require(process.argv[1]); body.model=process.argv[2]; process.stdout.write(JSON.stringify(body));' "${WORK_DIR}/payload-base.json" coder-auto > "${WORK_DIR}/auto.json"

complete "${WORK_DIR}/direct.json" | grep -q 'ok'
complete "${WORK_DIR}/auto.json" | grep -q 'ok'
node - "${WORK_DIR}/payload-base.json" "${MOCK_DIR}/provider.jsonl" "${HEADROOM_DIR}/headroom.jsonl" <<'NODE'
const assert = require("node:assert/strict");
const fs = require("node:fs");

const [basePath, providerPath, headroomPath] = process.argv.slice(2);
const base = JSON.parse(fs.readFileSync(basePath, "utf8"));
const readJournal = (file) => fs.readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
const providers = readJournal(providerPath).map((entry) => entry.body);
const headroom = readJournal(headroomPath);
const collection = (body) => body.messages || body.input || body.contents || [];
const summary = (body) => {
  const messages = collection(body);
  const toolHistory = messages.filter((message) => message.role === "tool" || message.type === "function_call_output");
  return {
    bodyBytes: Buffer.byteLength(JSON.stringify(body)),
    messages: messages.length,
    tools: (body.tools || body.functions || []).length,
    messageBytes: Buffer.byteLength(JSON.stringify(messages)),
    toolHistoryBytes: Buffer.byteLength(JSON.stringify(toolHistory)),
    stream: body.stream,
  };
};

assert.equal(base.messages.length, 62);
assert.equal(base.tools.length, 83);
assert.equal(base.stream, true);
assert.ok(providers.length >= 2 && providers.length % 2 === 0, "direct and Auto requests must make the same nonzero number of provider attempts");
assert.equal(headroom.length, providers.length, "Headroom must run once for every equivalent provider attempt");
const attempts = providers.length / 2;
for (let index = 0; index < attempts; index += 1) {
  assert.deepEqual(providers[index + attempts], providers[index], `provider request ${index} diverged after Auto Router selected coder-high`);
  assert.deepEqual(headroom[index + attempts].request, headroom[index].request, `Headroom input ${index} diverged after Auto Router selected coder-high`);
  assert.deepEqual(headroom[index + attempts].response, headroom[index].response, `Headroom output ${index} diverged after Auto Router selected coder-high`);
  assert.equal(headroom[index].request.model, providers[index].model);
  assert.equal(headroom[index].request.messages.length, 62);
  assert.equal(providers[index].stream, true);
  assert.equal(providers[index].tools.length, 83);
}
assert.deepEqual(providers.slice(attempts).map(summary), providers.slice(0, attempts).map(summary));
assert.equal(attempts, 1, "each path must reach exactly one selected provider without fan-out");
assert.equal(providers[0].model, "coder-high-first");
assert.match(JSON.stringify(providers[0]), /\.\.\. \(1199 duplicate lines\)/, "RTK did not preprocess the tool history");
process.stdout.write(`pipeline parity snapshots: direct=${JSON.stringify(providers.slice(0, attempts).map(summary))} auto=${JSON.stringify(providers.slice(attempts).map(summary))}\n`);
NODE

logs=$(docker logs "$NAME" 2>&1)
printf '%s' "$logs" | grep -q 'AUTO-ROUTER] combo=coder-auto level=hard target=coder-high' || { printf '%s\n' "$logs" >&2; exit 1; }
[ "$(printf '%s' "$logs" | grep -c 'Combo "coder-high" with 2 models (strategy: fallback, sticky:')" -eq 2 ] || { printf '%s\n' "$logs" >&2; exit 1; }
[ "$(printf '%s' "$logs" | grep -c 'FMT: openai→ollama')" -eq 2 ] || { printf '%s\n' "$logs" >&2; exit 1; }
[ "$(printf '%s' "$logs" | grep -c '\[HEADROOM\] reported token delta=100 before=1000 after=900')" -eq 2 ] || { printf '%s\n' "$logs" >&2; exit 1; }
[ "$(printf '%s' "$logs" | grep -c 'RTK:20')" -eq 2 ] || { printf '%s\n' "$logs" >&2; exit 1; }
printf '%s' "$logs" | grep -q 'POST coder-high → ollama-local/coder-high-first' || { printf '%s\n' "$logs" >&2; exit 1; }
printf '%s' "$logs" | grep -q 'POST ollama-local/coder-high-first → ollama-local/coder-high-first' || { printf '%s\n' "$logs" >&2; exit 1; }

echo "Auto Router pipeline parity test passed: identical OpenHands-style direct and Auto requests reached coder-high's same fallback, sticky, format conversion, RTK, Headroom, and provider boundaries with byte-identical captured inputs and outputs. The different POST left-hand labels are request logging identity only; target combo handling and outbound provider bodies were identical."