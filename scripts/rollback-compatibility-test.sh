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
PLAYWRIGHT_IMAGE=${PLAYWRIGHT_IMAGE:-mcr.microsoft.com/playwright:v1.58.2-noble@sha256:6446946a1d9fd62d9ae501312a2d76a43ee688542b21622056a372959b65d63d}
NODE_IMAGE=${NODE_IMAGE:-node:22-alpine@sha256:b6f26b36c8ff49624cfdac716b8ea1138d606df02586a77d364bb5536a634f85}
OWNER_UID=$(id -u); OWNER_GID=$(id -g)
cleanup() { status=$?; trap - EXIT INT TERM; docker rm -f "$NAME" "$MOCK_NAME" >/dev/null 2>&1 || true; docker network rm "$NETWORK" >/dev/null 2>&1 || true; rm -rf "$WORK_DIR"; purge_dir "$IMAGE" "$DATA_DIR" "$OWNER_UID" "$OWNER_GID" || true; purge_dir "$IMAGE" "$MOCK_DIR" "$OWNER_UID" "$OWNER_GID" || true; exit "$status"; }
trap cleanup EXIT; trap 'exit 130' INT; trap 'exit 143' TERM
prepare_data_dir "$IMAGE" "$DATA_DIR" "$(container_runtime_user "$IMAGE")"
printf '%s\n' 'const http=require("http");http.createServer((q,s)=>{q.resume();q.on("end",()=>s.end(JSON.stringify({message:{content:"ok"}})))}).listen(8080);' > "$MOCK_DIR/server.cjs"
chmod 644 "$MOCK_DIR/server.cjs"
docker network create "$NETWORK" >/dev/null
docker run -d --name "$MOCK_NAME" --network "$NETWORK" -v "$MOCK_DIR:/journal" -w /journal "$NODE_IMAGE" node server.cjs >/dev/null
start() { image=$1; rm -f "$COOKIE_JAR"; docker run -d --name "$NAME" --network "$NETWORK" --network-alias router -v "$DATA_DIR:/app/data" -e NODE_ENV=production -e INITIAL_PASSWORD="$PASSWORD" -p 127.0.0.1::20128 "$image" >/dev/null; PORT=$(docker port "$NAME" 20128/tcp | sed 's/.*://'); wait_for_login "http://127.0.0.1:$PORT/api/auth/login" "$COOKIE_JAR" "$PASSWORD" 60 || { dump_container_logs "$NAME"; exit 1; }; }
stop() { docker rm -f "$NAME" >/dev/null; }
api() { curl --fail --silent --show-error --cookie "$COOKIE_JAR" -H 'Content-Type: application/json' "$@"; }
settings() { api "http://127.0.0.1:$PORT/api/settings"; }
combos() { api "http://127.0.0.1:$PORT/api/combos"; }
assert_data() { settings | grep -q 'unrelatedRollbackSetting'; combos | grep -q 'coder-high'; combos | grep -q 'coder-auto'; combos | grep -q 'coder-model'; }
browser_combos() {
  phase=$1; configure=${2:-false}
  if browser_output=$(docker run --rm -i --network "$NETWORK" -e BASE_URL="http://router:20128" -e PASSWORD="$PASSWORD" -e PHASE="$phase" -e CONFIGURE="$configure" "$PLAYWRIGHT_IMAGE" sh -c 'mkdir -p /tmp/auto-router-playwright && cd /tmp/auto-router-playwright && { [ -d node_modules/playwright ] || { npm init -y >/dev/null && PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install --no-save playwright@1.58.2 >/dev/null; }; } && exec node -' <<'NODE'
const { chromium } = require("/tmp/auto-router-playwright/node_modules/playwright");
const phase = process.env.PHASE;
(async () => {
  console.log(`AUTO_ROUTER_BROWSER_TEST_START:${phase}`);
  const errors = [], diagnostics = [];
  const relevant = url => url.includes("/login") || url.includes("/dashboard/combos") || url.includes("/_next/") || url.includes("/api/");
  const record = message => diagnostics.push(message);
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.on("console", message => {
    if (["error", "warning"].includes(message.type())) record(`console ${message.type()}: ${message.text()}`);
  });
  page.on("pageerror", error => { const message = error.stack || error.message; errors.push(message); record(`pageerror: ${message}`); });
  page.on("requestfailed", request => {
    if (relevant(request.url())) record(`requestfailed ${request.method()} ${request.url()}: ${request.failure()?.errorText || "unknown"}`);
  });
  page.on("response", response => {
    const request = response.request();
    if (relevant(response.url()) && (request.isNavigationRequest() || response.status() >= 300)) record(`response ${response.status()} ${response.statusText()} ${request.method()} ${response.url()}`);
  });
  const describe = async label => {
    const cookies = (await context.cookies(process.env.BASE_URL)).map(({ name, domain, path, secure, httpOnly, sameSite, expires }) => ({ name, domain, path, secure, httpOnly, sameSite, expires }));
    console.error(`AUTO_ROUTER_BROWSER_DIAGNOSTIC:${phase}:${label} base=${process.env.BASE_URL} url=${page.url()} cookies=${JSON.stringify(cookies)} events=${JSON.stringify(diagnostics)}`);
  };
  const assertNoErrors = () => {
    if (errors.length) throw new Error(`${phase} Combos page errors:\\n${errors.join("\\n")}`);
  };
  let login;
  try {
    login = await page.request.post(`${process.env.BASE_URL}/api/auth/login`, { data: { password: process.env.PASSWORD } });
  } catch (error) {
    throw new Error(`cannot reach ${process.env.BASE_URL}: ${error.message}`);
  }
  if (!login.ok()) throw new Error(`login failed at ${process.env.BASE_URL}: ${login.status()}`);
  const authCookie = login.headers()["set-cookie"]?.match(/auth_token=([^;]+)/)?.[1];
  if (!authCookie) throw new Error(`login at ${process.env.BASE_URL} returned no auth_token cookie`);
  await context.addCookies([{ name: "auth_token", value: authCookie, url: process.env.BASE_URL }]);
  await describe("after-auth-cookie");
  let navigation;
  try {
    navigation = await page.goto(`${process.env.BASE_URL}/dashboard/combos`, { waitUntil: "networkidle" });
  } catch (error) {
    await describe("goto-threw");
    throw error;
  }
  record(`goto ${navigation?.status() || "no-response"} ${navigation?.statusText() || ""} final=${page.url()}`);
  await describe("after-goto");
  for (const combo of ["coder", "coder-high", "coder-auto"]) {
    const card = page.getByText(combo, { exact: true }).first();
    try {
      await card.waitFor({ timeout: 10_000 });
    } catch {
      await describe(`missing-${combo}`);
      throw new Error(`${phase} missing visible ${combo} combo card at ${page.url()}: ${(await page.locator("body").innerText()).slice(0, 500)}`);
    }
    if (!await card.isVisible()) throw new Error(`${phase} missing visible ${combo} combo card`);
  }
  assertNoErrors();
  if (process.env.CONFIGURE === "true") {
    let settingsPatches = 0;
    page.on("request", request => {
      if (request.url().includes("/api/settings") && request.method() === "PATCH") settingsPatches += 1;
    });
    const settingsPatch = () => page.waitForResponse(response => response.url().includes("/api/settings") && response.request().method() === "PATCH" && response.ok());
    const autoCard = () => page.getByText("coder-auto", { exact: true }).first().locator("xpath=ancestor::*[.//button[@title=\"Edit\"]][1]");
    const comboResponse = await page.request.get(`${process.env.BASE_URL}/api/combos`);
    const autoCombo = (await comboResponse.json()).combos.find(combo => combo.name === "coder-auto");
    if (!autoCombo) throw new Error(`${phase} could not find coder-auto through the combos API`);
    // Preserve this explicit order; legacy targets remain active only until Save.
    let response = await page.request.put(`${process.env.BASE_URL}/api/combos/${autoCombo.id}`, { data: { ...autoCombo, models: ["coder-high", "coder", "coder-auto-model"] } });
    if (!response.ok()) throw new Error(`${phase} could not seed ordered model migration coverage`);
    response = await page.request.patch(`${process.env.BASE_URL}/api/settings`, { data: { comboStrategies: { "coder-auto": { fallbackStrategy: "auto", autoRouter: { easyTarget: "coder", hardTarget: "coder-high", hardThreshold: 7 } } } } });
    if (!response.ok()) throw new Error(`${phase} could not seed legacy Auto Router settings`);
    await page.reload({ waitUntil: "networkidle" });

    const card = autoCard();
    const strategy = card.locator("select");
    if (await strategy.count() !== 1) throw new Error(`${phase} combo card did not expose one strategy selector`);
    for (const value of ["fallback", "round-robin", "fusion", "auto"]) {
      if (await strategy.locator(`option[value="${value}"]`).count() !== 1) throw new Error(`${phase} combo card omitted upstream/Auto Router strategy ${value}`);
    }
    if (await card.getByText("Easy target", { exact: true }).count() || await card.getByText("Advanced", { exact: true }).count()) throw new Error(`${phase} leaked Auto Router detail controls onto the combo card`);
    const switched = settingsPatch();
    await strategy.selectOption("round-robin"); await switched;
    const restored = settingsPatch();
    await strategy.selectOption("auto"); await restored;

    await autoCard().locator("button[title=\"Edit\"]").click();
    const modal = page.getByText("Edit Combo", { exact: true }).locator("xpath=ancestor::*[.//button[normalize-space()='Save']][1]");
    await modal.waitFor({ timeout: 10_000 });
    if (await modal.getByText("Strategy", { exact: true }).count()) throw new Error(`${phase} Edit Combo retained a Strategy selector`);
    for (const label of ["Easy", "Hard", "Ignored"]) if (await modal.getByText(label, { exact: true }).count() !== 1) throw new Error(`${phase} did not label ordered model target as ${label}`);
    if (await modal.getByText("Legacy targets remain effective until this model order is saved.", { exact: true }).count() !== 1) throw new Error(`${phase} did not warn about legacy target normalization`);
    await modal.getByText("Advanced", { exact: true }).click();
    const hardThreshold = modal.getByLabel(/Hard threshold/);
    if (await hardThreshold.inputValue() !== "7") throw new Error(`${phase} did not preserve advanced settings while switching strategies`);
    if (settingsPatches !== 2) throw new Error(`${phase} unexpectedly persisted modal edits before Save`);
    const save = settingsPatch();
    await modal.getByRole("button", { name: "Save", exact: true }).click(); await save;
    await page.waitForFunction(async () => {
      const [settingsResponse, combosResponse] = await Promise.all([fetch("/api/settings"), fetch("/api/combos")]);
      if (!settingsResponse.ok || !combosResponse.ok) return false;
      const settings = await settingsResponse.json(), combo = (await combosResponse.json()).combos.find(entry => entry.name === "coder-auto");
      const config = settings.comboStrategies?.["coder-auto"]?.autoRouter;
      return settings.comboStrategies?.["coder-auto"]?.fallbackStrategy === "auto" && config?.hardThreshold === 7 && !("easyTarget" in config) && !("hardTarget" in config) && JSON.stringify(combo?.models) === JSON.stringify(["coder-high", "coder", "coder-auto-model"]);
    }, { timeout: 10_000 });
    await autoCard().locator("button[title=\"Edit\"]").click();
    const reloadedModal = page.getByText("Edit Combo", { exact: true }).locator("xpath=ancestor::*[.//button[normalize-space()='Save']][1]");
    await reloadedModal.waitFor({ timeout: 10_000 });
    if (await reloadedModal.getByText("Legacy targets remain effective until this model order is saved.", { exact: true }).count()) throw new Error(`${phase} legacy target notice remained after normalization`);
    await reloadedModal.getByRole("button", { name: "Cancel", exact: true }).click();
    assertNoErrors();
  }
  await context.close();
  await browser.close();
  console.log(`AUTO_ROUTER_BROWSER_TEST_COMPLETE:${phase}`);
})().catch(error => { console.error(error); process.exit(1); });
NODE
); then :; else
    status=$?
    printf '%s\n' "$browser_output" >&2
    exit "$status"
  fi
  printf '%s\n' "$browser_output"
  printf '%s\n' "$browser_output" | grep -Fq "AUTO_ROUTER_BROWSER_TEST_START:$phase" || { echo "Browser test did not start: $phase" >&2; exit 1; }
  printf '%s\n' "$browser_output" | grep -Fq "AUTO_ROUTER_BROWSER_TEST_COMPLETE:$phase" || { echo "Browser test did not complete: $phase" >&2; exit 1; }
}

