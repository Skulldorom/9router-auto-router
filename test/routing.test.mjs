import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { parse } = require("acorn");
const root = path.resolve(import.meta.dirname, "..");
const patcher = path.join(root, "patches/apply-patch.mjs");

const runtime = (body, strategy, combo, models, settings, strategies, resolver = "i") => `exports.modules={3894:(a,b,c)=>{async function z(a,b,c,d,e){} async function y(){let s=(0,o.t8)(${body}),${models}=await (0,${resolver}.d_)(${combo});if(${models}){let ${strategies}=${settings}.comboStrategies||{},${strategy}=${strategies}[${combo}]?.fallbackStrategy||${settings}.comboStrategy||"fallback",g=(0,p.R8)(${models},s,${settings});let q=${settings}.comboStickyRoundRobinLimit;if("fusion"===${strategy})return t.info("CHAT",\`Combo "\${${combo}}" with \${${models}.length} models (strategy: fusion)\`),(0,o.vt)({body:${body},models:${models},handleSingleModel:(c,d,e)=>{let f=b;return z(c,d,f,a,j)});}}};`;
const nestedRuntime = (body, strategy, combo, models, settings, strategies, resolver = "i") => `exports.modules={3894:(a,b,c)=>{async function z(a,b,c,d,e){let q=await (0,i.mA)(${combo});if(!q.provider){let ${models}=await (0,${resolver}.d_)(${combo});if(${models}){let g=await (0,h.mt)(),${strategies}=${settings}.comboStrategies||{},${strategy}=${strategies}[${combo}]?.fallbackStrategy||${settings}.comboStrategy||"fallback";if("fusion"===${strategy})return t.info("CHAT",\`Combo "\${${combo}}" with \${${models}.length} models (strategy: fusion)\`),(0,o.vt)({body:${body},models:${models},handleSingleModel:(a,b,f)=>{let g=c;return z(a,b,g,d,e)});}}};`;
const shadowRuntime = (body, strategy, combo, models) => `exports.modules={3894:(a,b,c)=>{async function z(a,b,c,d,e){let q=await (0,i.mA)(${combo});if(!q.provider){let ${models}=await (0,i.d_)(${combo});if(${models}){let g=await (0,h.mt)(),i=g.comboStrategies||{},${strategy}=i[${combo}]?.fallbackStrategy||g.comboStrategy||"fallback";let q=g.comboStickyRoundRobinLimit;if("fusion"===${strategy})return t.info("CHAT",\`Combo "\${${combo}}" with \${${models}.length} models (strategy: fusion)\`),(0,o.vt)({body:${body},models:${models},handleSingleModel:(a,b,f)=>{let g=c;return z(a,b,g,d,e)});}}};`;
const upstreamLikeRuntime = (body, strategy, combo, models, settings, strategies, resolver = "i") => `exports.modules={3894:(a,b,c)=>{async function z(a,b,c,d,e){} async function y(){let s=(0,o.t8)(${body}),${models}=await (0,${resolver}.d_)(${combo});if(${models}){let ${strategies}=${settings}.comboStrategies||{},${strategy}=${strategies}[${combo}]?.fallbackStrategy||${settings}.comboStrategy||"fallback";${settings}.comboStickyRoundRobinLimit;if("fusion"===${strategy})return t.info("CHAT",\`Combo "\${${combo}}" with \${${models}.length} models (strategy: fusion)\`),(0,o.vt)({body:${body},models:${models},handleSingleModel:(c,d,e)=>{let f=b;if(e&&b){let{tools:a,tool_choice:c,...d}=b.body||{};f={...b,body:d}}return z(c,d,f,a,j)},log:t,comboName:${combo},judgeModel:e[${combo}]?.judgeModel,tuning:e[${combo}]?.fusionTuning})};}};`;

