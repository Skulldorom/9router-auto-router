"use strict";

const { createHash } = require("node:crypto");
const { DEFAULTS, NUMERIC_BOUNDS } = require("../auto-router-config.cjs");

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
// An unquoted investigative or structural action is itself meaningful intent. Keep
// `plan`, `implement`, and `resolve` out: those verbs frequently describe small edits.
const COMPLEX_ACTION_TERMS = [
  "audit", "review", "investigate", "analyze", "analyse", "assess", "diagnose",
  "debug", "refactor", "redesign", "restructure", "harden", "optimize", "optimise",
  "benchmark", "profile", "trace", "reproduce", "rewrite", "overhaul", "survey",
];
const SIMPLE_EDIT_ACTIONS = new Set(["add", "change", "correct", "edit", "fix", "rename", "replace", "set", "update"]);
const STRONG_TASK_PHRASES = Object.freeze([
  { reason: "audit", terms: ["fully audit", "deep review", "deep repository audit"] },
  { reason: "architecture", terms: ["design the architecture", "design architecture", "repository restructure", "rollback procedures"] },
  { reason: "review", terms: ["review"] },
  { reason: "trace", terms: ["trace"] },
  { reason: "concurrency", terms: ["race condition", "concurrency", "stale-write", "stale write"] },
  { reason: "root-cause", terms: ["root cause", "debug intermittent", "intermittent failing tests", "failing tests with unclear cause", "failures with unclear causes", "unclear failure"] },
  { reason: "precision", terms: ["financial precision", "decimal precision"] },
  { reason: "performance", terms: ["performance investigation"] },
  { reason: "architecture", terms: ["repository-wide", "multi-file", "cross-component", "cross component"] },
]);
const GATED_STRUCTURAL_TERMS = Object.freeze([
  { reason: "migration", terms: ["migration", "migrate", "rollback"] },
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
const jevPending = new Map();
const TEXT_FIELDS = new Set(["text", "content", "input_text", "output_text", "arguments", "output"]);
const USER_TEXT_FIELDS = new Set(["text", "content", "input_text"]);
const PART_FIELDS = new Set(["content", "parts", "input"]);
const MODALITY_TYPES = new Set(["image_url", "input_image", "input_file", "file", "document", "input_audio", "input_video"]);

function validBoundedInt(value, bounds) { return Number.isSafeInteger(value) && value >= bounds.min && value <= bounds.max ? value : null; }
function positiveInt(value, bounds, fallback) {
  if (typeof value !== "string" || !/^\s*[1-9]\d*\s*$/.test(value)) return fallback;
  return validBoundedInt(Number(value), bounds) ?? fallback;
}

function nonEmptyString(value) { return typeof value === "string" && value.trim() ? value.trim() : null; }
function booleanValue(value) {
  if (value === true || value === false) return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized === "true" ? true : normalized === "false" ? false : null;
}
function configuredString(explicit, key, legacy, fallback) { return nonEmptyString(explicit[key]) || nonEmptyString(legacy) || fallback; }
function configuredPositiveInt(explicit, key, legacy, fallback) { return validBoundedInt(explicit[key], NUMERIC_BOUNDS[key]) || positiveInt(legacy, NUMERIC_BOUNDS[key], fallback); }
function configuredBoolean(explicit, key, legacy, fallback) { return booleanValue(explicit[key]) ?? booleanValue(legacy) ?? fallback; }

function getConfig(env = process.env, explicit = {}) {
  const selected = explicit && typeof explicit === "object" && !Array.isArray(explicit) ? explicit : {};
  return {
    easyTarget: configuredString(selected, "easyTarget", env.AUTO_ROUTER_EASY_TARGET, DEFAULTS.easyTarget),
    hardTarget: configuredString(selected, "hardTarget", env.AUTO_ROUTER_HARD_TARGET, DEFAULTS.hardTarget),
    hardThreshold: configuredPositiveInt(selected, "hardThreshold", env.AUTO_ROUTER_HARD_THRESHOLD, DEFAULTS.hardThreshold),
    longContextChars: configuredPositiveInt(selected, "longContextChars", env.AUTO_ROUTER_LONG_CONTEXT_CHARS, DEFAULTS.longContextChars),
    largeToolResultChars: configuredPositiveInt(selected, "largeToolResultChars", env.AUTO_ROUTER_LARGE_TOOL_RESULT_CHARS, DEFAULTS.largeToolResultChars),
    verbose: configuredBoolean(selected, "verbose", env.AUTO_ROUTER_VERBOSE, DEFAULTS.verbose),
    method: selected.method === "jev" ? "jev" : "local",
    jev: (() => {
      const configured = selected.jev?.decisionModels;
      const decisionModels = Array.isArray(configured) ? configured.map(nonEmptyString) : [nonEmptyString(selected.jev?.decisionModel)].filter(Boolean);
      return { decisionModel: decisionModels[0] || null, decisionModels, timeoutMs: validBoundedInt(selected.jev?.timeoutMs, NUMERIC_BOUNDS.jevTimeoutMs) || DEFAULTS.jevTimeoutMs };
    })(),
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
function requestSource(body) {
  const nested = own(body, "request");
  return nested && typeof nested === "object" && !Array.isArray(nested) ? nested : body;
}
function requestCollections(body) {
  const source = requestSource(body);
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
  const state = { chars: 0, systemChars: 0, messageCount: 0, systemMessages: 0, toolCalls: 0, toolResults: 0, toolResultChars: 0, modalities: 0, userTexts: [] };
  if (!body || typeof body !== "object" || Array.isArray(body)) return state;
  for (const { items, stringInput } of requestCollections(body)) {
    for (const item of items) {
      if (stringInput) {
        state.messageCount += 1;
        state.chars += item.length;
        state.userTexts.push(item);
        continue;
      }
      // Agent clients commonly repeat a large system envelope for every request.
      // Track it for diagnostics without letting it inflate task-context scoring.
      if (own(item, "role") === "system") {
        state.systemMessages += 1;
        state.systemChars += contentLength(item, state);
      } else {
        state.messageCount += 1;
        state.chars += contentLength(item, state);
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
function normalizeTools(body) {
  const source = requestSource(body);
  return Array.isArray(own(source, "tools")) ? own(source, "tools") : Array.isArray(own(source, "functions")) ? own(source, "functions") : [];
}
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
  // A complex verb buried in a small edit ("add a debug log") is not enough.
  // Leading unquoted task actions remain robust to aliases while quoted labels stay inert.
  const complexAction = !SIMPLE_EDIT_ACTIONS.has(tokens[0]?.value) && tokens.slice(0, 4).some((token) => !token.quoted && COMPLEX_ACTION_TERMS.includes(token.value));
  return {
    strong,
    complexAction,
    // Quoted nouns remain inert by themselves. Once an unquoted action establishes
    // task intent, quoted domain context is meaningful and receives normal weight.
    gated: taskOriented ? reasonsFor(GATED_STRUCTURAL_TERMS, true) : [],
    weak: taskOriented ? reasonsFor(WEAK_DOMAIN_TERMS, true) : [],
  };
}

function classifyTaskComplexity(body, config = getConfig()) {
  try {
    if (!body || typeof body !== "object" || Array.isArray(body)) return { level: "hard", score: config.hardThreshold, escalationScore: config.hardThreshold, reasons: ["invalid-request"], metadata: {} };
    const state = inspectRequest(body), tools = normalizeTools(body);
    if (state.chars === 0 && state.messageCount === 0) return { level: "hard", score: config.hardThreshold, escalationScore: config.hardThreshold, reasons: ["empty-request"], metadata: {} };
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
    if (state.modalities >= 3) add(2, "multiple-modalities");
    else if (state.modalities > 0) add(1, "modality-present");
    const latest = state.userTexts.at(-1) || "";
    const latestMatches = keywordMatches(latest);
    for (const reason of latestMatches.strong) add(STRONG_WEIGHT, reason);
    if (latestMatches.complexAction && latestMatches.strong.length === 0) add(STRONG_WEIGHT, "complex-action");
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
    const escalationScore = score;
    score = Math.min(score, config.hardThreshold + 1);
    return { level: score >= config.hardThreshold ? "hard" : "easy", score, escalationScore, reasons: [...new Set(reasons)], metadata: { chars: state.chars, systemChars: state.systemChars, messages: state.messageCount, systemMessages: state.systemMessages, tools: tools.length, toolCalls: state.toolCalls, toolResults: state.toolResults, toolResultChars: state.toolResultChars, modalities: state.modalities } };
  } catch {
    return { level: "hard", score: config.hardThreshold, escalationScore: config.hardThreshold, reasons: ["classifier-error"], metadata: {} };
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

function legacyTargets(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) return null;
  const easy = nonEmptyString(config.easyTarget), hard = nonEmptyString(config.hardTarget);
  return easy && hard ? [easy, hard] : null;
}
function orderedTargets(models) {
  if (!Array.isArray(models)) return null;
  const targets = models.map(nonEmptyString);
  return targets.length && !targets.some((target) => !target) ? targets : null;
}
function effectiveTargets(models, persisted) {
  const targets = legacyTargets(persisted) || orderedTargets(models);
  if (!targets || new Set(targets).size !== targets.length) throw new Error("requires one or more distinct usable ordered models.");
  return targets;
}
function jevCandidates(models) {
  const candidates = effectiveTargets(models);
  if (candidates.length > 255) throw new Error("Jev supports at most 255 candidates.");
  return candidates;
}
function selectLocalRank({ escalationScore, candidateCount, hardThreshold }) {
  if (!Number.isSafeInteger(candidateCount) || candidateCount < 1) throw new Error("requires one or more distinct usable ordered models.");
  if (candidateCount === 1) return 0;
  const score = Number.isFinite(escalationScore) ? Math.max(0, escalationScore) : hardThreshold;
  if (candidateCount === 2) return score >= hardThreshold ? 1 : 0;
  return Math.min(candidateCount - 1, Math.floor(score / hardThreshold));
}
function localTargetLabel(index, candidateCount) {
  return candidateCount === 2 ? index === 0 ? "Easy" : "Hard" : `Local rank ${index + 1}`;
}
function selectRoute(body, comboName, { env = process.env, comboStrategies = {}, globalStrategy = "fallback", knownCombos, models, ignoreLegacyTargets = false } = {}) {
  const persisted = comboStrategies?.[comboName]?.autoRouter, legacy = ignoreLegacyTargets ? null : legacyTargets(persisted);
  const targets = legacy || effectiveTargets(models);
  if (new Set(targets).size !== targets.length) throw new Error("requires one or more distinct usable ordered models.");
  const config = { ...getConfig(env, persisted), easyTarget: targets[0], hardTarget: targets[1] || targets[0] }, classification = classifyTaskComplexity(body, config);
  const index = selectLocalRank({ escalationScore: classification.escalationScore, candidateCount: targets.length, hardThreshold: config.hardThreshold });
  const target = targets[index];
  validateAutoTarget(comboName, target, comboStrategies, globalStrategy, knownCombos ? new Set(knownCombos) : null, localTargetLabel(index, targets.length));
  return { target, index, candidates: targets, classification, config, legacy: Boolean(legacy) };
}
function truncate(value, limit) { return value.length > limit ? `${value.slice(0, limit)}…` : value; }
function jevRequest(body, candidates, startIndex = 0) {
  const inspected = inspectRequest(body);
  const latest = truncate(inspected.userTexts.at(-1) || "", 4000);
  const previous = inspected.userTexts.slice(-3, -1).map((text) => truncate(text, 600)).filter(Boolean);
  const state = [
    `Request metadata: messages=${inspected.messageCount}; chars=${inspected.chars}; system_messages=${inspected.systemMessages}; system_chars=${inspected.systemChars}; tool_calls=${inspected.toolCalls}; tool_results=${inspected.toolResults}; tool_result_chars=${inspected.toolResultChars}; modalities=${inspected.modalities}.`,
    previous.length ? `Relevant previous user context:\n${previous.join("\n")}` : "",
    `Current user request:\n${latest || "(no extractable user text)"}`,
  ].filter(Boolean).join("\n\n");
  const criteria = Object.fromEntries(candidates.map((candidate, index) => {
    const rank = startIndex + index + 1;
    return [`candidate_${rank}`, `Candidate ${rank}: ${candidate}. Tier ${rank}${rank === 1 ? "; lowest cost and capability" : index === candidates.length - 1 ? "; highest cost and capability" : ""}.`];
  }));
  return {
    model: "",
    state,
    questions: {
      candidate: {
        type: "choice",
        instructions: "Select the lowest-tier candidate that is sufficiently capable to complete the request reliably. Choose only from these candidates.",
        criteria,
      },
    },
  };
}
async function responseJson(response) {
  if (!response || typeof response !== "object") throw new Error("invalid-response");
  if (typeof response.json === "function") return response.json();
  if (typeof response.text === "function") {
    const raw = await response.text();
    try { return JSON.parse(raw); } catch { throw new Error("invalid-response"); }
  }
  return response;
}
function candidateIndex(response, candidates, startIndex = 0) {
  const answer = response?.answers?.candidate;
  const choice = answer?.type === "choice" ? answer.choice : null;
  const match = typeof choice === "string" ? /^candidate_(\d+)$/.exec(choice) : null;
  if (!match) throw new Error("invalid-output");
  const index = Number(match[1]) - 1;
  if (!Number.isSafeInteger(index) || index < startIndex || index >= startIndex + candidates.length) throw new Error("invalid-candidate");
  return index - startIndex;
}
function deadline(start, timeoutMs, timers = globalThis) {
  const controller = new globalThis.AbortController();
  let timeout;
  const expired = new Promise((_, reject) => {
    timeout = timers.setTimeout(() => {
      reject(new Error("timeout"));
      controller.abort();
    }, timeoutMs);
  });
  let pending;
  try { pending = Promise.resolve(start(controller.signal)); }
  catch (error) { pending = Promise.reject(error); }
  return Promise.race([pending, expired]).finally(() => timers.clearTimeout(timeout));
}
function failureReason(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message === "timeout" || message === "invalid-output" || message === "invalid-candidate" ? message : "decision-error";
}
function jevFailureStage(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message === "timeout") return "timeout";
  if (message === "systemone-invalid-origin") return "internal-invalid-origin";
  if (message === "systemone-network") return "internal-network";
  if (/^systemone-http-(?:[1-5]\d\d|unknown)$/.test(message)) return `internal-systemone-http status=${message.slice("systemone-http-".length)}`;
  if (message === "invalid-response" || message === "invalid-output" || message === "invalid-candidate") return "invalid-decision-response";
  return "decision-error";
}
function logJevFailure(log, comboName, decisionModel, error) {
  log.warn("AUTO-ROUTER", `combo=${comboName} method=jev decision_model=${decisionModel} decision_failure stage=${jevFailureStage(error)}`);
}
function jevOptions(comboName, { comboStrategies = {}, globalStrategy = "fallback", models } = {}) {
  const persisted = comboStrategies?.[comboName]?.autoRouter;
  const config = getConfig(process.env, persisted), candidates = jevCandidates(models), decisionModels = config.jev.decisionModels;
  if (!decisionModels.length || decisionModels.length > 2 || decisionModels.some((model) => !model)) throw new Error("Jev requires a primary and optional valid fallback decision model.");
  if (new Set(decisionModels).size !== decisionModels.length) throw new Error("Jev decision models must be distinct.");
  for (const candidate of candidates) validateAutoTarget(comboName, candidate, comboStrategies, globalStrategy, null, "Jev candidate");
  return { config, candidates };
}
async function selectJevRoute({ body, comboName, comboStrategies, globalStrategy, models, decide, startIndex = 0, prepared, log }) {
  const { config, candidates } = prepared || jevOptions(comboName, { comboStrategies, globalStrategy, models });
  if (typeof decide !== "function") throw new Error("decision-error");
  const allowed = candidates.slice(startIndex);
  if (!allowed.length) throw new Error("invalid-candidate");
  const failures = [];
  try {
    return await deadline(async (signal) => {
      for (const decisionModel of config.jev.decisionModels) {
        try {
          const request = jevRequest(body, allowed, startIndex);
          request.model = decisionModel;
          const index = startIndex + candidateIndex(await responseJson(await decide(request, decisionModel, signal)), allowed, startIndex);
          return { target: candidates[index], index, candidates, config, decisionModel };
        } catch (error) {
          failures.push({ decisionModel, error });
          logJevFailure(log || { warn() {} }, comboName, decisionModel, error);
          if (signal.aborted) throw error;
        }
      }
      const error = failures.at(-1)?.error || new Error("decision-error");
      error.jevFailures = failures;
      throw error;
    }, config.jev.timeoutMs);
  } catch (error) {
    if (!error.jevFailures && error.message === "timeout") {
      const decisionModel = config.jev.decisionModels[failures.length] || config.jev.decisionModels.at(-1);
      if (!failures.some((failure) => failure.decisionModel === decisionModel && failure.error === error)) logJevFailure(log || { warn() {} }, comboName, decisionModel, error);
    }
    throw error;
  }
}
// Jev candidates are always the ordered combo models, so an exhausted decision chain must
// rank the same list. Dormant legacy targets belong to Local classification only.
function selectJevFallbackRoute(body, comboName, options = {}) { return selectRoute(body, comboName, { ...options, ignoreLegacyTargets: true }); }
const CONVERSATION_FIELDS = ["conversation_id", "conversationId", "session_id", "sessionId", "thread_id", "threadId"];
const CONVERSATION_HEADERS = ["x-9router-conversation-id", "x-conversation-id", "x-session-id", "x-thread-id"];
function conversationValue(value) { return nonEmptyString(value) && value.trim().length <= 256 ? value.trim() : null; }
function headerConversationIdentities(headers) {
  if (!headers || typeof headers !== "object") return [];
  const values = new Map(), entries = typeof headers.entries === "function" ? headers.entries() : Object.entries(headers);
  for (const [key, value] of entries) {
    const normalized = key.toLowerCase();
    if (CONVERSATION_HEADERS.includes(normalized) && !values.has(normalized)) values.set(normalized, conversationValue(value));
  }
  return CONVERSATION_HEADERS.map((header) => values.get(header)).filter(Boolean);
}
function conversationContainers(body) {
  const source = requestSource(body);
  return source === body ? [body] : [body, source];
}
function resolveConversationIdentity({ body, headers } = {}) {
  const header = headerConversationIdentities(headers)[0];
  if (header) return header;
  const containers = conversationContainers(body).filter((container) => container && typeof container === "object" && !Array.isArray(container));
  for (const container of containers) for (const key of CONVERSATION_FIELDS) {
    const value = conversationValue(own(container, key));
    if (value) return value;
  }
  for (const container of containers) for (const key of ["conversation", "session", "thread"]) {
    const nested = own(container, key), value = conversationValue(typeof nested === "object" && nested ? own(nested, "id") : nested);
    if (value) return value;
  }
  for (const container of containers) {
    const metadata = own(container, "metadata");
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) continue;
    for (const key of CONVERSATION_FIELDS) {
      const value = conversationValue(own(metadata, key));
      if (value) return value;
    }
  }
  return null;
}
function stableConversationId(body) { return resolveConversationIdentity({ body }); }
// Pending decisions use hashed client/conversation identity only for isolation and coalescing.
function identityHash(identity) { return createHash("sha256").update(identity).digest("hex"); }
function pendingScope(comboName, body, clientIdentity, headers) {
  const conversation = resolveConversationIdentity({ body, headers }), client = nonEmptyString(clientIdentity);
  return conversation && client ? `${comboName}\u0000${identityHash(client)}\u0000${identityHash(conversation)}` : null;
}
function candidateSignature(candidates, decisionModels = []) { return JSON.stringify({ candidates, decisionModels }); }
function decisionFingerprint(body, candidates, decisionModels) {
  const request = jevRequest(body, candidates, 0);
  request.model = decisionModels;
  return createHash("sha256").update(JSON.stringify(request)).digest("hex");
}
function pendingKey(comboName, body, clientIdentity, headers, candidates = [], decisionModels = []) {
  const scope = pendingScope(comboName, body, clientIdentity, headers);
  return scope ? `${scope}\u0000${identityHash(candidateSignature(candidates, decisionModels))}\u0000${decisionFingerprint(body, candidates, decisionModels)}` : null;
}
function pendingSelection(key, select) {
  if (!key) return { promise: Promise.resolve().then(select) };
  const pending = jevPending.get(key);
  if (pending) return { promise: pending.promise };
  const entry = { promise: Promise.resolve().then(select) };
  jevPending.set(key, entry);
  entry.promise.then(
    () => { if (jevPending.get(key) === entry) jevPending.delete(key); },
    () => { if (jevPending.get(key) === entry) jevPending.delete(key); },
  );
  return { promise: entry.promise };
}
function errorResponse(message) { return new Response(JSON.stringify({ error: { message: `AUTO-ROUTER: ${message}` } }), { status: 400, headers: { "Content-Type": "application/json" } }); }
async function routeAutoCombo({ body, comboName, comboStrategies, globalStrategy, log, delegate, targetExists, models, decide, clientIdentity, conversationHeaders }) {
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
    const persisted = comboStrategies?.[comboName]?.autoRouter;
    const method = getConfig(process.env, persisted).method;
    let route, source = "local", failure = null;
    if (method === "jev") {
      let prepared;
      try { prepared = jevOptions(comboName, { comboStrategies, globalStrategy, models }); }
      catch (error) { log.warn("AUTO-ROUTER", `${comboName} routing blocked: ${error.message}`); return errorResponse(error.message); }
      const key = pendingKey(comboName, body, clientIdentity, conversationHeaders, prepared.candidates, prepared.config.jev.decisionModels);
      const selection = pendingSelection(key, () => selectJevRoute({ body, comboName, comboStrategies, globalStrategy, models, decide, prepared, log }));
      try {
        route = { ...await selection.promise, classification: classifyTaskComplexity(body, prepared.config) };
        source = "jev";
      } catch (error) {
        failure = failureReason(error);
        const decisionModels = prepared.config.jev.decisionModels;
        log.info("AUTO-ROUTER", `combo=${comboName} method=jev ${decisionModels.length === 1 ? "no fallback JEV configured" : "all configured JEV decision models failed"}; using local router`);
        route = selectJevFallbackRoute(body, comboName, { comboStrategies, globalStrategy, models });
        source = "local-fallback";
      }
    } else {
      try { route = selectRoute(body, comboName, { comboStrategies, globalStrategy, models }); }
      catch (error) { log.warn("AUTO-ROUTER", `${comboName} routing blocked: ${error.message}`); return errorResponse(error.message); }
    }
    const { target, config } = route;
    if (targetExists) {
      const exists = await targetExists(target);
      if (!exists) {
        const label = source === "local-fallback" || source === "local" ? localTargetLabel(route.index, route.candidates.length) : "Jev candidate";
        const message = `${label} target "${target}" does not exist.`;
        log.warn("AUTO-ROUTER", `${comboName} routing blocked: ${message}`);
        return errorResponse(message);
      }
    }
    if (source === "jev") log.info("AUTO-ROUTER", `combo=${comboName} method=jev decision_model=${route.decisionModel} selected=${target} rank=${route.index + 1}/${route.candidates.length} source=jev`);
    else if (source === "local-fallback") log.info("AUTO-ROUTER", `combo=${comboName} method=jev selected=${target} rank=${route.index + 1}/${route.candidates.length} source=local-fallback reason=${failure}`);
    else log.info("AUTO-ROUTER", `combo=${comboName} method=local rank=${route.index + 1}/${route.candidates.length} score=${route.classification.escalationScore} target=${target} reasons=${route.classification.reasons.join(",") || "none"}`);
    if (config.verbose && route.classification) log.info("AUTO-ROUTER", `combo=${comboName} metadata=${JSON.stringify(route.classification.metadata)}`);
    return await delegate(body, target);
  } finally {
    nextActive.delete(comboName);
    if (nextActive.size === 0 && body && typeof body === "object") activeAutoCombos.delete(body);
  }
}

module.exports = { DEFAULTS, NUMERIC_BOUNDS, HARD_TERMS, STRONG_TERMS, WEAK_TERMS, getConfig, classifyTaskComplexity, selectRoute, selectLocalRank, routeAutoCombo, validateAutoTarget, effectiveTargets, jevCandidates, jevRequest, candidateIndex, deadline, stableConversationId, resolveConversationIdentity, pendingKey };
