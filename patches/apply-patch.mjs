import fs from "node:fs";
import path from "node:path";

const appRoot = process.argv[2] || "/app";
const checkOnly = process.argv.includes("--check");
const runtimeMarker = "9router-auto-router:v3";
const uiMarker = "9router-auto-router-ui:v3";
const UI_ANCHOR = '"fusion",label:"Fusion — panel + judge"';
const UI_PATCH = '"fusion",label:"Fusion — panel + judge"},{value:"auto",label:"Auto Router"';

function count(source, needle) { return source.split(needle).length - 1; }
function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}
function relative(files) { return files.map((file) => path.relative(appRoot, file)).join("\n  ") || "none"; }
function fail(message) {
  console.error(`9Router Auto Router compatibility check failed.\n\nUpstream image:\n  ${process.env.UPSTREAM_IMAGE || "unknown"}\n\n${message}\n\nReview upstream changes before rebuilding.`);
  process.exit(1);
}
function discoverRuntimeCandidate() {
  const files = walk(path.join(appRoot, ".next/server")).filter((file) => file.endsWith(".js"));
  const semantic = files.filter((file) => {
    const source = fs.readFileSync(file, "utf8");
    return source.includes("comboStrategies") && source.includes("strategy: fusion") && source.includes('Combo "') && source.includes("handleSingleModel") && source.includes("comboStickyRoundRobinLimit");
  });
  if (semantic.length !== 1) fail(`Runtime combo handler candidates:\n  ${semantic.length}\n\nCandidate files:\n  ${relative(semantic)}\n\nExpected:\n  exactly 1\n\nRequired semantic anchors:\n  comboStrategies, strategy: fusion, Combo \", handleSingleModel, comboStickyRoundRobinLimit`);
  return semantic[0];
}
function dispatchAnchors(source) {
  const anchors = [...source.matchAll(/if\("fusion"===([A-Za-z_$][\w$]*)\)return ([A-Za-z_$][\w$]*)\.info\("CHAT",`Combo "\$\{([A-Za-z_$][\w$]*)\}" with \$\{([A-Za-z_$][\w$]*)\.length\} models \(strategy: fusion\)`\),\(0,([A-Za-z_$][\w$]*)\.([A-Za-z_$][\w$]*)\)/g)];
  if (anchors.length !== 2) fail(`Runtime handler:\n  ${path.relative(appRoot, discoverRuntimeCandidate())}\n\nExpected exactly 2 unique fusion dispatch anchors; found ${anchors.length}.`);
  if (new Set(anchors.map((match) => match[0])).size !== 2) fail("Runtime handler contains ambiguous duplicate fusion dispatch anchors.");
  return anchors;
}
function patchRuntime(target) {
  let source = fs.readFileSync(target, "utf8");
  if (source.includes(runtimeMarker)) {
    if (count(source, runtimeMarker) !== 1 || count(source, "routeAutoCombo") !== 2) fail(`Patched runtime handler integrity failed:\n  ${path.relative(appRoot, target)}`);
    return false;
  }
  const anchors = dispatchAnchors(source);
  source = `/* ${runtimeMarker} */${source}`;
  for (const match of anchors) {
    const [anchor, strategy, log, comboName] = match;
    const index = source.indexOf(anchor);
    const before = source.slice(Math.max(0, index - 3000), index);
    const after = source.slice(index, index + 900);
    const body = after.match(/\{body:([A-Za-z_$][\w$]*),models:/)?.[1];
    const models = after.match(/\{body:[A-Za-z_$][\w$]*,models:([A-Za-z_$][\w$]*)/)?.[1];
    // Find the models resolver call; its minified alias may be shadowed by a later inner binding.
    const resolver = [...before.matchAll(new RegExp(`${models}=await \\(0,([A-Za-z_$][\\w$]*)\\.([A-Za-z_$][\\w$]*)\\)\\(`, "g"))].at(-1);
    const bindings = [...before.matchAll(/(?:let |,)([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.comboStrategies\|\|\{\}/g)];
    const strategyBinding = bindings.at(-1);
    const strategies = strategyBinding?.[1], settings = strategyBinding?.[2];
    const dispatch = after.match(/handleSingleModel:\(([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*),([A-Za-z_$][\w$]*)\)=>[\s\S]*?return ([A-Za-z_$][\w$]*)\(([^()]*)\)/);
    const statement = resolver ? before.lastIndexOf("let ", resolver.index) : -1;
    if (!body || !models || !resolver || !strategies || !settings || !dispatch || body === models || statement < 0) fail(`Runtime dispatch data-flow validation failed:\n  ${path.relative(appRoot, target)}\n\nExpected body, models resolver, comboStrategies, settings, and single-model dispatch near fusion dispatch.`);
    const capture = `_arResolve${models}`;
    if (source.includes(capture)) fail(`Runtime dispatch data-flow validation failed:\n  ${path.relative(appRoot, target)}\n\nUnexpected resolver capture name collision.`);
    const captureIndex = index - before.length + statement;
    source = `${source.slice(0, captureIndex)}const ${capture}=(0,${resolver[1]}.${resolver[2]});${source.slice(captureIndex)}`;
    const forwarded = dispatch[5].split(",").map((value) => value.trim());
    forwarded[0] = "nextBody"; forwarded[1] = "target";
    const patch = `if("auto"===${strategy})return require("/opt/9router-auto-router/auto-router.cjs").routeAutoCombo({body:${body},comboName:${comboName},comboStrategies:${strategies},globalStrategy:${settings}.comboStrategy,log:${log},targetExists:async(name)=>Boolean(await ${capture}(name)),delegate:(nextBody,target)=>${dispatch[4]}(${forwarded.join(",")})});`;
    source = source.replace(anchor, `${patch}${anchor}`);
  }
  if (count(source, runtimeMarker) !== 1 || count(source, "routeAutoCombo") !== 2) fail(`Runtime patch integrity failed:\n  ${path.relative(appRoot, target)}`);
  fs.writeFileSync(target, source);
  return true;
}
function discoverUiCandidates() {
  const files = walk(path.join(appRoot, ".next")).filter((file) => file.endsWith(".js"));
  const candidates = files.filter((file) => {
    const source = fs.readFileSync(file, "utf8");
    return source.includes('"fallback",label:"Fallback — try in order"') && source.includes('"round-robin",label:"Round Robin — rotate"') && source.includes(UI_ANCHOR);
  });
  if (candidates.length !== 2) fail(`Combo UI strategy asset candidates:\n  ${candidates.length}\n\nCandidate files:\n  ${relative(candidates)}\n\nExpected:\n  exactly 2 (server and client assets)\n\nRequired semantic anchors:\n  Fallback — try in order, Round Robin — rotate, Fusion — panel + judge`);
  return candidates;
}
function patchUi(targets) {
  let changed = false;
  for (const target of targets) {
    let source = fs.readFileSync(target, "utf8");
    if (source.includes(uiMarker)) {
      if (count(source, uiMarker) !== 1 || !source.includes('label:"Auto Router"') || !source.includes("autoRouter")) fail(`Patched UI integrity failed:\n  ${path.relative(appRoot, target)}`);
      continue;
    }
    if (count(source, UI_ANCHOR) !== 1) fail(`UI strategy anchor is not unique:\n  ${path.relative(appRoot, target)}`);
    const isServer = source.includes('function bJ({combo:a,getCaps:b,activeProviders:c=[],copied:d,onCopy:e,onEdit:f,onDelete:g,strategy:h={},onSetStrategy:i})');
    const isClient = source.includes('function g({combo:e,getCaps:t,activeProviders:s=[],copied:i,onCopy:n,onEdit:r,onDelete:o,strategy:c={},onSetStrategy:m})');
    if (isServer === isClient) fail(`Combo UI semantic candidate is ambiguous:\n  ${path.relative(appRoot, target)}`);
    const spec = isServer ? {
      component: 'function bJ({combo:a,getCaps:b,activeProviders:c=[],copied:d,onCopy:e,onEdit:f,onDelete:g,strategy:h={},onSetStrategy:i})',
      componentPatched: 'function bJ({combo:a,getCaps:b,activeProviders:c=[],copied:d,onCopy:e,onEdit:f,onDelete:g,strategy:h={},onSetStrategy:i,availableCombos:q=[]})',
      call: 'strategy:k[a.name]||{},onSetStrategy:b=>A(a.name,b)',
      callPatched: 'availableCombos:a.map(b=>({name:b.name,strategy:k[b.name]||{}})),strategy:k[a.name]||{},onSetStrategy:b=>A(a.name,b)',
      state: 'let[j,k]=(0,x.useState)(!1),l=h.fallbackStrategy||"fallback",m=h.judgeModel||"";',
      statePatched: 'let[j,k]=(0,x.useState)(!1),l=h.fallbackStrategy||"fallback",m=h.judgeModel||"",o=h.autoRouter&&typeof h.autoRouter==="object"?h.autoRouter:{},p=(key,value)=>i({autoRouter:{...o,[key]:value}});',
      selector: '(0,w.jsx)(bA.l6,{options:bI,value:l,onChange:a=>i({fallbackStrategy:a.target.value}),selectClassName:"py-1.5 text-xs"})',
      level: 'l',
      autoCard: '"auto"===l&&(0,w.jsx)("div",{className:"mt-2 text-[11px] text-text-muted",children:"Auto Router"}),',
      jsx: 'w',
      config: 'o', update: 'p', combo: 'a',
      controls: '(0,w.jsxs)("div",{className:"mt-2 grid gap-2 text-xs",children:[(0,w.jsxs)("label",{className:"grid gap-1",children:["Easy target",(0,w.jsxs)("select",{className:"py-1.5 text-xs",value:o.easyTarget||"",onChange:b=>p("easyTarget",b.target.value),children:[(0,w.jsx)("option",{value:"",children:"Select combo"})...(o.easyTarget&&!q.some(b=>b.name===o.easyTarget&&b.strategy.fallbackStrategy!=="auto")?[(0,w.jsx)("option",{value:o.easyTarget,disabled:!0,children:`${o.easyTarget} (missing or Auto Router — unsupported target)`},o.easyTarget)]:[]),...q.filter(b=>b.name!==a.name&&b.strategy.fallbackStrategy!=="auto").map(b=>(0,w.jsx)("option",{value:b.name,children:b.name},b.name))]})]}),(0,w.jsxs)("label",{className:"grid gap-1",children:["Hard target",(0,w.jsxs)("select",{className:"py-1.5 text-xs",value:o.hardTarget||"",onChange:b=>p("hardTarget",b.target.value),children:[(0,w.jsx)("option",{value:"",children:"Select combo"})...(o.hardTarget&&!q.some(b=>b.name===o.hardTarget&&b.strategy.fallbackStrategy!=="auto")?[(0,w.jsx)("option",{value:o.hardTarget,disabled:!0,children:`${o.hardTarget} (missing or Auto Router — unsupported target)`},o.hardTarget)]:[]),...q.filter(b=>b.name!==a.name&&b.strategy.fallbackStrategy!=="auto").map(b=>(0,w.jsx)("option",{value:b.name,children:b.name},b.name))]})]}),(0,w.jsxs)("details",{className:"rounded border border-black/5 p-2 dark:border-white/10",children:[(0,w.jsx)("summary",{className:"cursor-pointer font-medium",children:"Advanced"}),(0,w.jsxs)("div",{className:"mt-2 grid gap-2",children:[(0,w.jsxs)("label",{className:"grid gap-1",children:["Hard threshold",(0,w.jsx)("input",{className:"py-1 text-xs",type:"number",min:1,defaultValue:o.hardThreshold||6,onBlur:b=>{const c=Number(b.target.value);if(Number.isSafeInteger(c)&&c>0)p("hardThreshold",c)}})]}),(0,w.jsxs)("label",{className:"grid gap-1",children:["Long context threshold (characters)",(0,w.jsx)("input",{className:"py-1 text-xs",type:"number",min:1,defaultValue:o.longContextChars||24000,onBlur:b=>{const c=Number(b.target.value);if(Number.isSafeInteger(c)&&c>0)p("longContextChars",c)}})]}),(0,w.jsxs)("label",{className:"grid gap-1",children:["Large tool-result threshold (characters)",(0,w.jsx)("input",{className:"py-1 text-xs",type:"number",min:1,defaultValue:o.largeToolResultChars||12000,onBlur:b=>{const c=Number(b.target.value);if(Number.isSafeInteger(c)&&c>0)p("largeToolResultChars",c)}})]}),(0,w.jsxs)("label",{className:"grid gap-1",children:["Many-tools threshold",(0,w.jsx)("input",{className:"py-1 text-xs",type:"number",min:1,defaultValue:o.manyTools||16,onBlur:b=>{const c=Number(b.target.value);if(Number.isSafeInteger(c)&&c>0)p("manyTools",c)}})]}),(0,w.jsxs)("label",{className:"flex items-center gap-2",children:[(0,w.jsx)("input",{type:"checkbox",checked:!!o.verbose,onChange:b=>p("verbose",b.target.checked)}),"Verbose logging"]})]})]})]})',
    } : {
      component: 'function g({combo:e,getCaps:t,activeProviders:s=[],copied:i,onCopy:n,onEdit:r,onDelete:o,strategy:c={},onSetStrategy:m})',
      componentPatched: 'function g({combo:e,getCaps:t,activeProviders:s=[],copied:i,onCopy:n,onEdit:r,onDelete:o,strategy:c={},onSetStrategy:m,availableCombos:q=[]})',
      call: 'strategy:y[e.name]||{},onSetStrategy:t=>_(e.name,t)',
      callPatched: 'availableCombos:e.map(t=>({name:t.name,strategy:y[t.name]||{}})),strategy:y[e.name]||{},onSetStrategy:t=>_(e.name,t)',
      state: 'let[x,p]=(0,a.useState)(!1),u=c.fallbackStrategy||"fallback",h=c.judgeModel||"";',
      statePatched: 'let[x,p]=(0,a.useState)(!1),u=c.fallbackStrategy||"fallback",h=c.judgeModel||"",v=c.autoRouter&&typeof c.autoRouter==="object"?c.autoRouter:{},A=(key,value)=>m({autoRouter:{...v,[key]:value}});',
      selector: '(0,l.jsx)(d.l6,{options:f,value:u,onChange:e=>m({fallbackStrategy:e.target.value}),selectClassName:"py-1.5 text-xs"})',
      level: 'u',
      autoCard: '"auto"===u&&(0,l.jsx)("div",{className:"mt-2 text-[11px] text-text-muted",children:"Auto Router"}),',
      jsx: 'l',
      config: 'v', update: 'A', combo: 'e',
      controls: '(0,l.jsxs)("div",{className:"mt-2 grid gap-2 text-xs",children:[(0,l.jsxs)("label",{className:"grid gap-1",children:["Easy target",(0,l.jsxs)("select",{className:"py-1.5 text-xs",value:v.easyTarget||"",onChange:t=>A("easyTarget",t.target.value),children:[(0,l.jsx)("option",{value:"",children:"Select combo"})...(v.easyTarget&&!q.some(t=>t.name===v.easyTarget&&t.strategy.fallbackStrategy!=="auto")?[(0,l.jsx)("option",{value:v.easyTarget,disabled:!0,children:`${v.easyTarget} (missing or Auto Router — unsupported target)`},v.easyTarget)]:[]),...q.filter(t=>t.name!==e.name&&t.strategy.fallbackStrategy!=="auto").map(t=>(0,l.jsx)("option",{value:t.name,children:t.name},t.name))]})]}),(0,l.jsxs)("label",{className:"grid gap-1",children:["Hard target",(0,l.jsxs)("select",{className:"py-1.5 text-xs",value:v.hardTarget||"",onChange:t=>A("hardTarget",t.target.value),children:[(0,l.jsx)("option",{value:"",children:"Select combo"})...(v.hardTarget&&!q.some(t=>t.name===v.hardTarget&&t.strategy.fallbackStrategy!=="auto")?[(0,l.jsx)("option",{value:v.hardTarget,disabled:!0,children:`${v.hardTarget} (missing or Auto Router — unsupported target)`},v.hardTarget)]:[]),...q.filter(t=>t.name!==e.name&&t.strategy.fallbackStrategy!=="auto").map(t=>(0,l.jsx)("option",{value:t.name,children:t.name},t.name))]})]}),(0,l.jsxs)("details",{className:"rounded border border-black/5 p-2 dark:border-white/10",children:[(0,l.jsx)("summary",{className:"cursor-pointer font-medium",children:"Advanced"}),(0,l.jsxs)("div",{className:"mt-2 grid gap-2",children:[(0,l.jsxs)("label",{className:"grid gap-1",children:["Hard threshold",(0,l.jsx)("input",{className:"py-1 text-xs",type:"number",min:1,defaultValue:v.hardThreshold||6,onBlur:t=>{const s=Number(t.target.value);if(Number.isSafeInteger(s)&&s>0)A("hardThreshold",s)}})]}),(0,l.jsxs)("label",{className:"grid gap-1",children:["Long context threshold (characters)",(0,l.jsx)("input",{className:"py-1 text-xs",type:"number",min:1,defaultValue:v.longContextChars||24000,onBlur:t=>{const s=Number(t.target.value);if(Number.isSafeInteger(s)&&s>0)A("longContextChars",s)}})]}),(0,l.jsxs)("label",{className:"grid gap-1",children:["Large tool-result threshold (characters)",(0,l.jsx)("input",{className:"py-1 text-xs",type:"number",min:1,defaultValue:v.largeToolResultChars||12000,onBlur:t=>{const s=Number(t.target.value);if(Number.isSafeInteger(s)&&s>0)A("largeToolResultChars",s)}})]}),(0,l.jsxs)("label",{className:"grid gap-1",children:["Many-tools threshold",(0,l.jsx)("input",{className:"py-1 text-xs",type:"number",min:1,defaultValue:v.manyTools||16,onBlur:t=>{const s=Number(t.target.value);if(Number.isSafeInteger(s)&&s>0)A("manyTools",s)}})]}),(0,l.jsxs)("label",{className:"flex items-center gap-2",children:[(0,l.jsx)("input",{type:"checkbox",checked:!!v.verbose,onChange:t=>A("verbose",t.target.checked)}),"Verbose logging"]})]})]})]})',
    };
    for (const [name, value] of [["component", spec.component], ["call", spec.call], ["state", spec.state], ["selector", spec.selector]]) if (count(source, value) !== 1) fail(`Auto Router UI semantic anchor is not unique (${name}):\n  ${path.relative(appRoot, target)}`);
    source = source.replace(spec.component, spec.componentPatched).replace(spec.call, spec.callPatched).replace(spec.state, spec.statePatched);
    const rendered = `(0,${spec.jsx}.jsxs)("div",{children:[${spec.selector},"auto"===${spec.level}&&${spec.controls}]})`;
    source = source.replace(spec.selector, rendered);
    const card = `"fusion"===${spec.level}&&`;
    if (count(source, card) !== 1) fail(`Auto Router card label anchor is not unique:\n  ${path.relative(appRoot, target)}`);
    source = source.replace(card, `${spec.autoCard}${card}`);
    source = source.replace(UI_ANCHOR, `${UI_PATCH}/* ${uiMarker} */`);
    if (count(source, uiMarker) !== 1 || !source.includes('label:"Auto Router"') || !source.includes("autoRouter") || !source.includes("availableCombos:")) fail(`UI patch integrity failed:\n  ${path.relative(appRoot, target)}`);
    fs.writeFileSync(target, source);
    changed = true;
  }
  return changed;
}

const runtime = discoverRuntimeCandidate();
const ui = discoverUiCandidates();
if (checkOnly) {
  dispatchAnchors(fs.readFileSync(runtime, "utf8"));
  console.log(`9Router Auto Router compatibility check passed: runtime=${path.relative(appRoot, runtime)} ui=${ui.map((file) => path.relative(appRoot, file)).join(",")}`);
} else {
  const runtimeChanged = patchRuntime(runtime);
  const uiChanged = patchUi(ui);
  console.log(`9Router Auto Router patch ${runtimeChanged || uiChanged ? "applied" : "already applied"}: runtime=${path.relative(appRoot, runtime)} ui=${ui.map((file) => path.relative(appRoot, file)).join(",")}`);
}