start "$UPSTREAM_IMAGE"
api -X POST --data '{"provider":"ollama-local","name":"mock","apiKey":"test","providerSpecificData":{"baseUrl":"http://'"$MOCK_NAME"':8080"}}' "http://127.0.0.1:$PORT/api/providers" >/dev/null
for combo in coder coder-high coder-auto; do api -X POST --data '{"name":"'"$combo"'","models":["ollama-local/'"$combo"'-model"]}' "http://127.0.0.1:$PORT/api/combos" >/dev/null; done
api -X PATCH --data '{"unrelatedRollbackSetting":"preserve-me"}' "http://127.0.0.1:$PORT/api/settings" >/dev/null
assert_data; stop

start "$IMAGE"
browser_combos patched-before-auto true
settings | grep -q 'fallbackStrategy":"auto'; ! settings | grep -q '"easyTarget"'; ! settings | grep -q '"hardTarget"'; combos | grep -q '"models":\["coder-high","coder","coder-auto-model"\]'; assert_data
KEY=$(api -X POST --data '{"name":"rollback"}' "http://127.0.0.1:$PORT/api/keys" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>process.stdout.write(JSON.parse(s).key))')
curl --fail --silent -H 'Content-Type: application/json' -H "Authorization: Bearer $KEY" --data '{"model":"coder-auto","messages":[{"role":"user","content":"rename this"}]}' "http://127.0.0.1:$PORT/api/v1/chat/completions" | grep -q 'ok'
stop

