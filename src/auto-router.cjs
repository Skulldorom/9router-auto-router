"use strict";

// Weak domain nouns ("security", "authentication", "permissions") and structural
// change nouns ("architecture", "migration") are common as labels, e.g.
// 'Rename the "Authentication" menu item'. They only contribute when the same user
// text also carries a task-oriented action word. Unconditional task phrases
// ("fully audit", "race condition", ...) always contribute.
const TASK_ACTION_TERMS = [
  "audit", "review", "investigate", "analyze", "analyse", "assess", "diagnose",
  "debug", "refactor", "redesign", "restructure", "harden",
  "optimize", "optimise", "benchmark", "profile", "trace", "reproduce", "resolve",
  "rewrite", "overhaul", "plan", "implement", "survey",
];
const STRONG_TASK_PHRASES = Object.freeze([
  { reason: "audit", terms: ["fully audit", "deep review", "deep repository audit"] },
  { reason: "architecture", terms: ["design the architecture", "design architecture"] },
  { reason: "review", terms: ["review"] },
  { reason: "trace", terms: ["trace"] },
  { reason: "concurrency", terms: ["race condition", "concurrency", "stale-write", "stale write"] },
  { reason: "root-cause", terms: ["root cause", "debug intermittent", "intermittent failing tests", "failing tests with unclear cause"] },
  { reason: "precision", terms: ["financial precision", "decimal precision"] },
  { reason: "performance", terms: ["performance investigation"] },
  { reason: "architecture", terms: ["repository-wide", "multi-file"] },
]);
const GATED_STRUCTURAL_TERMS = Object.freeze([
  { reason: "migration", terms: ["migration", "migrate"] },
  { reason: "architecture", terms: ["architecture"] },
]);
const WEAK_DOMAIN_TERMS = Object.freeze([
  { reason: "security", terms: ["security", "authentication", "permissions"] },
]);
const STRONG_TERMS = new Set(STRONG_TASK_PHRASES.flatMap((group) => group.terms));
const WEAK_TERMS = new Set([...GATED_STRUCTURAL_TERMS, ...WEAK_DOMAIN_TERMS].flatMap((group) => group.terms));
const HARD_TERMS = [...STRONG_TERMS, ...WEAK_TERMS];
const PUNCTUATED_PHRASES = new Set(HARD_TERMS.map((term) => term.toLocaleLowerCase().split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean)).filter((parts) => parts.length > 1).map((parts) => parts.join(" ")));
const STRONG_WEIGHT = 6;
// Previous user turns are corroborating context, never an accumulating substitute for
// the current request. Their combined semantic contribution stays below the default
// hard threshold; structural history can still route a substantial follow-up hard.
const MAX_HISTORICAL_SEMANTIC_SCORE = 4;
// Gated structural work ("plan a database migration") carries full weight once task
// language is present; a lone security/architecture noun stays sub-threshold.
const GATED_WEIGHT = 6;
const WEAK_WEIGHT = 3;
const activeAutoCombos = new WeakMap();
const DEFAULTS = Object.freeze({ easyTarget: "coder", hardTarget: "coder-high", hardThreshold: 6, longContextChars: 24000, largeToolResultChars: 12000, manyTools: 16, verbose: false });
const TEXT_FIELDS = new Set(["text", "content", "input_text", "output_text", "arguments", "output"]);
const USER_TEXT_FIELDS = new Set(["text", "content", "input_text"]);
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
  for (const key of USER_TEXT_FIELDS) {
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
  // Adapters can preserve an original request beside a normalized translation. Those
  // fields describe one conversation, not additive conversations. Prefer the native
  // OpenAI Chat shape, then OpenAI Responses input (including its string form), then
  // translated Anthropic contents. This applies equally to the supported request wrapper.
  const messages = own(source, "messages");
  if (Array.isArray(messages) && messages.length > 0) return [{ items: messages, stringInput: false }];
  const input = own(source, "input");
  if (Array.isArray(input) && input.length > 0) return [{ items: input, stringInput: false }];
  // OpenAI Responses permits its top-level input to be a string. Unlike metadata
  // fields, that value is explicitly the end-user input and can carry intent.
  if (typeof input === "string" && input.trim()) return [{ items: [input], stringInput: true }];
  const contents = own(source, "contents");
  if (Array.isArray(contents) && contents.length > 0) return [{ items: contents, stringInput: false }];
  // Empty placeholders do not block a populated fallback shape. If every recognized
  // representation is empty, inspect nothing so the existing empty-request hard route
  // remains the deliberate fail-closed outcome.
  return [];
}
function inspectRequest(body) {
  const state = { chars: 0, messageCount: 0, toolCalls: 0, toolResults: 0, toolResultChars: 0, modalities: 0, userTexts: [] };
  if (!body || typeof body !== "object" || Array.isArray(body)) return state;
  for (const { items, stringInput } of requestCollections(body)) {
    state.messageCount += items.length;
    state.chars += contentLength(items, state);
    for (const item of items) {
      if (stringInput) {
        state.userTexts.push(item);
        continue;
      }
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
function addIntentChunk(tokens, chunk, quoted) {
  const normalized = chunk.toLocaleLowerCase().replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "");
  if (!normalized) return;
  // Paths, filenames, snake_case, and camelCase identifiers stay atomic. Normal
  // prose punctuation is split below, so `fully-audit` matches without exposing
  // `plan` from `migration-plan.json` or an identifier such as `migrationPlan`.
  if (/[._/\\]/u.test(normalized) || /\p{Ll}\p{M}*\p{Lu}/u.test(normalized)) {
    tokens.push({ value: normalized, quoted });
    return;
  }
  const parts = normalized.split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean);
  const hasPunctuationSeparator = /[^\p{L}\p{N}\p{M}\s]/u.test(normalized);
  if (hasPunctuationSeparator && parts.length > 1 && !PUNCTUATED_PHRASES.has(parts.join(" "))) {
    tokens.push({ value: normalized, quoted });
    return;
  }
  for (const part of parts) tokens.push({ value: part, quoted });
}
function intentTokens(text) {
  const tokens = [];
  let chunk = "", quote = null, escaped = false, quoted = false;
  const flush = () => {
    addIntentChunk(tokens, chunk, quoted);
    chunk = "";
  };
  for (const character of text) {
    if (quote) {
      if (escaped) {
        chunk += character;
        escaped = false;
      } else if (character === "\\") escaped = true;
      else if (character === quote) {
        flush();
        quote = null;
        quoted = false;
      } else chunk += character;
      continue;
    }
    if (character === '"' || character === "`" || character === "'") {
      flush();
      quote = character;
      quoted = true;
    } else if (/\s/u.test(character)) flush();
    else chunk += character;
  }
  flush();
  return tokens;
}
function termTokens(term) { return term.toLocaleLowerCase().split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean); }
function hasTerm(tokens, term, allowQuoted = false) {
  const phrase = termTokens(term);
  return tokens.some((token, index) => phrase.every((part, offset) => tokens[index + offset]?.value === part && (allowQuoted || !tokens[index + offset].quoted)));
}
function keywordMatches(text) {
  const tokens = intentTokens(text);
  const reasonsFor = (groups, allowQuoted = false) => groups.filter((group) => group.terms.some((term) => hasTerm(tokens, term, allowQuoted))).map((group) => group.reason);
  const strong = reasonsFor(STRONG_TASK_PHRASES);
  const taskOriented = TASK_ACTION_TERMS.some((term) => hasTerm(tokens, term));
  return {
    strong,
    // Quoted nouns remain inert by themselves. Once an unquoted action establishes
    // task intent, quoted domain context is meaningful and receives normal weight.
    gated: taskOriented ? reasonsFor(GATED_STRUCTURAL_TERMS, true) : [],
    weak: taskOriented ? reasonsFor(WEAK_DOMAIN_TERMS, true) : [],
  };
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
    const latestMatches = keywordMatches(latest);
    for (const reason of latestMatches.strong) add(STRONG_WEIGHT, reason);
    for (const reason of latestMatches.gated) add(GATED_WEIGHT, reason);
    for (const reason of latestMatches.weak) add(WEAK_WEIGHT, reason);
    // Keep historic semantic context helpful without allowing it alone to cross a
    // user-configured hard threshold.
    const historicalSemanticCap = Math.min(MAX_HISTORICAL_SEMANTIC_SCORE, Math.max(0, config.hardThreshold - 1));
    let historicalSemanticScore = 0;
    const addHistorical = (points, reason) => {
      const contribution = Math.min(points, historicalSemanticCap - historicalSemanticScore);
      if (contribution > 0) {
        historicalSemanticScore += contribution;
        add(contribution, reason);
      }
    };
    for (const previous of state.userTexts.slice(0, -1)) {
      const previousMatches = keywordMatches(previous);
      for (const reason of previousMatches.strong) addHistorical(STRONG_WEIGHT / 3, reason);
      for (const reason of previousMatches.gated) addHistorical(GATED_WEIGHT / 3, reason);
      for (const reason of previousMatches.weak) addHistorical(WEAK_WEIGHT / 3, reason);
      if (historicalSemanticScore === historicalSemanticCap) break;
    }
    score = Math.min(score, config.hardThreshold + 1);
    return { level: score >= config.hardThreshold ? "hard" : "easy", score, reasons: [...new Set(reasons)], metadata: { chars: state.chars, messages: state.messageCount, tools: tools.length, toolCalls: state.toolCalls, toolResults: state.toolResults, toolResultChars: state.toolResultChars, modalities: state.modalities } };
  } catch {
    return { level: "hard", score: config.hardThreshold, reasons: ["classifier-error"], metadata: {} };
  }
}