// UI fixtures mirror upstream's compiled shape: a strategy options array, a ComboCard that
// owns the selector, an Edit Combo modal that owns name/models/save, and a collection
// component that renders both. Only the semantic data flow matters to the patcher.
const serverUi = [
  'let bI=[{value:"fallback",label:"Fallback — try in order"},{value:"round-robin",label:"Round Robin — rotate"},{value:"fusion",label:"Fusion — panel + judge"}];',
  'function bJ({combo:a,getCaps:b,activeProviders:c=[],copied:d,onCopy:e,onEdit:f,onDelete:g,strategy:h={},onSetStrategy:i}){let[j,k]=(0,x.useState)(!1),l=h.fallbackStrategy||"fallback",m=h.judgeModel||"";return(0,w.jsxs)(bA.Zp,{padding:"sm",children:[(0,w.jsx)(bA.l6,{options:bI,value:l,onChange:a=>i({fallbackStrategy:a.target.value}),selectClassName:"py-1.5 text-xs"}),"fusion"===l&&"details",(0,w.jsx)("button",{onClick:()=>f(a),children:"Edit"})]})}',
  'function bN({isOpen:a,combo:b,onClose:c,onSave:d,activeProviders:e,kindFilter:f=null}){let[g,h]=(0,x.useState)(b?.name||""),[i,j]=(0,x.useState)(b?.models||[]),[k,l]=(0,x.useState)(!1),[m,n]=(0,x.useState)(!1),[o,p]=(0,x.useState)(""),[q,r]=(0,x.useState)({}),u=a=>a.trim()?(p(""),!0):(p("Only letters, numbers, -, _ and . allowed"),!1),v=async()=>{u(g)&&(n(!0),await d({name:g.trim(),models:i}),n(!1))},y=!!b;return(0,w.jsxs)(w.Fragment,{children:[(0,w.jsx)(bA.aF,{isOpen:a,onClose:c,title:y?"Edit Combo":"Create Combo",children:(0,w.jsxs)("div",{className:"flex flex-col gap-3",children:[(0,w.jsx)(bA.pd,{label:"Combo Name",value:g,onChange:a=>h(a.target.value)}),(0,w.jsx)("label",{children:"Models"}),(0,w.jsx)("button",{onClick:()=>l(!0),children:"Add Model"}),(0,w.jsxs)("div",{className:"flex flex-col gap-2 pt-1 sm:flex-row",children:[(0,w.jsx)(bA.$n,{onClick:c,children:"Cancel"}),(0,w.jsx)(bA.$n,{onClick:v,children:m?"Saving...":y?"Save":"Create"})]})]})})]})}',
  'function bH(){let[a,b]=(0,x.useState)([]),[c,d]=(0,x.useState)(!1),[e,f]=(0,x.useState)(!1),[g,h]=(0,x.useState)(null),[i,j]=(0,x.useState)([]),[k,l]=(0,x.useState)({});let t=async()=>{let[c,d]=await Promise.all([fetch("/api/combos"),fetch("/api/settings")]),f=await c.json(),h=await d.json();b(f.combos||[]),l(h.comboStrategies||{})},y=async(a,b)=>{try{let c=await fetch(`/api/combos/${a}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(b)});if(c.ok)await t(),h(null);else{let a=await c.json();alert(a.error||"Failed to update combo")}}catch(a){console.log("Error updating combo:",a)}},A=async(a,b)=>{try{let c={...k},d={...c[a]||{},...b};d.fallbackStrategy&&"fallback"!==d.fallbackStrategy?c[a]=d:delete c[a],await fetch("/api/settings",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({comboStrategies:c})}),l(c)}catch(a){console.log("Error updating combo strategy:",a)}};return(0,w.jsxs)(w.Fragment,{children:[(0,w.jsx)("p",{children:"Group models under one name, then pick a strategy per combo:"}),(0,w.jsxs)("ul",{children:[(0,w.jsxs)("li",{children:[(0,w.jsx)("span",{children:"Fallback"})," — tries models in order (next on failure)"]}),(0,w.jsxs)("li",{children:[(0,w.jsx)("span",{children:"Round Robin"})," — rotates models across requests to spread load"]}),(0,w.jsxs)("li",{children:[(0,w.jsx)("span",{children:"Fusion"})," — queries all models in parallel, then a judge synthesizes one answer"]})]}),a.map(a=>(0,w.jsx)(bJ,{combo:a,strategy:k[a.name]||{},onSetStrategy:b=>A(a.name,b)},a.id)),g&&(0,w.jsx)(bN,{isOpen:!!g,combo:g,onClose:()=>h(null),onSave:a=>y(g.id,a),activeProviders:i},g.id)]})}',
].join("");

