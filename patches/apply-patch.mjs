import fs from "node:fs";
import path from "node:path";

const appRoot = process.argv[2] || "/app";
const checkOnly = process.argv.includes("--check");
const runtimeMarker = "9router-auto-router:v2";
const uiMarker = "9router-auto-router-ui:v1";
const UI_ANCHOR = '"fusion",label:"Fusion — panel + judge"';
const UI_PATCH = '"fusion",label:"Fusion — panel + judge"},{value:"auto",label:"Auto — select one target"';

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
    const bindings = [...before.matchAll(/let ([A-Za-z_$][\w$]*)=([A-Za-z_$][\w$]*)\.comboStrategies\|\|\{\}/g)];
    const strategyBinding = bindings.at(-1);
    const strategies = strategyBinding?.[1], settings = strategyBinding?.[2];
    if (!body || !strategies || !settings || (body !== "c" && body !== "a")) fail(`Runtime dispatch data-flow validation failed:\n  ${path.relative(appRoot, target)}\n\nExpected body, comboStrategies, and settings bindings near fusion dispatch.`);
    const delegate = body === "c" ? "(nextBody,target)=>z(nextBody,target,b,a,j)" : "(nextBody,target)=>z(nextBody,target,c,d,e)";
    const patch = `if("auto"===${strategy})return require("/opt/9router-auto-router/auto-router.cjs").routeAutoCombo({body:${body},comboName:${comboName},comboStrategies:${strategies},globalStrategy:${settings}.comboStrategy,log:${log},delegate:${delegate}});`;
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
    if (source.includes(uiMarker)) continue;
    if (count(source, UI_ANCHOR) !== 1) fail(`UI strategy anchor is not unique:\n  ${path.relative(appRoot, target)}`);
    source = source.replace(UI_ANCHOR, `${UI_PATCH}/* ${uiMarker} */`);
    if (count(source, uiMarker) !== 1) fail(`UI patch integrity failed:\n  ${path.relative(appRoot, target)}`);
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