function strategyFor(comboName, comboStrategies, globalStrategy) { return comboStrategies?.[comboName]?.fallbackStrategy || globalStrategy; }

// Policy: an Auto Router combo must target ordinary/non-auto combos. Auto Router → Auto Router
// chaining is intentionally unsupported, so validation is a direct per-target check, not a graph
// traversal. The per-request WeakMap guard in routeAutoCombo remains defense-in-depth.
function validateAutoTarget(comboName, target, comboStrategies, globalStrategy, knownCombos, label = "Auto Router") {
  const described = `${label} target "${target}"`;
  if (knownCombos && !knownCombos.has(target)) throw new Error(`${described} does not exist.`);
  if (target === comboName) throw new Error(`recursion blocked: ${described} is the Auto Router combo itself ("${comboName}"); Auto Router combos cannot route to themselves.`);
  if (strategyFor(target, comboStrategies, globalStrategy) === "auto") throw new Error(`recursion blocked: ${described} is configured with fallbackStrategy "auto"; Auto Router → Auto Router chaining is not supported.`);
}

function selectRoute(body, comboName, { env = process.env, comboStrategies = {}, globalStrategy = "fallback", knownCombos } = {}) {
  const persisted = comboStrategies?.[comboName]?.autoRouter;
  const config = getConfig(env, persisted), classification = classifyTaskComplexity(body, config);
  const target = classification.level === "easy" ? config.easyTarget : config.hardTarget;
  if (!target) throw new Error(`target is empty for combo "${comboName}". Configure Easy target and Hard target in the combo's Auto Router settings.`);
  validateAutoTarget(comboName, target, comboStrategies, globalStrategy, knownCombos ? new Set(knownCombos) : null, classification.level === "easy" ? "Easy" : "Hard");
  return { target, classification, config };
}