const clientUi = [
  'let f1=[{value:"fallback",label:"Fallback — try in order"},{value:"round-robin",label:"Round Robin — rotate"},{value:"fusion",label:"Fusion — panel + judge"}];',
  'function g1({combo:e,getCaps:t,activeProviders:s=[],copied:i,onCopy:n,onEdit:r,onDelete:o,strategy:c={},onSetStrategy:m}){let[x,p]=(0,a.useState)(!1),u=c.fallbackStrategy||"fallback",h=c.judgeModel||"";return(0,l.jsxs)(d.Zp,{padding:"sm",children:[(0,l.jsx)(d.l6,{options:f1,value:u,onChange:e=>m({fallbackStrategy:e.target.value}),selectClassName:"py-1.5 text-xs"}),"fusion"===u&&"details",(0,l.jsx)("button",{onClick:()=>r(e),children:"Edit"})]})}',
  'function g2({isOpen:e,combo:t,onClose:s,onSave:i,activeProviders:n,kindFilter:r=null}){let[o,c]=(0,a.useState)(t?.name||""),[u,h]=(0,a.useState)(t?.models||[]),[v,x]=(0,a.useState)(!1),[p,f]=(0,a.useState)(!1),[y,b]=(0,a.useState)(""),[k,w]=(0,a.useState)({}),M=e=>e.trim()?(b(""),!0):(b("Only letters, numbers, -, _ and . allowed"),!1),S=async()=>{M(o)&&(f(!0),await i({name:o.trim(),models:u}),f(!1))},E=!!t;return(0,l.jsxs)(l.Fragment,{children:[(0,l.jsx)(d.aF,{isOpen:e,onClose:s,title:E?"Edit Combo":"Create Combo",children:(0,l.jsxs)("div",{className:"flex flex-col gap-3",children:[(0,l.jsx)(d.pd,{label:"Combo Name",value:o,onChange:e=>c(e.target.value)}),(0,l.jsx)("label",{children:"Models"}),(0,l.jsx)("button",{onClick:()=>x(!0),children:"Add Model"}),(0,l.jsxs)("div",{className:"flex flex-col gap-2 pt-1 sm:flex-row",children:[(0,l.jsx)(d.$n,{onClick:s,children:"Cancel"}),(0,l.jsx)(d.$n,{onClick:S,children:p?"Saving...":E?"Save":"Create"})]})]})})]})}',
  'function g3(){let[e,t]=(0,a.useState)([]),[s,i]=(0,a.useState)(!1),[n,r]=(0,a.useState)(!1),[o,c]=(0,a.useState)(null),[u,h]=(0,a.useState)([]),[v,x]=(0,a.useState)({});let N=async()=>{let[e,t]=await Promise.all([fetch("/api/combos"),fetch("/api/settings")]),s=await e.json(),n=await t.json();t(s.combos||[]),x(n.comboStrategies||{})},F=async(e,t)=>{try{let s=await fetch(`/api/combos/${e}`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(t)});if(s.ok)await N(),c(null);else{let e=await s.json();alert(e.error||"Failed to update combo")}}catch(e){console.log("Error updating combo:",e)}},W=async(e,t)=>{try{let s={...v},i={...s[e]||{},...t};i.fallbackStrategy&&"fallback"!==i.fallbackStrategy?s[e]=i:delete s[e],await fetch("/api/settings",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({comboStrategies:s})}),x(s)}catch(e){console.log("Error updating combo strategy:",e)}};return(0,l.jsxs)(l.Fragment,{children:[(0,l.jsx)("p",{children:"Group models under one name, then pick a strategy per combo:"}),(0,l.jsxs)("ul",{children:[(0,l.jsxs)("li",{children:[(0,l.jsx)("span",{children:"Fallback"})," — tries models in order (next on failure)"]}),(0,l.jsxs)("li",{children:[(0,l.jsx)("span",{children:"Round Robin"})," — rotates models across requests to spread load"]}),(0,l.jsxs)("li",{children:[(0,l.jsx)("span",{children:"Fusion"})," — queries all models in parallel, then a judge synthesizes one answer"]})]}),e.map(e=>(0,l.jsx)(g1,{combo:e,strategy:v[e.name]||{},onSetStrategy:t=>W(e.name,t)},e.id)),o&&(0,l.jsx)(g2,{isOpen:!!o,combo:o,onClose:()=>c(null),onSave:e=>F(o.id,e),activeProviders:u},o.id)]})}',
].join("");

