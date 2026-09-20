"use strict";

const KEYWORD_GROUPS = Object.freeze([
  { reason: "audit", terms: ["fully audit", "deep review", "audit"] },
  { reason: "concurrency", terms: ["race condition", "concurrency", "stale-write", "stale write"] },
  { reason: "root-cause", terms: ["root cause", "debug intermittent", "intermittent failing tests", "failing tests with unclear cause", "investigate"] },
  { reason: "precision", terms: ["financial precision", "decimal precision"] },
  { reason: "architecture", terms: ["architecture", "migration", "repository-wide", "multi-file", "refactor"] },
  { reason: "security", terms: ["security", "authentication", "permissions"] },
  { reason: "performance", terms: ["performance investigation"] },
]);
const STRONG_TERMS = new Set(["fully audit", "deep review", "root cause", "race condition", "financial precision", "decimal precision", "performance investigation", "debug intermittent", "intermittent failing tests", "failing tests with unclear cause", "migration", "concurrency"]);
const HARD_TERMS = KEYWORD_GROUPS.flatMap((group) => group.terms);
const activeAutoCombos = new WeakMap();
const DEFAULTS = Object.freeze({ easyTarget: "coder", hardTarget: "coder-high", hardThreshold: 6, longContextChars: 24000, largeToolResultChars: 12000, manyTools: 16, verbose: false });
const TEXT_FIELDS = new Set(["text", "content", "input_text", "output_text", "arguments", "output"]);
const PART_FIELDS = new Set(["content", "parts", "input"]);
const MODALITY_TYPES = new Set(["image_url", "input_image", "input_file", "file", "document", "input_audio", "input_video"]);

function positiveInt(value, fallback) {
  if (typeof value !== "string" || !/^\s*[1-9]\d*\s*$/.test(value)) return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : fallback;
}

function nonEmptyString(value) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function validPositiveInt(value) { return Number.isSafeInteger(value) && value > 0 ? value : null; }
function booleanValue(value) {
  if (value === true || value === false) return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" ? true : normalized === "false" ? false : null;
}
function configuredString(explicit, key, legacy, fallback) { return nonEmptyString(explicit[key]) || nonEmptyString(legacy) || fallback; }
function configuredPositiveInt(explicit, key, legacy, fallback) { return validPositiveInt(explicit[key]) || positiveInt(legacy, fallback); }
function configuredBoolean(explicit, key, legacy, fallback) { return booleanValue(explicit[key]) ?? booleanValue(legacy) ?? fallback; }

function getConfig(env = process.env, explicit = {}) {
  const selected = explicit && typeof explicit === "object" && !Array.isArray(explicit) ? explicit : {};
  return {
    easyTarget: configuredString(selected, "easyTarget", env.AUTO_ROUTER_EASY_TARGET, DEFAULTS.easyTarget),
    hardTarget: configuredString(selected, "hardTarget", env.AUTO_ROUTER_HARD_TARGET, DEFAULTS.hardTarget),
    hardThreshold: configuredPositiveInt(selected, "hardThreshold", env.AUTO_ROUTER_HARD_THRESHOLD, DEFAULTS.hardThreshold),
    longContextChars: configuredPositiveInt(selected, "longContextChars", env.AUTO_ROUTER_LONG_CONTEXT_CHARS, DEFAULTS.longContextChars),
    largeToolResultChars: configuredPositiveInt(selected, "largeToolResultChars", env.AUTO_ROUTER_LARGE_TOOL_RESULT_CHARS, DEFAULTS.largeToolResultChars),
    manyTools: configuredPositiveInt(selected, "manyTools", env.AUTO_ROUTER_MANY_TOOLS, DEFAULTS.manyTools),
    verbose: configuredBoolean(selected, "verbose", env.AUTO_ROUTER_VERBOSE, DEFAULTS.verbose),
  };
}

