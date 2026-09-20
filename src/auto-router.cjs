"use strict";

const KEYWORD_GROUPS = Object.freeze([
  { reason: "audit", terms: ["fully audit", "deep review", "audit"] },
  { reason: "concurrency", terms: ["race condition", "concurrency", "stale-write", "stale write"] },
  { reason: "root-cause", terms: ["root cause", "debug intermittent", "failing tests with unclear cause", "investigate"] },
  { reason: "precision", terms: ["financial precision", "decimal precision"] },
  { reason: "architecture", terms: ["architecture", "migration", "repository-wide", "multi-file", "refactor"] },
  { reason: "security", terms: ["security", "authentication", "permissions"] },
  { reason: "performance", terms: ["performance investigation"] },
]);
const STRONG_TERMS = new Set(["fully audit", "deep review", "root cause", "race condition", "financial precision", "decimal precision", "performance investigation", "debug intermittent", "failing tests with unclear cause", "migration", "concurrency"]);
const HARD_TERMS = KEYWORD_GROUPS.flatMap((group) => group.terms);
const activeAutoCombos = new WeakMap();
const DEFAULTS = Object.freeze({ easyTarget: "coder", hardTarget: "coder-high", hardThreshold: 6, longContextChars: 24000, largeToolResultChars: 12000, manyTools: 16, verbose: false });

function positiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function configuredString(explicit, key, legacy, fallback) {
  if (Object.prototype.hasOwnProperty.call(explicit, key)) return typeof explicit[key] === "string" && explicit[key].trim() ? explicit[key].trim() : fallback;
  if (typeof legacy === "string" && legacy.trim()) return legacy.trim();
  return fallback;
}

function configuredPositiveInt(explicit, key, legacy, fallback) {
  if (Object.prototype.hasOwnProperty.call(explicit, key)) return Number.isSafeInteger(explicit[key]) && explicit[key] > 0 ? explicit[key] : fallback;
  return positiveInt(legacy, fallback);
}

function getConfig(env = process.env, explicit = {}) {
  const selected = explicit && typeof explicit === "object" && !Array.isArray(explicit) ? explicit : {};
  return {
    easyTarget: configuredString(selected, "easyTarget", env.AUTO_ROUTER_EASY_TARGET, DEFAULTS.easyTarget),
    hardTarget: configuredString(selected, "hardTarget", env.AUTO_ROUTER_HARD_TARGET, DEFAULTS.hardTarget),
    hardThreshold: configuredPositiveInt(selected, "hardThreshold", env.AUTO_ROUTER_HARD_THRESHOLD, DEFAULTS.hardThreshold),
    longContextChars: configuredPositiveInt(selected, "longContextChars", env.AUTO_ROUTER_LONG_CONTEXT_CHARS, DEFAULTS.longContextChars),
    largeToolResultChars: configuredPositiveInt(selected, "largeToolResultChars", env.AUTO_ROUTER_LARGE_TOOL_RESULT_CHARS, DEFAULTS.largeToolResultChars),
    manyTools: configuredPositiveInt(selected, "manyTools", env.AUTO_ROUTER_MANY_TOOLS, DEFAULTS.manyTools),
    verbose: Object.prototype.hasOwnProperty.call(selected, "verbose") ? selected.verbose === true : env.AUTO_ROUTER_VERBOSE === "true",
  };
}

function isToolResult(value) {
  return value?.role === "tool" || value?.type === "tool_result" || value?.type === "function_call_output";
}

function textLength(value, state) {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + textLength(item, state), 0);
  if (!value || typeof value !== "object") return 0;
  let size = 0;
  for (const key of ["text", "content", "input_text", "output_text", "arguments", "output"]) {
    if (typeof value[key] === "string") {
      size += value[key].length;
      if (isToolResult(value) || key === "output") state.toolResultChars += value[key].length;
    }
  }
  for (const key of ["content", "parts", "input"]) if (Array.isArray(value[key])) size += textLength(value[key], state);
  return size;
}