function fixture({ duplicate = false, valid = true, shadow = false, handler: handlerOverride, server = serverUi, client = clientUi } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-router-patch-"));
  const serverDir = path.join(dir, ".next/server/chunks");
  const serverUiDir = path.join(dir, ".next/server/app/dashboard/combos");
  const clientUiDir = path.join(dir, ".next/static/chunks/app/dashboard/combos");
  fs.mkdirSync(serverDir, { recursive: true });
  fs.mkdirSync(serverUiDir, { recursive: true });
  fs.mkdirSync(clientUiDir, { recursive: true });
  const handler = shadow ? `${runtime("c", "f", "d", "u", "k", "e", "r")}${shadowRuntime("a", "j", "b", "f", "g")}` : `${runtime("c", "f", "d", "u", "k", "e", "r")}${nestedRuntime("a", "j", "b", "f", "g", "i", "h")}`;
  if (valid) fs.writeFileSync(path.join(serverDir, "dynamic-handler.js"), handlerOverride || handler);
  if (duplicate) fs.writeFileSync(path.join(serverDir, "another-handler.js"), `${runtime("c", "f", "d", "u", "k", "e", "r")}${nestedRuntime("a", "j", "b", "f", "g", "i", "h")}`);
  fs.writeFileSync(path.join(serverUiDir, "page.js"), server);
  fs.writeFileSync(path.join(clientUiDir, "page-93b8d96a5392ea57.js"), client);
  return dir;
}
function patch(dir, extra = []) { return spawnSync(process.execPath, [patcher, dir, ...extra], { encoding: "utf8" }); }
function uiFiles(dir) {
  return [path.join(dir, ".next/server/app/dashboard/combos/page.js"), path.join(dir, ".next/static/chunks/app/dashboard/combos/page-93b8d96a5392ea57.js")];
}
function findFunction(source, markers) {
  const ast = parse(source, { ecmaVersion: "latest", sourceType: "script" });
  const found = [];
  const collect = (node, values) => {
    if (!node || typeof node !== "object" || !node.type) return;
    if (node.type === "Literal") values.add(node.value);
    for (const [key, value] of Object.entries(node)) {
      if (["start", "end", "loc", "range"].includes(key)) continue;
      if (Array.isArray(value)) value.forEach((item) => collect(item, values));
      else collect(value, values);
    }
  };
  const walk = (node) => {
    if (!node || typeof node !== "object" || !node.type) return;
    if (node.type === "FunctionDeclaration") {
      const values = new Set();
      collect(node.body, values);
      if (markers.every((marker) => values.has(marker))) found.push(source.slice(node.start, node.end));
    }
    for (const [key, value] of Object.entries(node)) {
      if (["start", "end", "loc", "range"].includes(key)) continue;
      if (Array.isArray(value)) value.forEach(walk);
      else walk(value);
    }
  };
  walk(ast);
  assert.equal(found.length, 1, `expected exactly one function containing ${markers.join(", ")}`);
  return found[0];
}
function modalSection(source) { return findFunction(source, ["Edit Combo", "Combo Name", "Models", "Add Model", "Cancel", "Save"]); }
function cardSection(source) { return findFunction(source, ["Edit"]); }
function parses(source) { parse(source, { ecmaVersion: "latest", sourceType: "script" }); }

// --- runtime patcher (unchanged behaviour) -------------------------------------------------

test("patcher dynamically discovers runtime and UI assets, patches once, and is idempotent", () => {
  const dir = fixture();
  for (let run = 0; run < 2; run += 1) assert.equal(patch(dir).status, 0);
  const patched = fs.readFileSync(path.join(dir, ".next/server/chunks/dynamic-handler.js"), "utf8");
  assert.equal((patched.match(/9router-auto-router:v3/g) || []).length, 1);
  assert.equal((patched.match(/routeAutoCombo/g) || []).length, 2);
  assert.match(patched, /delegate:\(nextBody,target\)=>z\(nextBody,target,f,a,j\)/);
  assert.match(patched, /delegate:\(nextBody,target\)=>z\(nextBody,target,g,d,e\)/);
  assert.match(patched, /const _arResolveu=\(0,r\.d_\);/);
  assert.match(patched, /const _arResolvef=\(0,h\.d_\);/);
  assert.equal(patch(dir, ["--check"]).status, 0);
});

test("patcher captures the models resolver before an inner rebinding shadow", () => {
  const dir = fixture({ shadow: true });
  const result = patch(dir);
  assert.equal(result.status, 0, result.stderr);
  const patched = fs.readFileSync(path.join(dir, ".next/server/chunks/dynamic-handler.js"), "utf8");
  assert.match(patched, /const _arResolvef=\(0,i\.d_\);/);
  assert.ok(!patched.includes("Boolean(await (0,i.d_)(name))"));
  assert.ok(patched.indexOf("const _arResolvef=") < patched.indexOf("let g=await (0,h.mt)(),i="));
});