function own(value, key) {
  if (!value || typeof value !== "object") return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && "value" in descriptor ? descriptor.value : undefined;
}
function isToolResult(value) { return own(value, "role") === "tool" || own(value, "type") === "tool_result" || own(value, "type") === "function_call_output"; }
function isUserMessage(value) { return own(value, "role") === "user"; }
function contentLength(value, state, seen = new Set()) {
  if (typeof value === "string") return value.length;
  if (!value || typeof value !== "object" || seen.has(value)) return 0;
  seen.add(value);
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + contentLength(item, state, seen), 0);
  let size = 0;
  for (const key of TEXT_FIELDS) {
    const text = own(value, key);
    if (typeof text === "string") {
      size += text.length;
      if (isToolResult(value) || key === "output") state.toolResultChars += text.length;
    }
  }
  for (const key of PART_FIELDS) {
    const child = own(value, key);
    if (Array.isArray(child)) size += contentLength(child, state, seen);
  }
  return size;
}
function hasModality(value, seen = new Set()) {
  if (!value || typeof value !== "object" || seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => hasModality(item, seen));
  if (MODALITY_TYPES.has(own(value, "type"))) return true;
  for (const key of MODALITY_TYPES) if (own(value, key) !== undefined) return true;
  for (const key of PART_FIELDS) {
    const child = own(value, key);
    if (Array.isArray(child) && hasModality(child, seen)) return true;
  }
  return false;
}
function userText(value, seen = new Set()) {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || seen.has(value)) return "";
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => userText(item, seen)).join(" ");
  let text = "";
  for (const key of TEXT_FIELDS) {
    const child = own(value, key);
    if (typeof child === "string") text += ` ${child}`;
  }
  for (const key of PART_FIELDS) {
    const child = own(value, key);
    if (Array.isArray(child)) text += ` ${userText(child, seen)}`;
  }
  return text;
}
function requestCollections(body) {
  const nested = own(body, "request");
  const source = nested && typeof nested === "object" ? nested : body;
  return ["messages", "input", "contents"].map((key) => own(source, key)).filter(Array.isArray);
}
function inspectRequest(body) {
  const state = { chars: 0, messageCount: 0, toolCalls: 0, toolResults: 0, toolResultChars: 0, modalities: 0, userTexts: [] };
  if (!body || typeof body !== "object" || Array.isArray(body)) return state;
  for (const items of requestCollections(body)) {
    state.messageCount += items.length;
    state.chars += contentLength(items, state);
    for (const item of items) {
      if (isToolResult(item)) state.toolResults += 1;
      const calls = own(item, "tool_calls");
      if (own(item, "role") === "assistant" && (Array.isArray(calls) || own(item, "function_call"))) state.toolCalls += Array.isArray(calls) ? calls.length : 1;
      if (own(item, "type") === "function_call") state.toolCalls += 1;
      if (hasModality(item)) state.modalities += 1;
      if (isUserMessage(item)) state.userTexts.push(userText(own(item, "content") ?? own(item, "parts") ?? own(item, "input")));
    }
  }
  return state;
}
function normalizeTools(body) { return Array.isArray(own(body, "tools")) ? own(body, "tools") : Array.isArray(own(body, "functions")) ? own(body, "functions") : []; }
function addKeywordScore(text, multiplier, add) {
  const normalized = text.toLowerCase();
  for (const group of KEYWORD_GROUPS) {
    const matched = group.terms.filter((term) => normalized.includes(term));
    if (matched.length) add((matched.some((term) => STRONG_TERMS.has(term)) ? 6 : 3) * multiplier, group.reason);
  }
}

function classifyTaskComplexity(body, config = getConfig()) {
  try {
    if (!body || typeof body !== "object" || Array.isArray(body)) return { level: "hard", score: config.hardThreshold, reasons: ["invalid-request"], metadata: {} };
    const state = inspectRequest(body), tools = normalizeTools(body);
    if (state.chars === 0 && state.messageCount === 0) return { level: "hard", score: config.hardThreshold, reasons: ["empty-request"], metadata: {} };
    let score = 0;
    const reasons = [], add = (points, reason) => { score += points; reasons.push(reason); };
    if (state.chars >= config.longContextChars) add(4, "large-context");
    else if (state.chars >= Math.floor(config.longContextChars / 3)) add(2, "medium-context");
    if (state.messageCount >= 16) add(3, "long-history");
    else if (state.messageCount >= 8) add(1, "multi-turn-history");
    if (state.toolCalls + state.toolResults >= 8) add(3, "substantial-tool-history");
    else if (state.toolCalls + state.toolResults >= 3) add(2, "repeated-tool-history");
    if (state.toolResultChars >= config.largeToolResultChars) add(4, "large-tool-result-history");
    else if (state.toolResultChars >= Math.floor(config.largeToolResultChars / 3)) add(2, "medium-tool-result-history");
    if (tools.length >= config.manyTools * 2) add(2, "huge-toolset");
    else if (tools.length >= config.manyTools) add(1, "large-toolset");
    else if (tools.length > 0) add(1, "tools-present");
    if (state.modalities >= 3) add(2, "multiple-modalities");
    else if (state.modalities > 0) add(1, "modality-present");
    const latest = state.userTexts.at(-1) || "";
    addKeywordScore(latest, 1, add);
    for (const previous of state.userTexts.slice(0, -1)) addKeywordScore(previous, 1 / 3, add);
    score = Math.min(score, config.hardThreshold + 1);
    return { level: score >= config.hardThreshold ? "hard" : "easy", score, reasons: [...new Set(reasons)], metadata: { chars: state.chars, messages: state.messageCount, tools: tools.length, toolCalls: state.toolCalls, toolResults: state.toolResults, toolResultChars: state.toolResultChars, modalities: state.modalities } };
  } catch {
    return { level: "hard", score: config.hardThreshold, reasons: ["classifier-error"], metadata: {} };
  }
}