start "$UPSTREAM_IMAGE"
assert_data
browser_combos stock-rollback
stock_auto_response=$(curl --silent -H 'Content-Type: application/json' -H "Authorization: Bearer $KEY" --data '{"model":"coder-auto","messages":[{"role":"user","content":"stock auto behavior"}]}' "http://127.0.0.1:$PORT/api/v1/chat/completions")
printf '%s' "$stock_auto_response" | grep -q 'ok' || { echo "Expected observed stock fallbackStrategy:auto delegation response, got: $stock_auto_response" >&2; exit 1; }
api -X PATCH --data '{"comboStrategies":{"coder-auto":{"fallbackStrategy":"fallback"}},"unrelatedRollbackSetting":"preserve-me"}' "http://127.0.0.1:$PORT/api/settings" >/dev/null
settings | grep -q 'fallbackStrategy":"fallback'; combos | grep -q 'coder-auto-model'; assert_data; stop

start "$IMAGE"; assert_data
browser_combos patched-after-recovery
api -X PATCH --data '{"comboStrategies":{"coder-auto":{"fallbackStrategy":"auto","autoRouter":{"easyTarget":"coder","hardTarget":"coder-high"}}},"unrelatedRollbackSetting":"preserve-me"}' "http://127.0.0.1:$PORT/api/settings" >/dev/null
settings | grep -q 'fallbackStrategy":"auto'; browser_combos patched-reconfigured true
echo "Rollback compatibility test passed: stock → Auto Router → stock → Auto Router used one /app/data volume; stock delegates persisted fallbackStrategy:auto to the combo model, and recovery to fallback preserves combo models and unrelated settings."
