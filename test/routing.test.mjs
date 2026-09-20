import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const patcher = path.join(root, "patches/apply-patch.mjs");
const runtime = (body, strategy, combo, models, settings, strategies) => `exports.modules={3894:(a,b,c)=>{async function z(a,b,c,d,e){} async function y(){let ${strategies}=${settings}.comboStrategies||{},${strategy}=${strategies}[${combo}]?.fallbackStrategy||${settings}.comboStrategy||"fallback";let q=${settings}.comboStickyRoundRobinLimit;if("fusion"===${strategy})return t.info("CHAT",\`Combo "\${${combo}}" with \${${models}.length} models (strategy: fusion)\`),(0,o.vt)({body:${body},models:${models},handleSingleModel:(x,y)=>z(x,y,c,d,e)});}}};`;
const ui = 'let bI=[{value:"fallback",label:"Fallback — try in order"},{value:"round-robin",label:"Round Robin — rotate"},{value:"fusion",label:"Fusion — panel + judge"}];function bJ({combo:a,getCaps:b,activeProviders:c=[],copied:d,onCopy:e,onEdit:f,onDelete:g,strategy:h={},onSetStrategy:i}){let[j,k]=(0,x.useState)(!1),l=h.fallbackStrategy||"fallback",m=h.judgeModel||"";return(0,w.jsxs)(bA.Zp,{children:[(0,w.jsx)(bA.l6,{options:bI,value:l,onChange:a=>i({fallbackStrategy:a.target.value}),selectClassName:"py-1.5 text-xs"}),"fusion"===l&&"details"]})}strategy:k[a.name]||{},onSetStrategy:b=>A(a.name,b)';
function fixture({ duplicate = false, valid = true } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-router-patch-"));
  const server = path.join(dir, ".next/server/chunks"), serverUi = path.join(dir, ".next/server/app/dashboard/combos"), clientUi = path.join(dir, ".next/static/chunks/app/dashboard/combos");
  fs.mkdirSync(server, { recursive: true }); fs.mkdirSync(serverUi, { recursive: true }); fs.mkdirSync(clientUi, { recursive: true });
  if (valid) fs.writeFileSync(path.join(server, "dynamic-handler.js"), `${runtime("c", "f", "d", "u", "k", "e")}${runtime("a", "j", "b", "f", "g", "i")}`);
  if (duplicate) fs.writeFileSync(path.join(server, "another-handler.js"), `${runtime("c", "f", "d", "u", "k", "e")}${runtime("a", "j", "b", "f", "g", "i")}`);
  fs.writeFileSync(path.join(serverUi, "page.js"), ui); fs.writeFileSync(path.join(clientUi, "page-hash.js"), ui);
  return dir;
}
test("patcher dynamically discovers runtime and UI assets, patches once, and is idempotent", () => {
  const dir = fixture();
  for (let run = 0; run < 2; run += 1) assert.equal(spawnSync(process.execPath, [patcher, dir], { encoding: "utf8" }).status, 0);
  const patched = fs.readFileSync(path.join(dir, ".next/server/chunks/dynamic-handler.js"), "utf8");
  assert.equal((patched.match(/9router-auto-router:v3/g) || []).length, 1); assert.equal((patched.match(/routeAutoCombo/g) || []).length, 2);
  assert.match(patched, /delegate:\(nextBody,target\)=>z\(nextBody,target,b,a,j\)/); assert.match(patched, /delegate:\(nextBody,target\)=>z\(nextBody,target,c,d,e\)/);
  assert.equal(spawnSync(process.execPath, [patcher, dir, "--check"], { encoding: "utf8" }).status, 0);
  const patchedUi = fs.readFileSync(path.join(dir, ".next/static/chunks/app/dashboard/combos/page-hash.js"), "utf8");
  assert.match(patchedUi, /label:"Auto Router"/);
  assert.match(patchedUi, /autoRouter/);
  assert.match(patchedUi, /easyTarget/);
  assert.match(patchedUi, /hardTarget/);
  assert.match(patchedUi, /hardThreshold/);
});
test("patcher fails closed with zero runtime candidates", () => {
  const result = spawnSync(process.execPath, [patcher, fixture({ valid: false })], { encoding: "utf8", env: { ...process.env, UPSTREAM_IMAGE: "example:zero" } });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Runtime combo handler candidates:\n  0/); assert.match(result.stderr, /Upstream image:\n  example:zero/);
});
test("patcher fails closed with multiple runtime candidates", () => {
  const result = spawnSync(process.execPath, [patcher, fixture({ duplicate: true })], { encoding: "utf8" });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /Runtime combo handler candidates:\n  2/); assert.match(result.stderr, /another-handler.js/);
});
test("patcher fails closed when required semantic anchors change", () => {
  const dir = fixture(); fs.writeFileSync(path.join(dir, ".next/server/chunks/dynamic-handler.js"), "changed upstream");
  const result = spawnSync(process.execPath, [patcher, dir], { encoding: "utf8" });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /compatibility check failed/);
});