function strategyFor(comboName, comboStrategies, globalStrategy) { return comboStrategies?.[comboName]?.fallbackStrategy || globalStrategy; }
function autoTargetsFor(comboName, comboStrategies, globalStrategy) {
  if (strategyFor(comboName, comboStrategies, globalStrategy) !== "auto") return [];
  const autoRouter = comboStrategies?.[comboName]?.autoRouter;
  if (!autoRouter || typeof autoRouter !== "object") return [];
  return [autoRouter.easyTarget, autoRouter.hardTarget].filter((value) => nonEmptyString(value));
}
function validateAutoTarget(comboName, target, comboStrategies, globalStrategy, knownCombos) {
  if (knownCombos && !knownCombos.has(target)) throw new Error(`Easy or hard target "${target}" does not exist.`);
  const visited = new Set([comboName]);
  const pending = [target];
  while (pending.length) {
    const current = pending.pop();
    if (visited.has(current)) throw new Error(`AUTO-ROUTER recursion blocked: target chain returns to combo "${current}".`);
    if (strategyFor(current, comboStrategies, globalStrategy) !== "auto") continue;
    if (current === target) throw new Error(`AUTO-ROUTER recursion blocked: target "${current}" also resolves with strategy "auto".`);
    visited.add(current);
    for (const next of autoTargetsFor(current, comboStrategies, globalStrategy)) pending.push(next);
  }
}

function selectRoute(body, comboName, { env = process.env, comboStrategies = {}, globalStrategy = "fallback", knownCombos } = {}) {
  const persisted = comboStrategies?.[comboName]?.autoRouter;
  const config = getConfig(env, persisted), classification = classifyTaskComplexity(body, config);
  const target = classification.level === "easy" ? config.easyTarget : config.hardTarget;
  if (!target) throw new Error(`AUTO-ROUTER target is empty for combo "${comboName}". Configure Easy target and Hard target in the combo's Auto Router settings.`);
  validateAutoTarget(comboName, target, comboStrategies, globalStrategy, knownCombos ? new Set(knownCombos) : null);
  return { target, classification, config };
}

function errorResponse(message) { return new Response(JSON.stringify({ error: { message } }), { status: 400, headers: { "Content-Type": "application/json" } }); }
async function routeAutoCombo({ body, comboName, comboStrategies, globalStrategy, log, delegate, targetExists }) {
  const active = body && typeof body === "object" ? activeAutoCombos.get(body) : null;
  if (active?.has(comboName)) {
    const message = `AUTO-ROUTER recursion blocked: combo "${comboName}" was reached again while resolving this request.`;
    log.warn("AUTO-ROUTER", message);
    return errorResponse(message);
  }
  const nextActive = active || new Set();
  if (body && typeof body === "object") activeAutoCombos.set(body, nextActive);
  nextActive.add(comboName);
  try {
    const { target, classification, config } = selectRoute(body, comboName, { comboStrategies, globalStrategy });
    if (targetExists && !await targetExists(target)) throw new Error(`${classification.level === "easy" ? "Easy" : "Hard"} target "${target}" does not exist.`);
    log.info("AUTO-ROUTER", `${comboName} → ${target} level=${classification.level} score=${classification.score} reasons=${classification.reasons.join(",")}`);
    if (config.verbose) log.info("AUTO-ROUTER", `metadata=${JSON.stringify(classification.metadata)}`);
    return await delegate(body, target);
  } catch (error) {
    log.warn("AUTO-ROUTER", `${comboName} routing blocked: ${error.message}`);
    return errorResponse(`AUTO-ROUTER: ${error.message}`);
  } finally {
    nextActive.delete(comboName);
    if (nextActive.size === 0 && body && typeof body === "object") activeAutoCombos.delete(body);
  }
}

module.exports = { DEFAULTS, HARD_TERMS, STRONG_TERMS, getConfig, classifyTaskComplexity, selectRoute, routeAutoCombo, validateAutoTarget };