function inspectRequest(body) {
  const state = { chars: 0, messageCount: 0, toolCalls: 0, toolResults: 0, toolResultChars: 0, modalities: 0 };
  if (!body || typeof body !== "object" || Array.isArray(body)) return state;
  for (const key of ["messages", "input", "contents"]) {
    const items = body[key] || body.request?.[key];
    if (!Array.isArray(items)) continue;
    state.messageCount += items.length;
    state.chars += textLength(items, state);
    for (const item of items) {
      if (isToolResult(item)) state.toolResults += 1;
      if (item?.role === "assistant" && (item.tool_calls || item.function_call)) state.toolCalls += Array.isArray(item.tool_calls) ? item.tool_calls.length : 1;
      if (item?.type === "function_call") state.toolCalls += 1;
      if (/"(?:image_url|input_image|input_file|file|document|input_audio|input_video)"/.test(JSON.stringify(item))) state.modalities += 1;
    }
  }
  return state;
}

function normalizeTools(body) { return Array.isArray(body?.tools) ? body.tools : Array.isArray(body?.functions) ? body.functions : []; }

function classifyTaskComplexity(body, config = getConfig()) {
  try {
    if (!body || typeof body !== "object" || Array.isArray(body)) return { level: "hard", score: config.hardThreshold, reasons: ["invalid-request"], metadata: {} };
    const state = inspectRequest(body), tools = normalizeTools(body);
    const text = JSON.stringify({ messages: body.messages, input: body.input, contents: body.contents }).toLowerCase();
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
    for (const group of KEYWORD_GROUPS) {
      const matched = group.terms.filter((term) => text.includes(term));
      if (matched.length) add(matched.some((term) => STRONG_TERMS.has(term)) ? 6 : 3, group.reason);
    }
    score = Math.min(score, config.hardThreshold + 1);
    return { level: score >= config.hardThreshold ? "hard" : "easy", score, reasons: [...new Set(reasons)], metadata: { chars: state.chars, messages: state.messageCount, tools: tools.length, toolCalls: state.toolCalls, toolResults: state.toolResults, toolResultChars: state.toolResultChars, modalities: state.modalities } };
  } catch {
    return { level: "hard", score: config.hardThreshold, reasons: ["classifier-error"], metadata: {} };
  }
}

function selectRoute(body, comboName, { env = process.env, comboStrategies = {}, globalStrategy = "fallback" } = {}) {
  const persisted = comboStrategies?.[comboName]?.autoRouter;
  const config = getConfig(env, persisted), classification = classifyTaskComplexity(body, config);
  const target = classification.level === "easy" ? config.easyTarget : config.hardTarget;
  if (!target) throw new Error("AUTO-ROUTER target is empty. Set AUTO_ROUTER_EASY_TARGET and AUTO_ROUTER_HARD_TARGET.");
  if (target === comboName) throw new Error(`AUTO-ROUTER recursion blocked: combo "${comboName}" targets itself.`);
  if ((comboStrategies[target]?.fallbackStrategy || globalStrategy) === "auto") throw new Error(`AUTO-ROUTER recursion blocked: target "${target}" also resolves with strategy "auto".`);
  return { target, classification, config };
}

async function routeAutoCombo({ body, comboName, comboStrategies, globalStrategy, log, delegate }) {
  const active = body && typeof body === "object" ? activeAutoCombos.get(body) : null;
  if (active?.has(comboName)) {
    const message = `AUTO-ROUTER recursion blocked: combo "${comboName}" was reached again while resolving this request.`;
    log.warn("AUTO-ROUTER", message);
    return new Response(JSON.stringify({ error: { message } }), { status: 400, headers: { "Content-Type": "application/json" } });
  }
  const nextActive = active || new Set();
  if (body && typeof body === "object") activeAutoCombos.set(body, nextActive);
  nextActive.add(comboName);
  try {
    const { target, classification, config } = selectRoute(body, comboName, { comboStrategies, globalStrategy });
    log.info("AUTO-ROUTER", `${comboName} → ${target} level=${classification.level} score=${classification.score} reasons=${classification.reasons.join(",")}`);
    if (config.verbose) log.info("AUTO-ROUTER", `metadata=${JSON.stringify(classification.metadata)}`);
    return await delegate(body, target);
  } catch (error) {
    log.warn("AUTO-ROUTER", `${comboName} routing blocked: ${error.message}`);
    return new Response(JSON.stringify({ error: { message: `AUTO-ROUTER: ${error.message}` } }), { status: 400, headers: { "Content-Type": "application/json" } });
  } finally {
    nextActive.delete(comboName);
    if (nextActive.size === 0 && body && typeof body === "object") activeAutoCombos.delete(body);
  }
}

module.exports = { DEFAULTS, HARD_TERMS, STRONG_TERMS, getConfig, classifyTaskComplexity, selectRoute, routeAutoCombo };
