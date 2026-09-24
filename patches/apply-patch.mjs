import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { DEFAULTS, NUMERIC_BOUNDS } = require("../auto-router-config.cjs");

const appRoot = process.argv[2] || "/app";
const checkOnly = process.argv.includes("--check");
const runtimeMarker = "9router-auto-router:v3";
const uiMarker = "9router-auto-router-ui:v9";
const numericBounds = Object.freeze(Object.fromEntries(Object.entries(NUMERIC_BOUNDS).map(([key, { min, max }]) => [key, Object.freeze([min, max])])));

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
    const patch = `if("auto"===${plan.strategy})return require("/opt/9router-auto-router/auto-router.cjs").routeAutoCombo({body:${plan.body},comboName:${plan.comboName},comboStrategies:${plan.strategies},globalStrategy:${plan.settings}.comboStrategy,models:${plan.models},log:${plan.log},targetExists:async(name)=>Boolean(await ${capture}(name)),delegate:(nextBody,target)=>${plan.delegate}(${forwarded.join(",")})});`;
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
    return source.includes("Group models under one name");
  });
  if (candidates.length !== 2) fail(`Combo UI strategy asset candidates:\n  ${candidates.length}\n\nCandidate files:\n  ${relative(candidates)}\n\nExpected:\n  exactly 2 (server and client assets)\n\nRequired semantic anchors:\n  Group models under one name`);
  return candidates;
}
// The derived image does not ship a top-level acorn install; upstream bundles one under
// Next.js. Resolve a parser from the project first (npm ci) and fall back to the upstream
// copy so `RUN node apply-patch.mjs /app` keeps working without enlarging the build context.
let parser;
function loadParser() {
  if (parser) return parser;
  for (const candidate of ["acorn", path.join(appRoot, "node_modules/next/dist/compiled/acorn"), "/app/node_modules/next/dist/compiled/acorn"]) {
    try {
      const loaded = require(candidate);
      if (typeof loaded.parse === "function") { parser = loaded.parse; return parser; }
    } catch { /* try the next candidate */ }
  }
  fail("No JavaScript parser (acorn) is available for the Combo UI transformation.");
}
function parseJavaScript(source, target) {
  try { return loadParser()(source, { ecmaVersion: "latest", sourceType: "script", ranges: true }); }
  catch (error) { fail(`Combo UI JavaScript cannot be parsed:\n  ${path.relative(appRoot, target)}\n\n${error.message}`); }
}
function walkAst(node, parent = null, visit = () => {}) {
  if (!node || typeof node !== "object" || !node.type) return;
  visit(node, parent);
  for (const [key, value] of Object.entries(node)) {
    if (["parent", "start", "end", "loc", "range"].includes(key)) continue;
    if (Array.isArray(value)) for (const item of value) walkAst(item, node, visit);
    else walkAst(value, node, visit);
  }
}
function keyName(item) { return item?.key?.type === "Identifier" ? item.key.name : item?.key?.value; }
function objectProperty(object, name) { return object?.properties?.find((entry) => keyName(entry) === name); }
function identifier(node) { return node?.type === "Identifier" ? node.name : null; }
function unchain(node) { return node?.type === "ChainExpression" ? node.expression : node; }
function literal(node, value) { return unchain(node)?.type === "Literal" ? unchain(node).value === value : false; }
// Accept both jsx and jsxs runtime exports; upstream emits jsxs for multi-child elements.
function jsxCall(node) { return node?.type === "CallExpression" && node.callee?.type === "SequenceExpression" && node.callee.expressions.length === 2 && node.callee.expressions[0].type === "Literal" && node.callee.expressions[0].value === 0 && node.callee.expressions[1].type === "MemberExpression" && ["jsx", "jsxs"].includes(node.callee.expressions[1].property?.name); }
function one(items, name, target) {
  if (items.length !== 1) fail(`Auto Router UI semantic anchor is not unique (${name}):\n  ${path.relative(appRoot, target)}\n\nExpected exactly 1; found ${items.length}.`);
  return items[0];
}
function functionDeclarations(ast) { const found = []; walkAst(ast, null, (node) => { if (node.type === "FunctionDeclaration") found.push(node); }); return found; }
function literals(node) { const values = new Set(); walkAst(node, null, (entry) => { if (entry.type === "Literal") values.add(entry.value); }); return values; }
function hasLiterals(fn, values) { const found = literals(fn.body); return values.every((value) => found.has(value)); }
function hasAnyLiteral(fn, values) { const found = literals(fn.body); return values.some((value) => found.has(value)); }
function variableDeclarators(fn) { const found = []; walkAst(fn.body, null, (node, parent) => { if (node.type === "VariableDeclarator") found.push({ node, parent }); }); return found; }
function functionParam(fn, name) {
  const item = fn.params[0]?.properties?.find((entry) => keyName(entry) === name);
  return identifier(item?.value) || identifier(item?.value?.left);
}
function memberObject(node) { const current = unchain(node); if (current?.type === "LogicalExpression") return memberObject(current.left); if (current?.type === "MemberExpression") return identifier(current.object); return null; }
function memberProperty(node) { return unchain(node)?.type === "MemberExpression" ? unchain(node).property?.name : null; }
function stateBinding(fn, propertyName, target) {
  const candidate = one(variableDeclarators(fn).filter(({ node }) => {
    const init = node.init;
    const first = unchain(init?.arguments?.[0]);
    return node.id?.type === "ArrayPattern" && init?.type === "CallExpression" && init.callee?.type === "SequenceExpression" && init.callee.expressions.at(-1)?.property?.name === "useState" && first?.type === "LogicalExpression" && memberProperty(first.left) === propertyName;
  }), `${propertyName} state`, target);
  return { value: identifier(candidate.node.id.elements[0]), setter: identifier(candidate.node.id.elements[1]), react: identifier(candidate.node.init.callee.expressions.at(-1).object), initial: candidate.node.init.arguments[0] };
}
function calledWithBinding(node, binding) {
  let found = false;
  walkAst(node, null, (entry) => { if (entry.type === "CallExpression" && identifier(entry.callee) === binding) found = true; });
  return found;
}
function validateStrategyOptions(array, target) {
  if (array?.type !== "ArrayExpression" || !array.elements.length || array.elements.some((entry) => entry?.type !== "ObjectExpression")) fail(`Auto Router UI strategy options are structurally incompatible:\n  ${path.relative(appRoot, target)}`);
  const options = array.elements.map((entry) => {
    const value = objectProperty(entry, "value")?.value, label = objectProperty(entry, "label")?.value;
    if (value?.type !== "Literal" || typeof value.value !== "string" || !value.value || label?.type !== "Literal" || typeof label.value !== "string" || !label.value) fail(`Auto Router UI strategy option is structurally incompatible:\n  ${path.relative(appRoot, target)}`);
    return { value: value.value, label: label.value };
  });
  if (new Set(options.map((option) => option.value)).size !== options.length || !["fallback", "round-robin", "fusion"].every((value) => options.some((option) => option.value === value))) fail(`Auto Router UI strategy options are semantically incompatible:\n  ${path.relative(appRoot, target)}\n\nExpected valid fallback, round-robin, and fusion options.`);
}
function resolveStrategyOptions(ast, selector, target) {
  const expression = objectProperty(selector.arguments[1], "options")?.value;
  let array = expression;
  if (expression?.type === "Identifier") {
    const declaration = one((() => { const matches = []; walkAst(ast, null, (node, parent) => { if (node.type === "VariableDeclarator" && identifier(node.id) === expression.name) matches.push({ node, parent }); }); return matches; })(), "strategy options binding", target);
    array = declaration.node.init;
  }
  validateStrategyOptions(array, target);
  return { expression, array };
}
function validateRanges(replacements, target) {
  const ordered = [...replacements].sort((left, right) => left.start - right.start);
  for (let index = 1; index < ordered.length; index += 1) if (ordered[index - 1].end > ordered[index].start) fail(`Auto Router UI replacements overlap:\n  ${path.relative(appRoot, target)}`);
}
function replaceRanges(source, replacements, target) {
  validateRanges(replacements, target);
  for (const replacement of [...replacements].sort((left, right) => right.start - left.start)) source = `${source.slice(0, replacement.start)}${replacement.text}${source.slice(replacement.end)}`;
  return source;
}
function controls(jsx, models) {
  const input = (label, state, setter, key, fallback, hint = "") => { const [min, max] = numericBounds[key]; return `(0,${jsx}.jsxs)("label",{className:"grid gap-1",children:["${label}${hint}",(0,${jsx}.jsx)("input",{className:"py-1 text-xs",type:"number",min:${min},max:${max},value:${state},onChange:event=>${setter}(event.target.value),onBlur:event=>{const value=_arNumber(event.target.value,"${key}",${fallback});_arUpdate("${key}",value),${setter}(String(value))}})]})`; };
  return `"auto"===_arInitialStrategy.fallbackStrategy&&(0,${jsx}.jsxs)("section",{className:"grid gap-2 text-xs",children:[(0,${jsx}.jsx)("p",{className:"font-medium text-text-main",children:"Auto Router"}),(0,${jsx}.jsx)("p",{className:"text-text-muted",children:"Requests are routed between the first two models."}),0===${models}.length?(0,${jsx}.jsx)("p",{className:"rounded border border-amber-500/30 bg-amber-500/10 p-2 text-text-main",children:"Add two distinct models: position 1 is Easy and position 2 is Hard."}):(0,${jsx}.jsx)("div",{className:"grid gap-1",children:${models}.map((model,index)=>(0,${jsx}.jsxs)("div",{className:"flex items-center gap-2 rounded border border-black/5 px-2 py-1 dark:border-white/10",children:[(0,${jsx}.jsx)("span",{className:"w-4 text-text-muted",children:index+1}),(0,${jsx}.jsx)("span",{className:"min-w-0 flex-1 truncate",children:model}),(0,${jsx}.jsx)("span",{className:"rounded bg-black/5 px-1.5 py-0.5 font-medium dark:bg-white/10",children:0===index?"Easy":1===index?"Hard":"Ignored"})]},index))}),(0,${jsx}.jsx)("p",{className:"text-text-muted",children:"1 = Easy · 2 = Hard · Models after position 2 are ignored by Auto Router."}),_arLegacyMigration&&(0,${jsx}.jsx)("p",{className:"text-text-muted",children:"Legacy targets remain effective until this model order is saved."}),(0,${jsx}.jsxs)("details",{className:"rounded border border-black/5 p-2 dark:border-white/10",children:[(0,${jsx}.jsx)("summary",{className:"cursor-pointer font-medium",children:"Advanced"}),(0,${jsx}.jsxs)("div",{className:"mt-2 grid gap-2",children:[${input("Hard threshold", "_arHard", "_arSetHard", "hardThreshold", DEFAULTS.hardThreshold, ` (default ${DEFAULTS.hardThreshold}; recommended 4–10; supported 1–100)`)},${input("Long context threshold (characters)", "_arContext", "_arSetContext", "longContextChars", DEFAULTS.longContextChars, ` (default ${DEFAULTS.longContextChars}; supported 1–10000000)`)},${input("Large tool-result threshold (characters)", "_arToolResult", "_arSetToolResult", "largeToolResultChars", DEFAULTS.largeToolResultChars, ` (default ${DEFAULTS.largeToolResultChars}; supported 1–10000000)`)},${input("Many-tools threshold", "_arTools", "_arSetTools", "manyTools", DEFAULTS.manyTools, ` (default ${DEFAULTS.manyTools}; supported 1–10000)`)},(0,${jsx}.jsxs)("label",{className:"flex items-center gap-2",children:[(0,${jsx}.jsx)("input",{type:"checkbox",checked:!!_arConfig.verbose,onChange:event=>_arUpdate("verbose",event.target.checked)}),"Verbose logging"]})]})]})]})`;
}
function discoverUiStructure(source, target) {
  const ast = parseJavaScript(source, target), functions = functionDeclarations(ast);
  const cardCandidates = functions.filter((fn) => hasLiterals(fn, ["Edit"]) && functionParam(fn, "combo") && functionParam(fn, "strategy") && functionParam(fn, "onSetStrategy"));
  const card = one(cardCandidates, "ComboCard component", target);
  const setStrategy = functionParam(card, "onSetStrategy");
  const selector = one((() => { const calls = []; walkAst(card.body, null, (node) => { if (!jsxCall(node)) return; const onChange = objectProperty(node.arguments[1], "onChange")?.value; if (objectProperty(node.arguments[1], "options") && onChange && calledWithBinding(onChange, setStrategy)) calls.push(node); }); return calls; })(), "ComboCard strategy selector", target);
  const options = resolveStrategyOptions(ast, selector, target);
  const optionReference = source.slice(options.expression.start, options.expression.end), optionArray = source.slice(options.array.start, options.array.end);
  const jsx = identifier(selector.callee.expressions[1].object), select = source.slice(selector.arguments[0].start, selector.arguments[0].end);
  const cardStrategyDeclarator = one([...variableDeclarators(card)].filter(({ node }) => unchain(node.init)?.type === "LogicalExpression" && memberProperty(unchain(node.init).left) === "fallbackStrategy"), "ComboCard strategy state", target);
  const cardStrategy = identifier(cardStrategyDeclarator.node.id);
  const modal = one(functions.filter((fn) => hasLiterals(fn, ["Edit Combo", "Combo Name", "Models", "Add Model", "Cancel", "Save"])), "Edit Combo component", target);
  const modalSave = functionParam(modal, "onSave"), modalCombo = functionParam(modal, "combo"), modalKind = functionParam(modal, "kindFilter");
  if (!modalSave || !modalCombo || !modalKind) fail(`Auto Router UI Edit Combo component data flow is incompatible:\n  ${path.relative(appRoot, target)}`);
  const name = stateBinding(modal, "name", target), models = stateBinding(modal, "models", target);
  const modalStateStatement = one(modal.body.body.filter((statement) => statement.type === "VariableDeclaration" && statement.declarations.some((declaration) => declaration.id?.type === "ArrayPattern" && declaration.init?.arguments?.[0]?.type === "ObjectExpression")), "Edit Combo state declaration", target);
  const saveDeclarator = one(variableDeclarators(modal).filter(({ node }) => node.init?.type === "ArrowFunctionExpression" && source.slice(node.init.start, node.init.end).includes(`await ${modalSave}({name:${name.value}.trim(),models:${models.value}})`)), "Edit Combo Save handler", target);
  // Derive the name validator and the "saving" flag setter from the upstream Save callback
  // itself so generated code keeps upstream validation and duplicate-submission protection.
  let validator = null, savingSetter = null;
  walkAst(saveDeclarator.node.init, null, (node, parent) => {
    if (node.type !== "CallExpression" || node.callee?.type !== "Identifier") return;
    const argument = node.arguments?.[0];
    if (argument?.type === "Identifier" && argument.name === name.value && parent?.type === "LogicalExpression") validator = node.callee.name;
    if (argument?.type === "UnaryExpression" && argument.operator === "!") savingSetter = node.callee.name;
  });
  if (!validator || !savingSetter) fail(`Auto Router UI Edit Combo validation data flow is incompatible:\n  ${path.relative(appRoot, target)}`);
  const footer = one((() => { const calls = []; walkAst(modal.body, null, (node) => { if (node.type === "CallExpression" && objectProperty(node.arguments[1], "className")?.value?.value === "flex flex-col gap-2 pt-1 sm:flex-row") calls.push(node); }); return calls; })(), "Edit Combo footer", target);
  const parent = one(functions.filter((fn) => fn !== card && fn !== modal && [...literals(fn)].some((value) => typeof value === "string" && value.startsWith("Group models under one name"))), "combo collection component", target);
  const invocation = one((() => { const calls = []; walkAst(parent.body, null, (node) => { if (jsxCall(node) && identifier(node.arguments[0]) === modal.id.name && objectProperty(node.arguments[1], "combo")) calls.push(node); }); return calls; })(), "Edit Combo invocation", target);
  const invocationProps = invocation.arguments[1], edited = objectProperty(invocationProps, "combo")?.value?.name, onSave = objectProperty(invocationProps, "onSave")?.value;
  if (!edited || onSave?.type !== "ArrowFunctionExpression" || onSave.body?.type !== "CallExpression") fail(`Auto Router UI Edit Combo invocation data flow is incompatible:\n  ${path.relative(appRoot, target)}`);
  const update = identifier(onSave.body.callee);
  const updateDeclarator = one(variableDeclarators(parent).filter(({ node }) => node.id?.name === update && node.init?.type === "ArrowFunctionExpression" && source.slice(node.init.start, node.init.end).includes("/api/combos/")), "combo Save handler", target);
  const refresh = one([...source.slice(updateDeclarator.node.init.start, updateDeclarator.node.init.end).matchAll(/await ([A-Za-z_$][\w$]*)\(\),[A-Za-z_$][\w$]*\(null\)/g)], "combo Save close path", target)[1];
  const close = source.slice(invocation.start, invocation.end).match(/onClose:\(\)=>([A-Za-z_$][\w$]*)\(null\)/)?.[1];
  const cardInvocation = one((() => { const calls = []; walkAst(parent.body, null, (node) => { if (jsxCall(node) && identifier(node.arguments[0]) === card.id.name && objectProperty(node.arguments[1], "strategy")) calls.push(node); }); return calls; })(), "ComboCard invocation", target);
  const strategies = memberObject(objectProperty(cardInvocation.arguments[1], "strategy")?.value), onSetStrategy = objectProperty(cardInvocation.arguments[1], "onSetStrategy")?.value, cardCombo = identifier(objectProperty(cardInvocation.arguments[1], "combo")?.value);
  const cardStrategyChange = identifier(onSetStrategy?.params?.[0]), strategyUpdate = identifier(onSetStrategy?.body?.callee), [strategyComboName, strategyChange] = onSetStrategy?.body?.arguments || [];
  if (onSetStrategy?.type !== "ArrowFunctionExpression" || onSetStrategy.params.length !== 1 || onSetStrategy.body?.type !== "CallExpression" || onSetStrategy.body.arguments.length !== 2 || !cardCombo || !cardStrategyChange || !strategyUpdate || strategyComboName?.type !== "MemberExpression" || strategyComboName.computed || identifier(strategyComboName.object) !== cardCombo || strategyComboName.property?.name !== "name" || identifier(strategyChange) !== cardStrategyChange) fail(`Auto Router UI strategy persistence callback is incompatible:\n  ${path.relative(appRoot, target)}`);
  one(variableDeclarators(parent).filter(({ node }) => node.id?.name === strategyUpdate && node.init?.type === "ArrowFunctionExpression" && node.init.params.length === 2 && node.init.params.every((param) => identifier(param))), "combo strategy update handler", target);
  let map = null; walkAst(parent.body, null, (node) => { if (node.type === "CallExpression" && node.callee?.type === "MemberExpression" && node.callee.property?.name === "map" && node.arguments.some((argument) => argument.start <= cardInvocation.start && argument.end >= cardInvocation.end)) map = node; });
  const combos = identifier(map?.callee?.object);
  const explanation = one((() => { const nodes = []; walkAst(parent.body, null, (node) => { if (node.type === "CallExpression" && jsxCall(node) && literal(node.arguments[0], "ul") && node.arguments[1]?.properties?.some((item) => keyName(item) === "children" && item.value?.type === "ArrayExpression" && item.value.elements.some((element) => element && [...literals(element)].some((value) => value === "Fusion")))) nodes.push(node); }); return nodes; })(), "strategy explanation list", target);
  const explanationItems = objectProperty(explanation.arguments[1], "children").value;
  if (explanationItems?.type !== "ArrayExpression" || !["Fallback", "Round Robin", "Fusion"].every((value) => [...literals(explanationItems)].includes(value))) fail(`Auto Router UI strategy explanations are semantically incompatible:\n  ${path.relative(appRoot, target)}`);
  const explanationItem = explanationItems.elements.at(-1);
  if (!explanationItem) fail(`Auto Router UI strategy explanations are structurally incompatible:\n  ${path.relative(appRoot, target)}`);
  if (!strategies || !combos || !close) fail(`Auto Router UI parent settings data flow is incompatible:\n  ${path.relative(appRoot, target)}`);
  if (["_arInitialStrategy", "_arAvailableCombos", "_arStrategyOptions", "_arSave", "_arSetStrategy"].some((binding) => source.includes(binding))) fail(`Auto Router UI generated binding collision:\n  ${path.relative(appRoot, target)}`);
  return { options, optionReference, optionArray, card, cardStrategy, selector, jsx, select, modal, modalSave, modalCombo, name, models, validator, savingSetter, modalStateStatement, saveDeclarator, footer, parent, invocation, edited, onSave, update, updateDeclarator, refresh, close, strategies, combos, explanation, explanationItem, onSetStrategy, cardCombo, cardStrategyChange: identifier(onSetStrategy.params[0]) };
}
function verifyPatchedUi(target, source = fs.readFileSync(target, "utf8")) {
  const ast = parseJavaScript(source, target), functions = functionDeclarations(ast);
  if (count(source, uiMarker) !== 1 || count(source, 'label:"Auto Router"') !== 1 || !source.includes("onSave:_arSave")) fail(`Patched UI integrity failed:
  ${path.relative(appRoot, target)}`);
  const modal = one(functions.filter((fn) => hasLiterals(fn, ["Edit Combo", "Models", "Add Model", "Cancel", "Save"])), "patched Edit Combo component", target);
  if (!hasLiterals(modal, ["Auto Router", "Easy", "Hard", "Ignored", "Advanced"]) || hasLiterals(modal, ["Easy target", "Hard target", "Strategy"])) fail(`Patched UI model-order settings are incompatible:
  ${path.relative(appRoot, target)}`);
  if (!functionParam(modal, "strategy")) fail(`Patched Edit Combo data flow is incompatible:
  ${path.relative(appRoot, target)}`);
  const card = one(functions.filter((fn) => functionParam(fn, "combo") && functionParam(fn, "onSetStrategy")), "patched ComboCard component", target);
  if (hasAnyLiteral(card, ["Auto Router Settings", "Easy target", "Hard target", "Advanced"])) fail(`Patched UI Auto Router controls leaked into the combo card:
  ${path.relative(appRoot, target)}`);
}