function errorResponse(message) { return new Response(JSON.stringify({ error: { message: `AUTO-ROUTER: ${message}` } }), { status: 400, headers: { "Content-Type": "application/json" } }); }
async function routeAutoCombo({ body, comboName, comboStrategies, globalStrategy, log, delegate, targetExists }) {
  const active = body && typeof body === "object" ? activeAutoCombos.get(body) : null;
  if (active?.has(comboName)) {
    const message = `recursion blocked: combo "${comboName}" was reached again while resolving this request.`;
    log.warn("AUTO-ROUTER", message);
    return errorResponse(message);
  }
  const nextActive = active || new Set();
  if (body && typeof body === "object") activeAutoCombos.set(body, nextActive);
  nextActive.add(comboName);
  try {
    let route;
    try {
      route = selectRoute(body, comboName, { comboStrategies, globalStrategy });
      if (targetExists && !await targetExists(route.target)) throw new Error(`${route.classification.level === "easy" ? "Easy" : "Hard"} target "${route.target}" does not exist.`);
    } catch (error) {
      log.warn("AUTO-ROUTER", `${comboName} routing blocked: ${error.message}`);
      return errorResponse(error.message);
    }
    const { target, classification, config } = route;
    log.info("AUTO-ROUTER", `combo=${comboName} level=${classification.level} target=${target} score=${classification.score} reasons=${classification.reasons.join(",") || "none"}`);
    if (config.verbose) log.info("AUTO-ROUTER", `combo=${comboName} metadata=${JSON.stringify(classification.metadata)}`);
    return await delegate(body, target);
  } finally {
    nextActive.delete(comboName);
    if (nextActive.size === 0 && body && typeof body === "object") activeAutoCombos.delete(body);
  }
}

module.exports = { DEFAULTS, HARD_TERMS, STRONG_TERMS, WEAK_TERMS, getConfig, classifyTaskComplexity, selectRoute, routeAutoCombo, validateAutoTarget };
