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
function escapeRegex(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
// Structural boundaries: brace pairs with quotes and comments skipped, so discovery never
// depends on a fixed byte distance between the Fusion anchor and its bindings.
function delimiterPairs(source) {
  const pairs = [], stack = [], quoted = [];
  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (quoted.length) {
      if (char === "\\") { index += 1; continue; }
      if (char === quoted.at(-1)) quoted.pop();
      continue;
    }
    if (char === '"' || char === "'" || char === "`") { quoted.push(char); continue; }
    if (char === "/" && source[index + 1] === "/") { const end = source.indexOf("\n", index); index = end < 0 ? source.length : end; continue; }
    if (char === "/" && source[index + 1] === "*") { const end = source.indexOf("*/", index + 2); index = end < 0 ? source.length : end + 1; continue; }
    if (char === "{") stack.push(index);
    if (char === "}") {
      const open = stack.pop();
      if (open === undefined) return null;
      pairs.push({ open, close: index });
    }
  }
  return pairs;
}
function matchClosingParen(source, open) {
  let depth = 0, quote = null;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (quote) {
      if (char === "\\") { index += 1; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
    if (char === "(") depth += 1;
    if (char === ")" && --depth === 0) return index;
  }
  return -1;
}
function splitTopLevelProperties(content) {
  const properties = [];
  let start = 0, depth = 0, quote = null;
  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (quote) {
      if (char === "\\") { index += 1; continue; }
      if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'" || char === "`") { quote = char; continue; }
    if (char === "{" || char === "(" || char === "[") { depth += 1; continue; }
    if (char === "}" || char === ")" || char === "]") { depth -= 1; continue; }
    if (char === "," && depth === 0) { properties.push(content.slice(start, index)); start = index + 1; }
  }
  properties.push(content.slice(start));
  return properties;
}
// Parse the object literal that directly follows the matched Fusion branch. Property order
// and any extra trailing properties are irrelevant; only the named bindings matter.
function dispatchPayload(source, anchor) {
  const start = anchor.index + anchor[0].length;
  if (source.slice(start, start + 2) !== "({") return null;
  const end = matchClosingParen(source, start);
  if (end < 0) return null;
  const fields = new Map();
  for (const property of splitTopLevelProperties(source.slice(start + 2, end - 1))) {
    const separator = property.indexOf(":");
    if (separator <= 0) return null;
    const key = property.slice(0, separator).trim();
    if (fields.has(key)) return null;
    fields.set(key, property.slice(separator + 1).trim());
  }
  const body = fields.get("body"), models = fields.get("models"), handler = fields.get("handleSingleModel");
  if (!body || !models || !handler) return null;
  if (!/^[A-Za-z_$][\w$]*$/.test(body) || !/^[A-Za-z_$][\w$]*$/.test(models)) return null;
  const arrow = handler.match(/^\(([^()]*)\)=>([\s\S]*)$/);
  if (!arrow) return null;
  const returns = [...arrow[2].matchAll(/return ([A-Za-z_$][\w$]*)\(([^()]*)\)/g)];
  if (returns.length !== 1) return null;
  const forwarded = returns[0][2].split(",").map((value) => value.trim());
  if (forwarded.some((value) => !/^[A-Za-z_$][\w$]*$/.test(value))) return null;
  return { body, models, delegate: returns[0][1], forwarded, end };
}
// Associate the resolver, comboStrategies, settings, and enclosing `let` statement that
// belong to the same dispatch path: walk enclosing brace scopes, skip any scope where the
// data-flow pattern is not unique, and require every plan to be unambiguous.
function structuralPlan(source, anchor, target) {
  const payload = dispatchPayload(source, anchor);
  if (!payload || payload.body === payload.models) return null;
  const [, strategy, log, comboName] = anchor;
  const pairs = delimiterPairs(source);
  if (!pairs) fail(`Runtime handler has unbalanced structural delimiters:\n  ${path.relative(appRoot, target)}`);
  const resolverPattern = new RegExp(`${escapeRegex(payload.models)}=await \\(0,([A-Za-z_$][\\w$]*)\\.([A-Za-z_$][\\w$]*)\\)\\(${escapeRegex(comboName)}\\)`, "g");
  const strategyPattern = new RegExp(`(?:let |,)([A-Za-z_$][\\w$]*)=([A-Za-z_$][\\w$]*)\\.comboStrategies\\|\\|\\{\\},${escapeRegex(strategy)}=\\1\\[${escapeRegex(comboName)}\\]\\?\\.fallbackStrategy\\|\\|\\2\\.comboStrategy\\|\\|"fallback"`, "g");
  const candidates = [];
  for (const scope of pairs) {
    if (scope.open >= anchor.index || scope.close < payload.end) continue;
    const region = source.slice(scope.open + 1, scope.close);
    const resolvers = [...region.matchAll(resolverPattern)].filter((match) => scope.open + 1 + match.index < anchor.index);
    const bindings = [...region.matchAll(strategyPattern)].filter((match) => scope.open + 1 + match.index < anchor.index);
    if (resolvers.length !== 1 || bindings.length !== 1) continue;
    const resolver = resolvers[0], binding = bindings[0];
    const resolverIndex = scope.open + 1 + resolver.index;
    const statement = source.lastIndexOf("let ", resolverIndex);
    if (statement <= scope.open || statement > resolverIndex) continue;
    candidates.push({ resolver, resolverIndex, statement, strategies: binding[1], settings: binding[2] });
  }
  if (!candidates.length) return null;
  const signatures = new Map();
  for (const candidate of candidates) {
    const signature = [candidate.resolverIndex, candidate.strategies, candidate.settings, candidate.resolver[1], candidate.resolver[2], candidate.statement].join(":");
    if (!signatures.has(signature)) signatures.set(signature, candidate);
  }
  if (signatures.size !== 1) fail(`Runtime dispatch data-flow validation is ambiguous:\n  ${path.relative(appRoot, target)}\n\nExpected one resolver and combo-strategy binding structurally associated with the fusion dispatch.`);
  const candidate = [...signatures.values()][0];
  return { ...payload, anchor: anchor[0], strategy, log, comboName, resolver: candidate.resolver, strategies: candidate.strategies, settings: candidate.settings, statement: candidate.statement };
}
function verifyPatchedRuntime(target, source = fs.readFileSync(target, "utf8")) {
  if (count(source, runtimeMarker) !== 1 || count(source, "routeAutoCombo") !== 2) fail(`Patched runtime handler integrity failed:\n  ${path.relative(appRoot, target)}`);
}
function runtimePlans(source, target) {
  const anchors = dispatchAnchors(source);
  const plans = anchors.map((anchor) => structuralPlan(source, anchor, target));
  if (plans.some((plan) => !plan)) fail(`Runtime dispatch data-flow validation failed:\n  ${path.relative(appRoot, target)}\n\nExpected body, models resolver, comboStrategies, settings, and single-model dispatch in one structural dispatch path.`);
  if (new Set(plans.map((plan) => plan.models)).size !== plans.length) fail(`Runtime dispatch data-flow validation is ambiguous:\n  ${path.relative(appRoot, target)}\n\nFusion dispatches must have distinct model bindings.`);
  return plans;
}
function patchRuntime(target) {
  let source = fs.readFileSync(target, "utf8");
  if (source.includes(runtimeMarker)) {
    verifyPatchedRuntime(target, source);
    return false;
  }
  const plans = runtimePlans(source, target);
  source = `/* ${runtimeMarker} */${source}`;
  for (const plan of plans.sort((left, right) => right.statement - left.statement)) {
    const capture = `_arResolve${plan.models}`;
    if (source.includes(capture)) fail(`Runtime dispatch data-flow validation failed:\n  ${path.relative(appRoot, target)}\n\nUnexpected resolver capture name collision.`);
    const insertion = plan.statement + `/* ${runtimeMarker} */`.length;
    source = `${source.slice(0, insertion)}const ${capture}=(0,${plan.resolver[1]}.${plan.resolver[2]});${source.slice(insertion)}`;
    const anchorIndex = source.indexOf(plan.anchor);
    if (anchorIndex < 0) fail(`Runtime dispatch anchor disappeared while patching:\n  ${path.relative(appRoot, target)}`);
    const forwarded = [...plan.forwarded];
    if (forwarded.length < 2) fail(`Runtime dispatch data-flow validation failed:\n  ${path.relative(appRoot, target)}\n\nSingle-model dispatch forwards insufficient arguments.`);
    forwarded[0] = "nextBody"; forwarded[1] = "target";
    const patch = `if("auto"===${plan.strategy})return require("/opt/9router-auto-router/auto-router.cjs").routeAutoCombo({body:${plan.body},comboName:${plan.comboName},comboStrategies:${plan.strategies},globalStrategy:${plan.settings}.comboStrategy,log:${plan.log},targetExists:async(name)=>Boolean(await ${capture}(name)),delegate:(nextBody,target)=>${plan.delegate}(${forwarded.join(",")})});`;
    source = `${source.slice(0, anchorIndex)}${patch}${source.slice(anchorIndex)}`;
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
function verifyPatchedUi(target, source = fs.readFileSync(target, "utf8")) {
  if (count(source, uiMarker) !== 1 || count(source, 'label:"Auto Router"') !== 1 || count(source, "autoRouter") < 2 || count(source, "availableCombos:") !== 2) fail(`Patched UI integrity failed:\n  ${path.relative(appRoot, target)}`);
}
function uniqueMatch(source, expression, name, target) {
  const matches = [...source.matchAll(expression)];
  if (matches.length !== 1) fail(`Auto Router UI semantic anchor is not unique (${name}):\n  ${path.relative(appRoot, target)}\n\nExpected exactly 1; found ${matches.length}.`);
  return matches[0];
}
function escapePattern(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function uiPatchSpec(source, target) {
  const selector = uniqueMatch(source, /\(0,([A-Za-z_$][\w$]*)\.jsx\)\(([A-Za-z_$][\w$]*\.[A-Za-z_$][\w$]*),\{options:([A-Za-z_$][\w$]*),value:([A-Za-z_$][\w$]*),onChange:([A-Za-z_$][\w$]*)=>([A-Za-z_$][\w$]*)\(\{fallbackStrategy:\5\.target\.value\}\),selectClassName:"py-1\.5 text-xs"\}\)/g, "strategy selector", target);
  const [selectorText, jsx, , , level, , update] = selector;
  const state = uniqueMatch(source, new RegExp(`(?:let|const)\\b[^;]*?,${escapePattern(level)}=([A-Za-z_$][\\w$]*)\\.fallbackStrategy\\|\\|"fallback",[A-Za-z_$][\\w$]*=\\1\\.judgeModel\\|\\|"";`, "g"), "strategy state", target);
  const strategy = state[1];
  const react = uniqueMatch(state[0], /\(0,([A-Za-z_$][\w$]*)\.useState\)\(/g, "React state hook", target)[1];
  const propCandidates = [...source.matchAll(/function\s+[A-Za-z_$][\w$]*\(\{([\s\S]*?)\}\)\{/g)].filter((match) => {
    const props = match[1];
    return new RegExp(`(?:^|,)combo:([A-Za-z_$][\\w$]*)(?:,|$)`).test(props)
      && new RegExp(`(?:^|,)strategy:${escapePattern(strategy)}=\\{\\}(?:,|$)`).test(props)
      && new RegExp(`(?:^|,)onSetStrategy:${escapePattern(update)}(?:,|$)`).test(props);
  });
  if (propCandidates.length !== 1) fail(`Auto Router UI semantic component is ambiguous:\n  ${path.relative(appRoot, target)}\n\nExpected exactly 1 component connected to the selector's strategy/update data flow; found ${propCandidates.length}.`);
  const props = propCandidates[0][1];
  const combo = new RegExp(`(?:^|,)combo:([A-Za-z_$][\\w$]*)(?:,|$)`).exec(props)?.[1];
  if (!combo) fail(`Auto Router UI component is missing its combo binding:\n  ${path.relative(appRoot, target)}`);
  const call = uniqueMatch(source, new RegExp(`strategy:([A-Za-z_$][\\w$]*)\\[${escapePattern(combo)}\\.name\\]\\|\\|\\{\\},onSetStrategy:([A-Za-z_$][\\w$]*)=>[A-Za-z_$][\\w$]*\\(${escapePattern(combo)}\\.name,\\2\\)`, "g"), "combo collection call", target);
  const [, collectionStrategies, callEvent] = call;
  const card = uniqueMatch(source, new RegExp(`"fusion"===${escapePattern(level)}&&`, "g"), "fusion card", target)[0];
  if (["_arConfig", "_arUpdate", "_arCombos", "_arHard"].some((name) => source.includes(name))) fail(`Auto Router UI generated binding collision:\n  ${path.relative(appRoot, target)}`);
  return { selectorText, jsx, level, update, stateText: state[0], strategy, react, componentText: propCandidates[0][0], combo, callText: call[0], collectionStrategies, callEvent, card };
}
function controls(spec) {
  const input = (label, state, setter, key, fallback, hint = "") => `(0,${spec.jsx}.jsxs)("label",{className:"grid gap-1",children:["${label}${hint}",(0,${spec.jsx}.jsx)("input",{className:"py-1 text-xs",type:"number",min:1,value:${state},onChange:event=>${setter}(event.target.value),onBlur:event=>{const value=Number(event.target.value);if(Number.isSafeInteger(value)&&value>0)_arUpdate("${key}",value);else ${setter}(String(_arConfig.${key}||${fallback}))}})]})`;
  const target = (label, key) => `(0,${spec.jsx}.jsxs)("label",{className:"grid gap-1",children:["${label}",(0,${spec.jsx}.jsxs)("select",{className:"py-1.5 text-xs",value:_arConfig.${key}||"",onChange:event=>_arUpdate("${key}",event.target.value),children:[(0,${spec.jsx}.jsx)("option",{value:"",children:"Select combo"}),...(_arConfig.${key}&&!_arCombos.some(entry=>entry.name===_arConfig.${key}&&entry.strategy.fallbackStrategy!=="auto")?[(0,${spec.jsx}.jsx)("option",{value:_arConfig.${key},disabled:!0,children:_arConfig.${key}+" (missing or Auto Router — unsupported target)"},_arConfig.${key})]:[]),..._arCombos.filter(entry=>entry.name!==${spec.combo}.name&&entry.strategy.fallbackStrategy!=="auto").map(entry=>(0,${spec.jsx}.jsx)("option",{value:entry.name,children:entry.name},entry.name))]})]})`;
  return `(0,${spec.jsx}.jsxs)("div",{className:"mt-2 grid gap-2 text-xs",children:[${target("Easy target", "easyTarget")},${target("Hard target", "hardTarget")},(0,${spec.jsx}.jsxs)("details",{className:"rounded border border-black/5 p-2 dark:border-white/10",children:[(0,${spec.jsx}.jsx)("summary",{className:"cursor-pointer font-medium",children:"Advanced"}),(0,${spec.jsx}.jsxs)("div",{className:"mt-2 grid gap-2",children:[${input("Hard threshold", "_arHard", "_arSetHard", "hardThreshold", 6, " (default 6; recommended 4–10)")},${input("Long context threshold (characters)", "_arContext", "_arSetContext", "longContextChars", 24000, " (default 24000)")},${input("Large tool-result threshold (characters)", "_arToolResult", "_arSetToolResult", "largeToolResultChars", 12000, " (default 12000)")},${input("Many-tools threshold", "_arTools", "_arSetTools", "manyTools", 16, " (default 16)")},(0,${spec.jsx}.jsxs)("label",{className:"flex items-center gap-2",children:[(0,${spec.jsx}.jsx)("input",{type:"checkbox",checked:!!_arConfig.verbose,onChange:event=>_arUpdate("verbose",event.target.checked)}),"Verbose logging"]})]})]})]})`;
}
function patchUi(targets) {
  let changed = false;
  for (const target of targets) {
    let source = fs.readFileSync(target, "utf8");
    if (source.includes(uiMarker)) {
      verifyPatchedUi(target, source);
      continue;
    }
    if (count(source, UI_ANCHOR) !== 1) fail(`UI strategy anchor is not unique:\n  ${path.relative(appRoot, target)}`);
    const spec = uiPatchSpec(source, target);
    const componentPatched = spec.componentText.replace(`onSetStrategy:${spec.update}`, `onSetStrategy:${spec.update},availableCombos:_arCombos=[]`);
    if (componentPatched === spec.componentText) fail(`Auto Router UI component props could not be extended:\n  ${path.relative(appRoot, target)}`);
    const callPatched = `availableCombos:${spec.combo}.map(${spec.callEvent}=>({name:${spec.callEvent}.name,strategy:${spec.collectionStrategies}[${spec.callEvent}.name]||{}})),${spec.callText}`;
    const statePatched = `${spec.stateText}const _arConfig=${spec.strategy}.autoRouter&&typeof ${spec.strategy}.autoRouter==="object"?${spec.strategy}.autoRouter:{},_arUpdate=(key,value)=>${spec.update}({autoRouter:{..._arConfig,[key]:value}}),[_arHard,_arSetHard]=(0,${spec.react}.useState)(String(_arConfig.hardThreshold||6)),[_arContext,_arSetContext]=(0,${spec.react}.useState)(String(_arConfig.longContextChars||24000)),[_arToolResult,_arSetToolResult]=(0,${spec.react}.useState)(String(_arConfig.largeToolResultChars||12000)),[_arTools,_arSetTools]=(0,${spec.react}.useState)(String(_arConfig.manyTools||16));(0,${spec.react}.useEffect)(()=>{_arSetHard(String(_arConfig.hardThreshold||6));_arSetContext(String(_arConfig.longContextChars||24000));_arSetToolResult(String(_arConfig.largeToolResultChars||12000));_arSetTools(String(_arConfig.manyTools||16));},[_arConfig.hardThreshold,_arConfig.longContextChars,_arConfig.largeToolResultChars,_arConfig.manyTools]);`;
    const rendered = `(0,${spec.jsx}.jsxs)("div",{children:[${spec.selectorText},"auto"===${spec.level}&&${controls(spec)}]})`;
    source = source.replace(spec.componentText, componentPatched).replace(spec.callText, callPatched).replace(spec.stateText, statePatched).replace(spec.selectorText, rendered).replace(spec.card, `"auto"===${spec.level}&&(0,${spec.jsx}.jsx)("div",{className:"mt-2 text-[11px] text-text-muted",children:"Auto Router"}),${spec.card}`).replace(UI_ANCHOR, `${UI_PATCH}/* ${uiMarker} */`);
    verifyPatchedUi(target, source);
    fs.writeFileSync(target, source);
    changed = true;
  }
  return changed;
}


const runtime = discoverRuntimeCandidate();
const ui = discoverUiCandidates();
if (checkOnly) {
  const runtimeSource = fs.readFileSync(runtime, "utf8");
  if (runtimeSource.includes(runtimeMarker)) verifyPatchedRuntime(runtime, runtimeSource);
  else runtimePlans(runtimeSource, runtime);
  for (const target of ui) {
    const source = fs.readFileSync(target, "utf8");
    if (source.includes(uiMarker)) verifyPatchedUi(target, source);
    else uiPatchSpec(source, target);
  }
  console.log(`9Router Auto Router compatibility check passed: runtime=${path.relative(appRoot, runtime)} ui=${ui.map((file) => path.relative(appRoot, file)).join(",")}`);
} else {
  const runtimeChanged = patchRuntime(runtime);
  const uiChanged = patchUi(ui);
  console.log(`9Router Auto Router patch ${runtimeChanged || uiChanged ? "applied" : "already applied"}: runtime=${path.relative(appRoot, runtime)} ui=${ui.map((file) => path.relative(appRoot, file)).join(",")}`);
}