test("patcher handles upstream-shaped dispatch payloads with trailing properties", () => {
  const dir = fixture({ handler: `${upstreamLikeRuntime("c", "f", "d", "u", "k", "e", "r")}${nestedRuntime("a", "j", "b", "f", "g", "i", "h")}` });
  const result = patch(dir);
  assert.equal(result.status, 0, result.stderr);
  const patched = fs.readFileSync(path.join(dir, ".next/server/chunks/dynamic-handler.js"), "utf8");
  assert.match(patched, /const _arResolveu=\(0,r\.d_\);/);
  assert.match(patched, /delegate:\(nextBody,target\)=>z\(nextBody,target,f,a,j\)/);
});

test("patcher fails closed with zero or multiple runtime candidates", () => {
  let result = patch(fixture({ valid: false }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Runtime combo handler candidates:\n  0/);
  result = patch(fixture({ duplicate: true }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Runtime combo handler candidates:\n  2/);
});

// --- structural UI transformation ----------------------------------------------------------

test("patcher discovers the Edit Combo modal independently from the combo card", () => {
  const dir = fixture();
  const result = patch(dir);
  assert.equal(result.status, 0, result.stderr);
  for (const file of uiFiles(dir)) {
    const patched = fs.readFileSync(file, "utf8");
    parses(patched);
    const modal = modalSection(patched);
    const card = cardSection(patched);
    assert.match(modal, /label:"Combo Name"/);
    assert.match(modal, /"Models"/);
    assert.match(modal, /"Add Model"/);
    assert.match(modal, /"Cancel"/);
    assert.match(card, /"Edit"/);
    assert.notEqual(modal, card);
  }
});

test("combo card keeps every discovered strategy and appends Auto Router interactively", () => {
  const dir = fixture(); assert.equal(patch(dir).status, 0);
  for (const file of uiFiles(dir)) { const patched = fs.readFileSync(file, "utf8"), card = cardSection(patched);
    for (const strategy of ["Fallback — try in order", "Round Robin — rotate", "Fusion — panel + judge", "Auto Router"]) assert.ok(patched.includes(strategy));
    assert.match(card, /options:[A-Za-z_$][\w$]*,value:[A-Za-z_$][\w$]*,onChange:[A-Za-z_$][\w$]*=>[A-Za-z_$][\w$]*\(\{fallbackStrategy:[A-Za-z_$][\w$]*\.target\.value\}\)/);
    assert.doesNotMatch(card, /children:\([A-Za-z_$][\w$]*\.find\(option=>option\.value===/); assert.equal((patched.match(/label:"Auto Router"/g) || []).length, 1); }
});
test("strategy option discovery preserves future upstream options", () => {
  const extra = `,{value:"adaptive",label:"Adaptive — tune per request"}`, server = serverUi.replace("let bI=[", "var bI = [").replace("}];function bJ", `}${extra}];function bJ`), client = clientUi.replace("let f1=[", "var f1 = [").replace("}];function g1", `}${extra}];function g1`), dir = fixture({ server, client }); assert.equal(patch(dir).status, 0); for (const file of uiFiles(dir)) assert.match(fs.readFileSync(file, "utf8"), /value:"adaptive",label:"Adaptive — tune per request"/);
});
test("Edit Combo labels ordered models without a Strategy or target selector", () => {
  const dir = fixture(); assert.equal(patch(dir).status, 0); for (const file of uiFiles(dir)) { const modal = modalSection(fs.readFileSync(file, "utf8")); for (const label of ["Auto Router", "Easy", "Hard", "Ignored", "Advanced", "Hard threshold", "Long context threshold", "Large tool-result threshold", "Many-tools threshold", "Verbose logging"]) assert.ok(modal.includes(label)); for (const removed of ["\"Strategy\"", "Easy target", "Hard target", "availableCombos", "_arStrategyOptions"]) assert.ok(!modal.includes(removed), `modal retained ${removed}`); assert.match(modal, /0===index\?"Easy":1===index\?"Hard":"Ignored"/); assert.match(modal, /Models after position 2 are ignored by Auto Router/); assert.match(modal, /requires two distinct usable models in positions 1 \(Easy\) and 2 \(Hard\)/); }
});
test("legacy migration initializes visible model order from effective runtime targets", () => {
  const dir = fixture(); assert.equal(patch(dir).status, 0);
  for (const file of uiFiles(dir)) {
    const patched = fs.readFileSync(file, "utf8"), modal = modalSection(patched);
    assert.match(modal, /_arStoredModels=Array\.isArray\(.+?\?\.models\|\|\[\]\)\?.+?\?\.models\|\|\[\]:\[\]/);
    assert.match(modal, /_arLegacyMigration="auto"===_arInitialStrategy\.fallbackStrategy&&_arLegacyTargets/);
    assert.match(modal, /_arEffectiveModels=_arLegacyMigration\?\[_arSavedConfig\.easyTarget\.trim\(\),_arSavedConfig\.hardTarget\.trim\(\),\.\.\._arStoredModels\.filter\(model=>typeof model!=="string"\|\|\(model\.trim\(\)!==_arSavedConfig\.easyTarget\.trim\(\)&&model\.trim\(\)!==_arSavedConfig\.hardTarget\.trim\(\)\)\)\]:null/);
    assert.match(modal, /_arLegacyMigration&&\(0,[A-Za-z_$][\w$]*\.jsx\)\("p",\{className:"text-text-muted",children:"Legacy targets remain effective until this model order is saved\."\}\)/);
    assert.match(modal, /_arEffectiveModels\|\|.+?\?\.models\|\|\[\]/);
    assert.match(modal, /let _arTargets=[A-Za-z_$][\w$]*\.slice\(0,2\)\.map/);
    assert.match(modal, /let \{easyTarget:_arEasyTarget,hardTarget:_arHardTarget,\.\.\.config\}/);
    assert.match(modal, /"auto"===_arInitialStrategy\.fallbackStrategy\?\{autoRouter:config\}:null/);
    assert.match(patched, /let changed=\{\.\.\.original,\.\.\.comboData,models:comboData\.models\}/);
  }
});

test("Edit Combo Save fetches fresh settings, merges strategy entries, and preserves dormant configuration", () => {
  const dir = fixture(); assert.equal(patch(dir).status, 0);
  for (const source of uiFiles(dir).map((file) => fs.readFileSync(file, "utf8"))) {
    assert.match(source, /const _arSave=async\(comboData,strategy\)=>\{let settings,original=/);
    assert.match(source, /await fetch\("\/api\/settings"\)/);
    assert.match(source, /configs=\{\.\.\.\(settings\.comboStrategies\|\|\{\}\)\}/);
    assert.match(source, /oldName!==newName\)\{let old=configs\[oldName\];delete configs\[oldName\];if\(old\)configs\[newName\]=old\}/);
    assert.match(source, /strategy&&strategy\.autoRouter/);
    assert.match(source, /freshConfig\}=base\.autoRouter&&typeof base\.autoRouter==="object"\?base\.autoRouter:\{\}/);
    assert.match(source, /next\.autoRouter=\{\.\.\.freshConfig,\.\.\.strategy\.autoRouter\}/);
    assert.match(source, /models:comboData\.models/);
  }
});

test("generated Save keeps validation, bounds, persistence ordering, rollback, and recovery protections", () => {
  const dir = fixture(); assert.equal(patch(dir).status, 0);
  for (const source of uiFiles(dir).map((file) => fs.readFileSync(file, "utf8"))) {
    const modal = modalSection(source);
    for (const [key, min, max] of [["hardThreshold", 1, 100], ["longContextChars", 1, 10000000], ["largeToolResultChars", 1, 10000000], ["manyTools", 1, 10000]]) {
      assert.match(modal, new RegExp(`${key}:\\[${min},${max}\\]`));
      assert.match(modal, new RegExp(`_arNumber\\([^)]*,"${key}"`));
      assert.match(modal, new RegExp(`min:${min},max:${max}`));
    }
    assert.match(modal, /if\(![A-Za-z_$][\w$]*\([A-Za-z_$][\w$]*\)\)return/);
    assert.match(modal, /[A-Za-z_$][\w$]*\(!0\);try\{/);
    assert.match(modal, /finally\{[A-Za-z_$][\w$]*\(!1\)\}/);
    assert.match(source, /await fetch\("\/api\/settings"\).*?await fetch\(`\/api\/combos\//);
    assert.match(source, /if\(!persisted\.ok\).*?await rollback/);
    assert.match(source, /await fetch\("\/api\/settings"\).*?JSON\.stringify\(current\.comboStrategies\|\|\{\}\)===JSON\.stringify\(configs\)/);
    assert.match(source, /await [A-Za-z_$][\w$]*\(\),[A-Za-z_$][\w$]*\(null\)/);
  }
});

test("card strategy persistence keeps dormant Auto Router configuration", () => {
  const dir = fixture(); assert.equal(patch(dir).status, 0);
  for (const source of uiFiles(dir).map((file) => fs.readFileSync(file, "utf8"))) {
    assert.match(source, /const _arSetStrategy=async\(name,change\)=>/);
    assert.match(source, /next=\{\.\.\.configs\[name\]\|\|\{\},\.\.\.change\}/);
    assert.match(source, /"fallback"!==next\.fallbackStrategy\|\|next\.autoRouter/);
    assert.match(source, /onSetStrategy:[A-Za-z_$][\w$]*=>_arSetStrategy\([A-Za-z_$][\w$]*\.name,[A-Za-z_$][\w$]*\)/);
  }
});
test("legacy model normalization and client/server output stay equivalent", () => { const dir = fixture(); assert.equal(patch(dir).status, 0); for (const source of uiFiles(dir).map((file) => fs.readFileSync(file, "utf8"))) { assert.match(source, /9router-auto-router-ui:v9/); assert.equal(source.split("9router-auto-router-ui:v9").length - 1, 1); assert.match(source, /onSave:_arSave/); parses(source); } });

// --- patcher robustness --------------------------------------------------------------------

test("patcher fails closed when the Edit Combo component is missing", () => {
  const server = serverUi.replace("Combo Name", "Combo Label");
  const result = patch(fixture({ server }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Edit Combo component/);
});

test("patcher fails closed when Edit Combo is ambiguous", () => {
  const clone = 'function bM({isOpen:a,combo:b,onClose:c,onSave:d,activeProviders:e,kindFilter:f=null}){return["Edit Combo","Combo Name","Models","Add Model","Cancel","Save"]}';
  const result = patch(fixture({ server: `${serverUi}${clone}` }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Edit Combo component/);
});

test("patcher fails closed when the strategy selector is missing", () => {
  const server = serverUi.replace('{options:bI,value:l,onChange:a=>i({fallbackStrategy:a.target.value}),selectClassName:"py-1.5 text-xs"}', "null");
  const result = patch(fixture({ server }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /strategy selector/);
});

test("patcher fails closed when the Save path is incompatible", () => {
  const server = serverUi.replace("onSave:a=>y(g.id,a)", "onSave:a=>a");
  const result = patch(fixture({ server }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /invocation data flow is incompatible/);
});

test("patcher fails closed when validation data flow is absent", () => {
  const server = serverUi.replace("v=async()=>{u(g)&&(n(!0),await d({name:g.trim(),models:i}),n(!1))}", "v=async()=>{await d({name:g.trim(),models:i})}");
  const result = patch(fixture({ server }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /validation data flow is incompatible/);
});

test("patcher never writes malformed JavaScript for the rejected modal boundary (regression)", () => {
  // The previous prototype spliced parameters into an incompletely parsed parent call and
  // emitted invalid compiled JS. Structure now resolves before mutation, so a modal whose
  // boundary cannot be parsed is rejected with the source left untouched.
  const truncate = serverUi.replace('g&&(0,w.jsx)(bN,{isOpen:!!g,combo:g,onClose:()=>h(null),onSave:a=>y(g.id,a),activeProviders:i},g.id)', "g&&(0,w.jsx)(bN,{isOpen:!!g,combo:g,onClose:()=>h(null),onSave:a=>y(");
  const dir = fixture({ server: truncate });
  const before = uiFiles(dir).map((file) => fs.readFileSync(file, "utf8"));
  const result = patch(dir);
  assert.notEqual(result.status, 0);
  uiFiles(dir).forEach((file, index) => assert.equal(fs.readFileSync(file, "utf8"), before[index]));
});

test("patcher transforms fixtures containing awkward strings, comments and templates", () => {
  const notes = 'let _note="a)b}c{d(e)f",_tpl=`x){(y}z`;/* ) } ( { */';
  const server = `${notes}${serverUi}`;
  const dir = fixture({ server });
  const result = patch(dir);
  assert.equal(result.status, 0, result.stderr);
  const patched = fs.readFileSync(uiFiles(dir)[0], "utf8");
  parses(patched);
  assert.match(patched, /9router-auto-router-ui:v9/);
});

test("patcher fails closed when the card strategy callback has extra side effects", () => {
  const changed = 'onSetStrategy:b=>{A(a.name,b),z(a.name)}';
  const server = serverUi.replace('onSetStrategy:b=>A(a.name,b)', changed);
  const client = clientUi.replace('onSetStrategy:t=>W(e.name,t)', 'onSetStrategy:t=>{W(e.name,t),Q(e.name)}');
  const dir = fixture({ server, client });
  const before = uiFiles(dir).map((file) => fs.readFileSync(file, "utf8"));
  const result = patch(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /strategy persistence callback is incompatible/);
  uiFiles(dir).forEach((file, index) => assert.equal(fs.readFileSync(file, "utf8"), before[index]));
});

test("patcher fails closed when the strategy updater gains a side effect", () => {
  const server = serverUi.replace("}),l(c)}catch(a)", "}),l(c),z()}catch(a)");
  const client = clientUi.replace("}),x(s)}catch(e)", "}),x(s),Q()}catch(e)");
  const dir = fixture({ server, client });
  const before = uiFiles(dir).map((file) => fs.readFileSync(file, "utf8"));
  const result = patch(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /combo strategy update handler/);
  uiFiles(dir).forEach((file, index) => assert.equal(fs.readFileSync(file, "utf8"), before[index]));
});

test("patcher does not depend on minified identifiers or chunk filenames", () => {
  const renamed = serverUi
    .replace(/\bbI\b/g, "$options")
    .replace(/\bbJ\b/g, "$Card")
    .replace(/\bbN\b/g, "$Modal")
    .replace(/\bbH\b/g, "$Collection")
    .replace(/\(0,w\.jsxs\)/g, "(0,$rt.jsxs)")
    .replace(/\(0,w\.jsx\)/g, "(0,$rt.jsx)")
    .replace(/\(0,x\.useState\)/g, "(0,$react.useState)");
  const dir = fixture({ server: renamed });
  const result = patch(dir);
  assert.equal(result.status, 0, result.stderr);
  const patched = fs.readFileSync(path.join(dir, ".next/server/app/dashboard/combos/page.js"), "utf8");
  parses(patched);
  assert.match(patched, /\$Modal/);
  assert.match(patched, /label:"Auto Router"/);
});

test("patcher fails closed for ambiguous or incompatible combo collection data flow", () => {
  const broken = serverUi.replace("{combo:a,strategy:k[a.name]||{},onSetStrategy:b=>A(a.name,b)}", "{combo:a,strategy:{},onSetStrategy:b=>A(a.name,b)}");
  const result = patch(fixture({ server: broken }));
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /combo collection component|parent settings data flow|semantic anchor is not unique/);
});

test("patcher check validates unpatched structure and rejects partially patched assets", () => {
  const dir = fixture();
  assert.equal(patch(dir, ["--check"]).status, 0);
  assert.equal(patch(dir).status, 0);
  const runtimeTarget = path.join(dir, ".next/server/chunks/dynamic-handler.js");
  fs.writeFileSync(runtimeTarget, fs.readFileSync(runtimeTarget, "utf8").replace("routeAutoCombo", "delegatedRoute"));
  const result = patch(dir, ["--check"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Patched runtime handler integrity failed/);
});

test("patcher rejects assets whose card carries any Auto Router control marker", () => {
  for (const marker of ["Auto Router Settings", "Easy target", "Hard target", "Advanced"]) {
    const server = serverUi.replace('return(0,w.jsxs)(bA.Zp,{padding:"sm",children:[', `return(0,w.jsxs)(bA.Zp,{padding:"sm",children:["${marker}",`);
    const result = patch(fixture({ server }));
    assert.notEqual(result.status, 0, marker);
    assert.match(result.stderr, /leaked into the combo card/);
  }
});

test("patcher fails closed when UI candidates disappear", () => {
  const dir = fixture();
  fs.rmSync(uiFiles(dir)[1]);
  const result = patch(dir);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Combo UI strategy asset candidates:\n  1/);
});

test("patcher check parses each candidate before mutating", () => {
  const server = `${serverUi}function broken(`;
  const dir = fixture({ server });
  const before = uiFiles(dir).map((file) => fs.readFileSync(file, "utf8"));
  const result = patch(dir, ["--check"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /cannot be parsed/);
  uiFiles(dir).forEach((file, index) => assert.equal(fs.readFileSync(file, "utf8"), before[index]));
});
