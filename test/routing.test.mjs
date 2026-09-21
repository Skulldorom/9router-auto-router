import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const patcher = path.join(root, "patches/apply-patch.mjs");
const runtime = (body, strategy, combo, models, settings, strategies, resolver = "i") => `exports.modules={3894:(a,b,c)=>{async function z(a,b,c,d,e){} async function y(){let s=(0,o.t8)(${body}),${models}=await (0,${resolver}.d_)(${combo});if(${models}){let ${strategies}=${settings}.comboStrategies||{},${strategy}=${strategies}[${combo}]?.fallbackStrategy||${settings}.comboStrategy||"fallback",g=(0,p.R8)(${models},s,${settings});let q=${settings}.comboStickyRoundRobinLimit;if("fusion"===${strategy})return t.info("CHAT",\`Combo "\${${combo}}" with \${${models}.length} models (strategy: fusion)\`),(0,o.vt)({body:${body},models:${models},handleSingleModel:(c,d,e)=>{let f=b;return z(c,d,f,a,j)});}}};`;
// Mirrors upstream's nested second dispatch: inner comboStrategies binding is comma-joined, not a `let`.
const nestedRuntime = (body, strategy, combo, models, settings, strategies, resolver = "i") => `exports.modules={3894:(a,b,c)=>{async function z(a,b,c,d,e){let q=await (0,i.mA)(${combo});if(!q.provider){let ${models}=await (0,${resolver}.d_)(${combo});if(${models}){let g=await (0,h.mt)(),${strategies}=${settings}.comboStrategies||{},${strategy}=${strategies}[${combo}]?.fallbackStrategy||${settings}.comboStrategy||"fallback";if("fusion"===${strategy})return t.info("CHAT",\`Combo "\${${combo}}" with \${${models}.length} models (strategy: fusion)\`),(0,o.vt)({body:${body},models:${models},handleSingleModel:(a,b,f)=>{let g=c;return z(a,b,g,d,e)});}}};`;
const serverUi = 'let bI=[{value:"fallback",label:"Fallback — try in order"},{value:"round-robin",label:"Round Robin — rotate"},{value:"fusion",label:"Fusion — panel + judge"}];function bJ({combo:a,getCaps:b,activeProviders:c=[],copied:d,onCopy:e,onEdit:f,onDelete:g,strategy:h={},onSetStrategy:i}){let[j,k]=(0,x.useState)(!1),l=h.fallbackStrategy||"fallback",m=h.judgeModel||"";return(0,w.jsxs)(bA.Zp,{children:[(0,w.jsx)(bA.l6,{options:bI,value:l,onChange:a=>i({fallbackStrategy:a.target.value}),selectClassName:"py-1.5 text-xs"}),"fusion"===l&&"details"]})}strategy:k[a.name]||{},onSetStrategy:b=>A(a.name,b)';
const clientUi = 'let f=[{value:"fallback",label:"Fallback — try in order"},{value:"round-robin",label:"Round Robin — rotate"},{value:"fusion",label:"Fusion — panel + judge"}];function g({combo:e,getCaps:t,activeProviders:s=[],copied:i,onCopy:n,onEdit:r,onDelete:o,strategy:c={},onSetStrategy:m}){let[x,p]=(0,a.useState)(!1),u=c.fallbackStrategy||"fallback",h=c.judgeModel||"";return(0,l.jsxs)(d.Zp,{children:[(0,l.jsx)(d.l6,{options:f,value:u,onChange:e=>m({fallbackStrategy:e.target.value}),selectClassName:"py-1.5 text-xs"}),"fusion"===u&&"details"]})}strategy:y[e.name]||{},onSetStrategy:t=>_(e.name,t)';
function fixture({ duplicate = false, valid = true, shadow = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-router-patch-"));
  const server = path.join(dir, ".next/server/chunks"), serverUiDir = path.join(dir, ".next/server/app/dashboard/combos"), clientUiDir = path.join(dir, ".next/static/chunks/app/dashboard/combos");
  fs.mkdirSync(server, { recursive: true }); fs.mkdirSync(serverUiDir, { recursive: true }); fs.mkdirSync(clientUiDir, { recursive: true });
  const handler = shadow ? `${runtime("c", "f", "d", "u", "k", "e", "r")}${shadowRuntime("a", "j", "b", "f", "g")}` : `${runtime("c", "f", "d", "u", "k", "e", "r")}${nestedRuntime("a", "j", "b", "f", "g", "i", "h")}`;
  if (valid) fs.writeFileSync(path.join(server, "dynamic-handler.js"), handler);
  if (duplicate) fs.writeFileSync(path.join(server, "another-handler.js"), `${runtime("c", "f", "d", "u", "k", "e", "r")}${nestedRuntime("a", "j", "b", "f", "g", "i", "h")}`);
  fs.writeFileSync(path.join(serverUiDir, "page.js"), serverUi); fs.writeFileSync(path.join(clientUiDir, "page-hash.js"), clientUi);
  return dir;
}
// Reproduces upstream's real shadowing: the minified resolver alias `i` is later
// re-bound by an inner `let ...i=` in the same scope, so inlining `(0,i.d_)` at the
// dispatch would hit a temporal-dead-zone error. The patcher must capture the alias
// before the shadowing statement instead.
const shadowRuntime = (body, strategy, combo, models, settings) => `exports.modules={3894:(a,b,c)=>{async function z(a,b,c,d,e){let q=await (0,i.mA)(${combo});if(!q.provider){let ${models}=await (0,i.d_)(${combo});if(${models}){let g=await (0,h.mt)(),i=g.comboStrategies||{},${strategy}=i[${combo}]?.fallbackStrategy||g.comboStrategy||"fallback";let q=g.comboStickyRoundRobinLimit;if("fusion"===${strategy})return t.info("CHAT",\`Combo "\${${combo}}" with \${${models}.length} models (strategy: fusion)\`),(0,o.vt)({body:${body},models:${models},handleSingleModel:(a,b,f)=>{let g=c;return z(a,b,g,d,e)});}}};`;
test("patcher dynamically discovers runtime and UI assets, patches once, and is idempotent", () => {
  const dir = fixture();
  for (let run = 0; run < 2; run += 1) assert.equal(spawnSync(process.execPath, [patcher, dir], { encoding: "utf8" }).status, 0);
  const patched = fs.readFileSync(path.join(dir, ".next/server/chunks/dynamic-handler.js"), "utf8");
  assert.equal((patched.match(/9router-auto-router:v3/g) || []).length, 1);   assert.equal((patched.match(/routeAutoCombo/g) || []).length, 2);
  assert.match(patched, /delegate:\(nextBody,target\)=>z\(nextBody,target,f,a,j\)/); assert.match(patched, /delegate:\(nextBody,target\)=>z\(nextBody,target,g,d,e\)/);
  assert.match(patched, /const _arResolveu=\(0,r\.d_\);/); assert.match(patched, /const _arResolvef=\(0,h\.d_\);/);
  assert.match(patched, /comboName:d,comboStrategies:e,globalStrategy:k\.comboStrategy,log:t,targetExists:async\(name\)=>Boolean\(await _arResolveu\(name\)\)/);
  assert.match(patched, /comboName:b,comboStrategies:i,globalStrategy:g\.comboStrategy,log:t,targetExists:async\(name\)=>Boolean\(await _arResolvef\(name\)\)/);
  assert.equal(spawnSync(process.execPath, [patcher, dir, "--check"], { encoding: "utf8" }).status, 0);
  const patchedUi = fs.readFileSync(path.join(dir, ".next/static/chunks/app/dashboard/combos/page-hash.js"), "utf8");
  assert.match(patchedUi, /label:"Auto Router"/);
  assert.match(patchedUi, /autoRouter/);
  assert.match(patchedUi, /easyTarget/);
  assert.match(patchedUi, /hardTarget/);
  assert.match(patchedUi, /hardThreshold/); assert.match(patchedUi, /defaultValue:o?\.?hardThreshold|defaultValue:v\.hardThreshold/); assert.ok(!patchedUi.includes("value:v.hardThreshold"));
  for (const label of ["Easy target", "Hard target", "Advanced", "Hard threshold", "Long context threshold (characters)", "Large tool-result threshold (characters)", "Many-tools threshold", "Verbose logging"]) assert.ok(patchedUi.includes(label));
  assert.match(patchedUi, /availableCombos:e\.map\(t=>\(\{name:t\.name,strategy:y\[t\.name\]\|\|\{\}\}\)\)/);
  assert.match(patchedUi, /filter\(t=>t\.name!==e\.name&&t\.strategy\.fallbackStrategy!=="auto"\)/);
  assert.match(patchedUi, /missing or Auto Router — unsupported target/); assert.match(patchedUi, /disabled:!0/);
  const patchedServerUi = fs.readFileSync(path.join(dir, ".next/server/app/dashboard/combos/page.js"), "utf8");
  for (const label of ["Easy target", "Hard target", "Advanced", "Hard threshold", "Long context threshold (characters)", "Large tool-result threshold (characters)", "Many-tools threshold", "Verbose logging"]) assert.ok(patchedServerUi.includes(label));
  assert.match(patchedServerUi, /defaultValue:o.hardThreshold/); assert.ok(!patchedServerUi.includes("value:o.hardThreshold"));
  assert.match(patchedServerUi, /availableCombos:a\.map\(b=>\(\{name:b\.name,strategy:k\[b\.name\]\|\|\{\}\}\)\)/);
  assert.match(patchedServerUi, /filter\(b=>b\.name!==a\.name&&b\.strategy\.fallbackStrategy!=="auto"\)/);
});
test("patcher captures the models resolver before an inner rebinding shadow", () => {
  const dir = fixture({ shadow: true });
  const result = spawnSync(process.execPath, [patcher, dir], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const patched = fs.readFileSync(path.join(dir, ".next/server/chunks/dynamic-handler.js"), "utf8");
  assert.match(patched, /const _arResolvef=\(0,i\.d_\);/);
  assert.match(patched, /targetExists:async\(name\)=>Boolean\(await _arResolvef\(name\)\)/);
  assert.ok(!patched.includes("Boolean(await (0,i.d_)(name))"));
  const captureIndex = patched.indexOf("const _arResolvef=");
  const shadowIndex = patched.indexOf("let g=await (0,h.mt)(),i=");
  assert.ok(captureIndex > 0 && captureIndex < shadowIndex, "resolver capture must precede the shadowing statement");
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

test("patcher fails closed for ambiguous UI strategy anchors", () => {
  const dir = fixture();
  const client = path.join(dir, ".next/static/chunks/app/dashboard/combos/page-hash.js");
  fs.writeFileSync(client, `${fs.readFileSync(client, "utf8")}${clientUi}`);
  const result = spawnSync(process.execPath, [patcher, dir], { encoding: "utf8" });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /UI strategy anchor is not unique|semantic anchor is not unique/);
});

test("patcher fails closed when a fusion dispatch or required binding changes", () => {
  for (const mutate of [
    (source) => source.replace('if("fusion"===f)', 'if("fallback"===f)'),
    (source) => source.replace('e=k.comboStrategies||{}', 'e=k.strategies||{}'),
  ]) {
    const dir = fixture();
    const target = path.join(dir, ".next/server/chunks/dynamic-handler.js");
    fs.writeFileSync(target, mutate(fs.readFileSync(target, "utf8")));
    const result = spawnSync(process.execPath, [patcher, dir], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /fusion dispatch anchors|data-flow validation/);
  }
});

test("patcher fails closed when UI candidates disappear", () => {
  const dir = fixture();
  fs.rmSync(path.join(dir, ".next/static/chunks/app/dashboard/combos/page-hash.js"));
  const result = spawnSync(process.execPath, [patcher, dir], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Combo UI strategy asset candidates:\n  1/);
});

test("patcher check rejects inconsistent partially patched assets", () => {
  const dir = fixture();
  assert.equal(spawnSync(process.execPath, [patcher, dir], { encoding: "utf8" }).status, 0);
  const runtimeTarget = path.join(dir, ".next/server/chunks/dynamic-handler.js");
  fs.writeFileSync(runtimeTarget, fs.readFileSync(runtimeTarget, "utf8").replace("routeAutoCombo", "delegatedRoute"));
  const result = spawnSync(process.execPath, [patcher, dir, "--check"], { encoding: "utf8" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Patched runtime handler integrity failed/);
});