function applyUiPlan(source, plan, target) {
  const modalParams = source.slice(plan.modal.params[0].start, plan.modal.params[0].end);
  const expandedParams = `${modalParams.slice(0, -1)},strategy:_arInitialStrategy={}}`;
  const serializedBounds = Object.entries(numericBounds).map(([key, bounds]) => `${key}:${JSON.stringify(bounds)}`).join(",");
  const modelInitial = source.slice(plan.models.initial.start, plan.models.initial.end);
  const legacySetup = `const _arSavedConfig=_arInitialStrategy.autoRouter&&typeof _arInitialStrategy.autoRouter==="object"?_arInitialStrategy.autoRouter:{},_arLegacyTargets=typeof _arSavedConfig.easyTarget==="string"&&_arSavedConfig.easyTarget.trim()&&typeof _arSavedConfig.hardTarget==="string"&&_arSavedConfig.hardTarget.trim()&&_arSavedConfig.easyTarget.trim()!==_arSavedConfig.hardTarget.trim(),_arLegacyMigration="auto"===_arInitialStrategy.fallbackStrategy&&_arLegacyTargets,_arStoredModels=Array.isArray(${modelInitial})?${modelInitial}:[],_arEffectiveModels=_arLegacyMigration?[_arSavedConfig.easyTarget.trim(),_arSavedConfig.hardTarget.trim(),..._arStoredModels.filter(model=>typeof model!=="string"||(model.trim()!==_arSavedConfig.easyTarget.trim()&&model.trim()!==_arSavedConfig.hardTarget.trim()))]:null;`;
  const state = `const _arBounds={${serializedBounds}},_arNumber=(value,key,fallback)=>{let bounds=_arBounds[key],number=Number(value);return Number.isSafeInteger(number)&&number>=bounds[0]&&number<=bounds[1]?number:fallback},_arInitialConfig={..._arSavedConfig,hardThreshold:_arNumber(_arSavedConfig.hardThreshold,"hardThreshold",${DEFAULTS.hardThreshold}),longContextChars:_arNumber(_arSavedConfig.longContextChars,"longContextChars",${DEFAULTS.longContextChars}),largeToolResultChars:_arNumber(_arSavedConfig.largeToolResultChars,"largeToolResultChars",${DEFAULTS.largeToolResultChars}),manyTools:_arNumber(_arSavedConfig.manyTools,"manyTools",${DEFAULTS.manyTools})},[_arConfig,_arSetConfig]=(0,${plan.name.react}.useState)(_arInitialConfig),_arUpdate=(key,value)=>_arSetConfig(config=>({...config,[key]:value})),[_arHard,_arSetHard]=(0,${plan.name.react}.useState)(String(_arInitialConfig.hardThreshold)),[_arContext,_arSetContext]=(0,${plan.name.react}.useState)(String(_arInitialConfig.longContextChars)),[_arToolResult,_arSetToolResult]=(0,${plan.name.react}.useState)(String(_arInitialConfig.largeToolResultChars)),[_arTools,_arSetTools]=(0,${plan.name.react}.useState)(String(_arInitialConfig.manyTools));`;
  const save = `async()=>{if(!${plan.validator}(${plan.name.value}))return;let _arTargets=${plan.models.value}.slice(0,2).map(model=>typeof model==="string"?model.trim():"");if("auto"===_arInitialStrategy.fallbackStrategy&&(!_arTargets[0]||!_arTargets[1]||_arTargets[0]===_arTargets[1])){alert("Auto Router requires two distinct usable models in positions 1 (Easy) and 2 (Hard).");return}${plan.savingSetter}(!0);try{let {easyTarget:_arEasyTarget,hardTarget:_arHardTarget,...config}={..._arConfig,hardThreshold:_arNumber(_arHard,"hardThreshold",${DEFAULTS.hardThreshold}),longContextChars:_arNumber(_arContext,"longContextChars",${DEFAULTS.longContextChars}),largeToolResultChars:_arNumber(_arToolResult,"largeToolResultChars",${DEFAULTS.largeToolResultChars}),manyTools:_arNumber(_arTools,"manyTools",${DEFAULTS.manyTools})};await ${plan.modalSave}({name:${plan.name.value}.trim(),models:${plan.models.value}},"auto"===_arInitialStrategy.fallbackStrategy?{autoRouter:config}:null)}finally{${plan.savingSetter}(!1)}}`;
  const invocation = source.slice(plan.invocation.start, plan.invocation.end);
  const invocationExpanded = invocation.replace(`onSave:${source.slice(plan.onSave.start, plan.onSave.end)}`, `onSave:_arSave,strategy:${plan.strategies}[${plan.edited}.name]||{}`).replace(`onSetStrategy:${source.slice(plan.onSetStrategy.start, plan.onSetStrategy.end)}`, `onSetStrategy:${plan.cardStrategyChange}=>_arSetStrategy(${plan.cardCombo}.name,${plan.cardStrategyChange})`);
  const update = `async(id,comboData)=>{try{let response=await fetch(\`/api/combos/${"${id}"}\`,{method:"PUT",headers:{"Content-Type":"application/json"},body:JSON.stringify(comboData)});if(response.ok)return!0;let error=await response.json().catch(()=>({}));alert(error.error||"Failed to update combo");return!1}catch(error){console.log("Error updating combo:",error),alert("Failed to update combo");return!1}}`;
  // 9Router exposes independent Combo and Settings writes. Read settings before changing the
  // Combo, and roll the exact fetched Combo back after a definitive settings failure. A lost
  // settings response is ambiguous, so leave the modal open and require a refresh rather than
  // guessing which state to overwrite.
  const wrapper = `const _arSave=async(comboData,strategy)=>{let settings,original={...${plan.edited},models:[...${plan.edited}.models]};try{let response=await fetch("/api/settings");if(!response.ok)throw Error("Failed to load combo strategies");settings=await response.json()}catch(error){console.log("Error loading combo strategy:",error),alert("Failed to load combo strategy. The combo was not changed.");return}let configs={...(settings.comboStrategies||{})},oldName=original.name,newName=comboData.name;if(oldName!==newName){let old=configs[oldName];delete configs[oldName];if(old)configs[newName]=old}let existing={...configs[newName]||{}},{easyTarget:_arLegacyEasy,hardTarget:_arLegacyHard,...base}=existing,next={...base,...(strategy||{})};if(strategy&&strategy.autoRouter){let {easyTarget:_arLegacyConfigEasy,hardTarget:_arLegacyConfigHard,...freshConfig}=base.autoRouter&&typeof base.autoRouter==="object"?base.autoRouter:{};next.autoRouter={...freshConfig,...strategy.autoRouter}}if(strategy){next.fallbackStrategy&&("fallback"!==next.fallbackStrategy||next.autoRouter)?configs[newName]=next:delete configs[newName]}let changed={...original,...comboData,models:comboData.models},saved=await ${plan.update}(${plan.edited}.id,changed);if(!saved)return;let rollback=async(message)=>{try{if(!await ${plan.update}(${plan.edited}.id,original))throw Error("Combo rollback failed");await ${plan.refresh}(),alert(message+" The original combo was restored; update settings and retry.")}catch(error){console.log("Error restoring combo after settings failure:",error),alert(message+" The combo changed but could not be restored. Refresh, then repair the combo and its Auto Router settings.")}};try{let persisted=await fetch("/api/settings",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({comboStrategies:configs})});if(!persisted.ok){let error=await persisted.json().catch(()=>({}));await rollback(error.error||"Failed to save combo strategy");return}await ${plan.refresh}(),${plan.close}(null)}catch(error){console.log("Error updating combo strategy:",error);try{let response=await fetch("/api/settings");if(!response.ok)throw Error("Failed to verify settings");let current=await response.json();if(JSON.stringify(current.comboStrategies||{})===JSON.stringify(configs)){alert("Could not confirm the settings save. Refresh before editing again.");return}await rollback("Failed to save combo strategy")}catch(recoveryError){console.log("Error verifying combo strategy recovery:",recoveryError),alert("Failed to save combo strategy and could not verify recovery. Refresh, then repair the combo and its Auto Router settings.")}}};const _arSetStrategy=async(name,change)=>{try{let response=await fetch("/api/settings");if(!response.ok)throw Error("Failed to load combo strategies");let settings=await response.json(),configs={...(settings.comboStrategies||{})},next={...configs[name]||{},...change};next.fallbackStrategy&&("fallback"!==next.fallbackStrategy||next.autoRouter)?configs[name]=next:delete configs[name];let persisted=await fetch("/api/settings",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({comboStrategies:configs})});if(!persisted.ok)throw Error("Failed to save combo strategy");await ${plan.refresh}()}catch(error){console.log("Error updating combo strategy:",error),alert("Failed to update combo strategy")}};`;

  const insertControls = `${plan.modalCombo}&&(0,${plan.jsx}.jsxs)("div",{children:[${controls(plan.jsx, plan.models.value)}]}),`;
  const replacements = [
    { start: plan.options.array.start, end: plan.options.array.end, text: `${plan.optionArray.slice(0, -1)},{value:"auto",label:"Auto Router"}]/* ${uiMarker} */` },
    { start: plan.modal.params[0].start, end: plan.modal.params[0].end, text: expandedParams },
    { start: plan.modalStateStatement.start, end: plan.modalStateStatement.start, text: legacySetup },
    { start: plan.models.initial.start, end: plan.models.initial.end, text: `_arEffectiveModels||${modelInitial}` },
    { start: plan.modalStateStatement.end, end: plan.modalStateStatement.end, text: state },
    { start: plan.saveDeclarator.node.init.start, end: plan.saveDeclarator.node.init.end, text: save },
    { start: plan.footer.start, end: plan.footer.start, text: insertControls },
    { start: plan.invocation.start, end: plan.invocation.end, text: invocationExpanded },
    { start: plan.onSetStrategy.start, end: plan.onSetStrategy.end, text: `${plan.cardStrategyChange}=>_arSetStrategy(${plan.cardCombo}.name,${plan.cardStrategyChange})` },
    { start: plan.updateDeclarator.node.init.start, end: plan.updateDeclarator.node.init.end, text: update },
    { start: plan.parent.body.start + 1, end: plan.parent.body.start + 1, text: wrapper },
    { start: plan.explanationItem.end, end: plan.explanationItem.end, text: `,(0,${plan.jsx}.jsxs)("li",{children:[(0,${plan.jsx}.jsx)("span",{className:"font-medium text-text-main",children:"Auto Router"})," — automatically routes each request to an Easy or Hard target combo based on task complexity"]})` },
  ];
  const patched = replaceRanges(source, replacements, target);
  parseJavaScript(patched, target);
  return patched;
}
function patchUi(targets) {
  let changed = false;
  for (const target of targets) {
    const source = fs.readFileSync(target, "utf8");
    if (source.includes(uiMarker)) { verifyPatchedUi(target, source); continue; }
    const plan = discoverUiStructure(source, target);
    const patched = applyUiPlan(source, plan, target);
    verifyPatchedUi(target, patched);
    fs.writeFileSync(target, patched);
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
    else discoverUiStructure(source, target);
  }
  console.log(`9Router Auto Router compatibility check passed: runtime=${path.relative(appRoot, runtime)} ui=${ui.map((file) => path.relative(appRoot, file)).join(",")}`);
} else {
  const runtimeChanged = patchRuntime(runtime);
  const uiChanged = patchUi(ui);
  console.log(`9Router Auto Router patch ${runtimeChanged || uiChanged ? "applied" : "already applied"}: runtime=${path.relative(appRoot, runtime)} ui=${ui.map((file) => path.relative(appRoot, file)).join(",")}`);
}
