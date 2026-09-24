import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import router from "../src/auto-router.cjs";

const { classifyTaskComplexity, selectRoute: selectConfiguredRoute } = router;
const selectRoute = (body, comboName, options = {}) => selectConfiguredRoute(body, comboName, { models: ["coder", "coder-high"], ...options });
const routeAutoCombo = (options) => router.routeAutoCombo({ models: ["coder", "coder-high"], ...options });
const message = (content) => ({ model: "coder-auto", messages: [{ role: "user", content }] });
const classifierCorpus = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, "fixtures/classifier-corpus.json"), "utf8"));
const openHandsToolSchema = { type: "object", properties: { instructions: { type: "string", description: "Tool-schema boilerplate. ".repeat(80) } } };
const openHandsTools = Array.from({ length: 43 }, (_, index) => ({ type: "function", function: { name: `openhands_tool_${index}`, description: `Sanitized OpenHands tool ${index}`, parameters: openHandsToolSchema } }));
const harness = (request) => ({ model: "coder-auto", stream: true, tools: openHandsTools, messages: [
  { role: "system", content: "You are a software engineering agent. Inspect the repository, preserve request bodies and tools, and make focused changes. ".repeat(250) },
  { role: "system", content: "Workspace: /workspace/project. Follow project instructions. Do not expose credentials. Use repository tests." },
  { role: "user", content: request },
] });

test("classifier corpus preserves routing policy boundaries", () => {
  for (const { prompt, level } of classifierCorpus) {
    const result = classifyTaskComplexity(message(prompt));
    assert.equal(result.level, level, prompt);
    assert.equal(selectRoute(message(prompt), "coder-auto").target, level === "easy" ? "coder" : "coder-high", prompt);
  }
});

test("classifier corpus covers realistic long conversations and tool results", () => {
  const longConversation = message("continue the implementation");
  for (let index = 0; index < 16; index += 1) longConversation.messages.unshift({ role: index % 2 ? "assistant" : "user", content: index === 0 ? "context ".repeat(4000) : `turn ${index}` });
  assert.equal(classifyTaskComplexity(longConversation).level, "hard");

  const substantialToolHistory = message("continue");
  for (let index = 0; index < 4; index += 1) {
    substantialToolHistory.messages.unshift({ role: "tool", content: `tool result ${"x".repeat(3500)}` });
    substantialToolHistory.messages.unshift({ role: "assistant", tool_calls: [{ id: `call_${index}` }] });
  }
  assert.equal(classifyTaskComplexity(substantialToolHistory).level, "hard");
});

test("short simple prompt and small single-file edit are easy", () => {
  assert.equal(classifyTaskComplexity(message("What is a JavaScript closure?")).level, "easy");
  assert.equal(classifyTaskComplexity(message("Update src/index.js to rename one function.")).level, "easy");
});

test("continue only becomes hard from substantial actual history, not old semantic words", () => {
  const trivial = { messages: [{ role: "user", content: "Rename one label." }, { role: "assistant", content: "Done." }, { role: "user", content: "continue" }] };
  assert.equal(classifyTaskComplexity(trivial).level, "easy");

  const semanticOnly = { messages: [
    ...Array.from({ length: 12 }, () => ({ role: "user", content: "Fully audit security architecture migration." })),
    { role: "user", content: "continue" },
  ] };
  assert.equal(classifyTaskComplexity(semanticOnly).level, "easy");

  const worked = { messages: [{ role: "user", content: "Investigate the production incident." }] };
  for (let index = 0; index < 8; index += 1) {
    worked.messages.push({ role: "assistant", tool_calls: [{ id: `call-${index}` }] });
    worked.messages.push({ role: "tool", content: "diagnostic result ".repeat(1200) });
  }
  worked.messages.push({ role: "user", content: "continue" });
  assert.equal(classifyTaskComplexity(worked).level, "hard");
});

test("canonical populated request shapes have identical semantic isolation", () => {
  const hard = "Investigate a race condition in settings persistence.";
  const easy = "Rename the Save button.";
  const shapes = [
    { messages: [{ role: "user", content: easy }], input: hard, contents: [{ role: "user", parts: [{ text: hard }] }] },
    { messages: [], input: [{ role: "user", content: [{ type: "input_text", text: easy }] }], contents: [{ role: "user", parts: [{ text: hard }] }] },
    { messages: [], input: [], contents: [{ role: "user", parts: [{ text: easy }] }] },
    { request: { messages: [], input: easy, contents: [{ role: "user", parts: [{ text: hard }] }] } },
  ];
  for (const body of shapes) assert.equal(classifyTaskComplexity(body).level, "easy");
  for (const body of [{ messages: [] }, { input: [] }, { contents: [] }, { messages: [], input: [], contents: [] }]) assert.equal(classifyTaskComplexity(body).level, "hard");
});

test("nested request wrappers use their canonical tool or function collection", () => {
  const easy = { request: { messages: [{ role: "user", content: "Rename one label." }], tools: [{ type: "function" }] }, tools: Array.from({ length: 32 }, () => ({ type: "function" })) };
  const functions = { request: { messages: [{ role: "user", content: "Rename one label." }], functions: Array.from({ length: 16 }, () => ({ name: "legacy" })) }, functions: [] };
  const outerOnly = { request: { messages: [{ role: "user", content: "Rename one label." }] }, tools: Array.from({ length: 32 }, () => ({ type: "function" })) };
  assert.equal(classifyTaskComplexity(easy).metadata.tools, 1);
  assert.equal(classifyTaskComplexity(easy).level, "easy");
  assert.equal(classifyTaskComplexity(functions).metadata.tools, 16);
  assert.ok(!classifyTaskComplexity(functions).reasons.includes("large-toolset"));
  assert.equal(classifyTaskComplexity(outerOnly).metadata.tools, 0);
});

test("numeric configuration accepts documented boundaries and rejects adjacent values", () => {
  const fields = Object.entries(router.NUMERIC_BOUNDS);
  const explicit = Object.fromEntries(fields.map(([key, bounds]) => [key, bounds.max]));
  assert.deepEqual(router.getConfig({}, explicit), { ...router.DEFAULTS, ...explicit });

  for (const [key, { min, max }] of fields) {
    const environment = { [`AUTO_ROUTER_${key.replace(/[A-Z]/g, (letter) => `_${letter}`).toUpperCase()}`]: String(max) };
    assert.equal(router.getConfig(environment, { [key]: min })[key], min, `${key} minimum`);
    assert.equal(router.getConfig(environment, { [key]: max })[key], max, `${key} maximum`);
    assert.equal(router.getConfig(environment, { [key]: min - 1 })[key], max, `${key} below minimum falls through`);
    assert.equal(router.getConfig(environment, { [key]: max + 1 })[key], max, `${key} above maximum falls through`);
    assert.equal(router.getConfig({ ...environment, [Object.keys(environment)[0]]: String(max + 1) }, { [key]: min - 1 })[key], router.DEFAULTS[key], `${key} invalid sources use default`);
  }
});

test("large static OpenHands envelope routes a trivial task to coder", () => {
  const body = harness("test");
  const result = classifyTaskComplexity(body);
  assert.equal(JSON.stringify(body).length > 90000, true);
  assert.equal(result.level, "easy"); assert.equal(selectRoute(body, "coder-auto").target, "coder");
  assert.equal(result.score, 0); assert.deepEqual(result.reasons, []);
  assert.equal(result.metadata.chars, 4); assert.equal(result.metadata.messages, 1); assert.equal(result.metadata.tools, 43);
  assert.equal(result.metadata.systemMessages, 2); assert.ok(result.metadata.systemChars >= router.DEFAULTS.longContextChars);
});
test("large static OpenHands envelope still routes complex coding work to coder-high", () => {
  const body = harness("Investigate and debug the intermittent failing tests, implement the multi-file fix, and verify the regression suite.");
  const result = classifyTaskComplexity(body);
  assert.equal(result.level, "hard"); assert.equal(selectRoute(body, "coder-auto").target, "coder-high");
  assert.ok(result.reasons.includes("root-cause")); assert.ok(result.reasons.includes("architecture"));
  assert.ok(!result.reasons.includes("large-context"));
});
test("short OpenHands follow-up keeps meaningful complex history", () => {
  const body = harness("fix it");
  for (let index = 0; index < 4; index += 1) {
    body.messages.splice(-1, 0,
      { role: "assistant", tool_calls: [{ id: `call_${index}`, type: "function", function: { name: "terminal", arguments: "{}" } }] },
      { role: "tool", tool_call_id: `call_${index}`, content: "failing test diagnostics ".repeat(800) },
    );
  }
  const result = classifyTaskComplexity(body);
  assert.equal(result.level, "hard"); assert.equal(selectRoute(body, "coder-auto").target, "coder-high");
  assert.ok(result.reasons.includes("substantial-tool-history"));
  assert.ok(result.reasons.includes("large-tool-result-history"));
});
test("actual tool activity and accumulated history outweigh available tools", () => {
  const body = harness("The tests still fail; continue debugging.");
  for (let index = 0; index < 5; index += 1) {
    body.messages.push({ role: "assistant", tool_calls: [{ id: `call_${index}`, type: "function", function: { name: "terminal", arguments: "{}" } }] });
    body.messages.push({ role: "tool", tool_call_id: `call_${index}`, content: `test failure ${index}: ${"assertion output ".repeat(600)}` });
  }
  const result = classifyTaskComplexity(body);
  assert.equal(result.level, "hard"); assert.match(result.reasons.join(","), /substantial-tool-history/); assert.match(result.reasons.join(","), /(?:medium|large)-tool-result-history/);
});
test("simple follow-up uses accumulated history instead of only continue", () => {
  const body = harness("continue");
  body.messages.splice(2, 0, { role: "user", content: "Change the Save button label to Save changes." }, { role: "assistant", tool_calls: [{ id: "a", type: "function", function: { name: "file_editor", arguments: "{}" } }] }, { role: "tool", tool_call_id: "a", content: "src/Button.jsx" }, { role: "assistant", tool_calls: [{ id: "b", type: "function", function: { name: "terminal", arguments: "{}" } }] }, { role: "tool", tool_call_id: "b", content: "tests pass" });
  const result = classifyTaskComplexity(body);
  assert.equal(result.level, "easy"); assert.ok(result.reasons.includes("repeated-tool-history"));
});
test("high-signal task language is hard without keyword score explosion", () => {
  for (const prompt of ["Fully audit this repository.", "Plan a database migration.", "Investigate this concurrency race condition."]) assert.equal(classifyTaskComplexity(message(prompt)).level, "hard", prompt);
  const result = classifyTaskComplexity(message("Fully audit this concurrency race condition."));
  assert.equal(result.score, 7); assert.deepEqual(result.reasons, ["audit", "concurrency"]);
});
test("context and modality signals are gradual rather than independent hard routes", () => {
  assert.match(classifyTaskComplexity(message("x".repeat(24000))).reasons.join(","), /large-context/);
  assert.equal(classifyTaskComplexity({ ...message("small image caption"), messages: [{ role: "user", content: [{ type: "image_url", image_url: { url: "https://example.invalid/x.png" } }] }] }).level, "easy");
  assert.equal(classifyTaskComplexity({ ...message("help"), tools: Array.from({ length: 80 }, (_, n) => ({ type: "function", function: { name: `tool_${n}` } })) }).level, "easy");
});
test("OpenAI Responses and Anthropic-shaped bodies are inspected", () => {
  assert.equal(classifyTaskComplexity({ model: "coder-auto", input: [{ role: "user", content: [{ type: "input_text", text: "deep review this architecture" }] }] }).level, "hard");
  assert.equal(classifyTaskComplexity({ model: "coder-auto", contents: [{ role: "user", parts: [{ text: "small edit" }] }] }).level, "easy");
});

test("canonical request representation prevents translated duplicates from inflating complexity", async () => {
  const simple = "Rename this button.";
  const translatedHard = "Fully audit this repository for a concurrency race condition.";
  const duplicated = {
    messages: [{ role: "user", content: simple }],
    input: [
      { role: "user", content: [{ type: "input_text", text: translatedHard }] },
      { role: "assistant", tool_calls: Array.from({ length: 8 }, (_, index) => ({ id: `call-${index}` })) },
      ...Array.from({ length: 8 }, () => ({ type: "function_call_output", output: "x".repeat(4000) })),
    ],
    contents: [{ role: "user", parts: [{ type: "input_image", image_url: { url: "https://example.invalid/large.png" } }, { text: translatedHard }] }],
  };
  const result = classifyTaskComplexity(duplicated);
  assert.equal(result.level, "easy");
  assert.equal(result.metadata.messages, 1);
  assert.equal(result.metadata.chars, simple.length);
  assert.equal(result.metadata.toolCalls, 0);
  assert.equal(result.metadata.toolResults, 0);
  assert.equal(result.metadata.toolResultChars, 0);
  assert.equal(result.metadata.modalities, 0);
  assert.ok(!result.reasons.includes("audit"));

  const inputWins = classifyTaskComplexity({ input: "Rename this input.", contents: [{ role: "user", parts: [{ text: translatedHard }] }] });
  assert.equal(inputWins.level, "easy");
  assert.equal(inputWins.metadata.messages, 1);
  for (const body of [
    { messages: [], input: translatedHard },
    { messages: [], contents: [{ role: "user", parts: [{ text: translatedHard }] }] },
    { input: [], contents: [{ role: "user", parts: [{ text: translatedHard }] }] },
    { messages: [], input: [], contents: [{ role: "user", parts: [{ text: translatedHard }] }] },
  ]) assert.equal(classifyTaskComplexity(body).level, "hard");
  assert.equal(classifyTaskComplexity({ messages: [], input: [], contents: [] }).reasons.includes("empty-request"), true);
  assert.equal(classifyTaskComplexity({ request: duplicated }).metadata.messages, 1);
  const calls = [];
  await routeAutoCombo({ body: duplicated, comboName: "auto", comboStrategies: { auto: { autoRouter: { easyTarget: "easy", hardTarget: "hard" } } }, log: { info() {}, warn() {} }, delegate: (body, target) => { calls.push({ body, target }); return new Response("ok"); } });
  assert.deepEqual(calls, [{ body: duplicated, target: "easy" }]);
});

test("historical semantic evidence is bounded below the hard threshold", () => {
  const oldAudit = Array.from({ length: 7 }, (_, index) => ({ role: "user", content: `Fully audit architecture security migration ${index}.` }));
  const trivial = { messages: [...oldAudit, { role: "user", content: "Rename this button." }] };
  const result = classifyTaskComplexity(trivial);
  assert.equal(result.level, "easy");
  assert.equal(result.score, 5);

  const oldDomains = Array.from({ length: 7 }, (_, index) => ({ role: "user", content: `Investigate security architecture permissions migration ${index}.` }));
  assert.equal(classifyTaskComplexity({ messages: [...oldDomains, { role: "user", content: "Change one label." }] }).level, "easy");
  assert.equal(classifyTaskComplexity({ messages: [{ role: "user", content: "Rename this button." }, { role: "user", content: "Fully audit this repository." }] }).level, "hard");
  const customThreshold = classifyTaskComplexity({ messages: [{ role: "user", content: "Fully audit this repository." }, { role: "user", content: "Rename this button." }] }, { ...router.DEFAULTS, hardThreshold: 3 });
  assert.equal(customThreshold.level, "easy");
  assert.equal(customThreshold.score, 2);

  const followUp = { messages: [{ role: "user", content: "Investigate the concurrency race condition." }] };
  for (let index = 0; index < 4; index += 1) {
    followUp.messages.push({ role: "assistant", tool_calls: [{ id: `call-${index}` }] });
    followUp.messages.push({ role: "tool", content: "result ".repeat(2500) });
  }
  followUp.messages.push({ role: "user", content: "continue" });
  assert.equal(classifyTaskComplexity(followUp).level, "hard");
});

test("action matching uses whole intent tokens and ignores quoted labels", () => {
  for (const prompt of [
    "Rename the migrationPlan field.",
    "Change ArchitecturePreview to ArchitectureView.",
    "Update template migration-plan.json.",
    "Rename resolveMigrationState.",
    "Rename reviewStatus to approvalStatus.",
    "Change auditLabel to activityLabel.",
  ]) {
    const result = classifyTaskComplexity(message(prompt));
    assert.equal(result.level, "easy", prompt);
    assert.ok(result.score < 6, prompt);
  }
  for (const prompt of [
    "Fully audit this repository.",
    "Review this implementation.",
    "Plan a database migration.",
    "Trace this request through the service.",
    "Resolve this concurrency issue.",
  ]) assert.equal(classifyTaskComplexity(message(prompt)).level, "hard", prompt);
});

test("supported request formats extract only explicit user intent", () => {
  const hard = "Fully audit this repository for concurrency bugs.";
  const simple = "Rename this button.";
  const noisy = "audit security architecture migration concurrency";
  const formats = [
    (request) => ({ messages: [{ role: "system", content: noisy }, { role: "assistant", content: noisy }, { role: "tool", content: noisy }, { role: "user", content: request }] }),
    (request) => ({ input: [{ role: "system", content: [{ type: "input_text", text: noisy }] }, { role: "assistant", content: [{ type: "output_text", text: noisy }] }, { type: "function_call_output", output: noisy }, { role: "user", content: [{ type: "input_text", text: request }] }] }),
    (request) => ({ contents: [{ role: "system", parts: [{ text: noisy }] }, { role: "assistant", parts: [{ text: noisy }] }, { role: "user", parts: [{ text: request }] }] }),
    (request) => ({ request: { messages: [{ role: "system", content: noisy }, { role: "user", content: "Rename a previous label." }, { role: "assistant", tool_calls: [{ id: "call", type: "function", function: { name: "terminal", arguments: noisy } }] }, { role: "tool", content: noisy }, { role: "user", content: request }] }, metadata: { prompt: noisy } }),
  ];
  for (const format of formats) {
    assert.equal(classifyTaskComplexity(format(simple)).level, "easy");
    assert.equal(classifyTaskComplexity(format(hard)).level, "hard");
  }
  assert.equal(classifyTaskComplexity({ input: hard }).level, "hard");
  assert.equal(classifyTaskComplexity({ input: simple }).level, "easy");
});

test("punctuation-aware phrases preserve identifier and filename safety", () => {
  for (const prompt of [
    "Fully audit this repository.",
    "Fully-audit this repository.",
    "Fully: audit this repository.",
    "Deep review this implementation.",
    "Deep-review this implementation.",
    "Investigate the root cause.",
    "Investigate the root-cause.",
    "Debug this race condition.",
    "Debug this race-condition.",
    "Plan a database migration.",
    "Trace this request through the service.",
    "Resolve this concurrency issue.",
  ]) assert.equal(classifyTaskComplexity(message(prompt)).level, "hard", prompt);
  for (const prompt of [
    "Rename the migrationPlan field.",
    "Change ArchitecturePreview to ArchitectureView.",
    "Update template migration-plan.json.",
    "Rename resolveMigrationState.",
    "Rename reviewStatus to approvalStatus.",
    "Change auditLabel to activityLabel.",
    "Rename the review-status field.",
  ]) assert.equal(classifyTaskComplexity(message(prompt)).level, "easy", prompt);
});

test("unquoted actions can score quoted domain context without scoring quoted labels", () => {
  for (const prompt of [
    'Rename "review".',
    'Change the "audit" label.',
    'Rename "migrationPlan".',
    'Update "ArchitecturePreview".',
  ]) assert.equal(classifyTaskComplexity(message(prompt)).level, "easy", prompt);
  for (const [prompt, reason] of [
    ['Investigate "authentication architecture" for vulnerabilities.', "architecture"],
    ['Audit the "permissions migration" implementation.', "migration"],
    ['Review the "security architecture".', "architecture"],
  ]) {
    const result = classifyTaskComplexity(message(prompt));
    assert.equal(result.level, "hard", prompt);
    assert.ok(result.reasons.includes(reason), prompt);
  }
});


test("malformed and empty requests safely choose hard without rejecting sparse requests", () => {
  assert.equal(classifyTaskComplexity(null).level, "hard"); assert.equal(classifyTaskComplexity({}).level, "hard");
  assert.equal(classifyTaskComplexity({ model: "coder-auto", messages: [{ role: "user", content: "ok" }] }).level, "easy");
});
test("ordered targets do not fall back to legacy environment target variables", () => {
  const env = { AUTO_ROUTER_EASY_TARGET: "fast", AUTO_ROUTER_HARD_TARGET: "careful" };
  assert.equal(selectRoute(message("hello"), "coder-auto", { env }).target, "coder");
  assert.equal(selectRoute(message("fully audit this"), "coder-auto", { env }).target, "coder-high");
});
test("indirect recursion is blocked per request", async () => {
  const body = message("hello"), log = { info() {}, warn() {} };
  const response = await routeAutoCombo({ body, comboName: "coder-auto", comboStrategies: {}, log, delegate: () => routeAutoCombo({ body, comboName: "coder-auto", comboStrategies: {}, log, delegate: () => new Response("unexpected") }) });
  assert.equal(response.status, 400); assert.match((await response.json()).error.message, /recursion blocked/);
});
test("Auto Router validation failures remain controlled responses", async () => {
  const response = await routeAutoCombo({
    body: message("hello"),
    comboName: "coder-auto",
    comboStrategies: { "coder-auto": { autoRouter: { easyTarget: "coder-auto", hardTarget: "coder-high" } } },
    log: { info() {}, warn() {} },
    delegate: () => new Response("unexpected"),
  });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /^AUTO-ROUTER: recursion blocked/);
});
test("delegated failures preserve their errors and release recursion state", async () => {
  for (const delegate of [
    () => { throw new Error("upstream synchronous failure"); },
    async () => { throw new Error("upstream asynchronous failure"); },
  ]) {
    const body = message("hello"), log = { info() {}, warn() {} };
    await assert.rejects(
      routeAutoCombo({ body, comboName: "coder-auto", comboStrategies: {}, log, delegate }),
      /upstream (?:synchronous|asynchronous) failure/,
    );
    const response = await routeAutoCombo({ body, comboName: "coder-auto", comboStrategies: {}, log, delegate: () => new Response("retry succeeded") });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "retry succeeded");
  }
});
test("auto chooses one route, preserves original body/tools/stream, and delegates nested combos", async () => {
  const body = { ...harness("small change"), stream: true }, calls = [];
  const response = await routeAutoCombo({ body, comboName: "coder-auto", comboStrategies: { coder: { fallbackStrategy: "fallback" }, "coder-high": { fallbackStrategy: "round-robin" } }, log: { info() {}, warn() {} }, delegate: (sent, target) => { calls.push({ sent, target }); return new Response(target === "coder" ? "nested fallback retained" : "unexpected"); } });
  assert.equal(response.status, 200); assert.equal(calls.length, 1); assert.equal(calls[0].target, "coder"); assert.equal(calls[0].sent, body); assert.equal(calls[0].sent.stream, true); assert.equal(calls[0].sent.tools, body.tools); assert.equal(await response.text(), "nested fallback retained");
});

test("verbose routing logs structured decisions without request text", async () => {
  const prompt = "private prompt sentinel must never be logged";
  const entries = [];
  const log = { info: (...args) => entries.push(args.join(" ")), warn: (...args) => entries.push(args.join(" ")) };
  const response = await routeAutoCombo({
    body: message(prompt),
    comboName: "coder-auto",
    comboStrategies: { "coder-auto": { autoRouter: { easyTarget: "coder", hardTarget: "coder-high", verbose: true } } },
    log,
    delegate: () => new Response("ok"),
  });
  assert.equal(response.status, 200);
  assert.ok(entries.some((entry) => /combo=coder-auto level=easy target=coder score=\d+ reasons=/.test(entry)));
  assert.ok(entries.some((entry) => /combo=coder-auto metadata=/.test(entry)));
  assert.ok(entries.every((entry) => !entry.includes(prompt)));
});

test("per-combo persisted configuration overrides legacy environment and defaults", () => {
  const body = message("fully audit this");
  const comboStrategies = {
    "coder-auto": { fallbackStrategy: "auto", autoRouter: { easyTarget: "ui-easy", hardTarget: "ui-hard", hardThreshold: 1, verbose: false } },
  };
  const result = selectRoute(body, "coder-auto", {
    env: { AUTO_ROUTER_EASY_TARGET: "env-easy", AUTO_ROUTER_HARD_TARGET: "env-hard", AUTO_ROUTER_HARD_THRESHOLD: "99", AUTO_ROUTER_VERBOSE: "true" },
    comboStrategies,
  });
  assert.equal(result.target, "ui-hard");
  assert.equal(result.config.easyTarget, "ui-easy");
  assert.equal(result.config.verbose, false);
  assert.equal(result.config.longContextChars, 24000);
});

test("two Auto Router combos keep independent targets and thresholds", () => {
  const easy = message("hello"), hard = message("fully audit this");
  const comboStrategies = {
    first: { fallbackStrategy: "auto", autoRouter: { easyTarget: "cheap", hardTarget: "deep", hardThreshold: 6 } },
    second: { fallbackStrategy: "auto", autoRouter: { easyTarget: "fast", hardTarget: "smart", hardThreshold: 1 } },
  };
  assert.equal(selectRoute(easy, "first", { comboStrategies }).target, "cheap");
  assert.equal(selectRoute(hard, "second", { comboStrategies }).target, "smart");
  assert.equal(selectRoute(hard, "first", { comboStrategies }).target, "deep");
});

test("invalid explicit numeric values fall back to valid legacy values", () => {
  const result = selectRoute(message("hello"), "coder-auto", {
    env: { AUTO_ROUTER_HARD_THRESHOLD: "2" },
    comboStrategies: { "coder-auto": { autoRouter: { hardThreshold: -1, longContextChars: "bad" } } },
  });
  assert.equal(result.config.hardThreshold, 2);
  assert.equal(result.config.longContextChars, 24000);
});


test("invalid per-combo fields independently fall back to valid legacy values", () => {
  const config = router.getConfig({ AUTO_ROUTER_EASY_TARGET: "env-easy", AUTO_ROUTER_HARD_TARGET: "env-hard", AUTO_ROUTER_HARD_THRESHOLD: "8", AUTO_ROUTER_LONG_CONTEXT_CHARS: "28000", AUTO_ROUTER_LARGE_TOOL_RESULT_CHARS: "14000", AUTO_ROUTER_MANY_TOOLS: "18", AUTO_ROUTER_VERBOSE: "true" }, { easyTarget: " ", hardTarget: null, hardThreshold: -1, longContextChars: "bad", largeToolResultChars: 0, manyTools: 1.5, verbose: "invalid" });
  assert.deepEqual(config, { easyTarget: "env-easy", hardTarget: "env-hard", hardThreshold: 8, longContextChars: 28000, largeToolResultChars: 14000, manyTools: 18, verbose: true });
});

test("invalid UI and legacy values use defaults while boolean parsing is deliberate", () => {
  const config = router.getConfig({ AUTO_ROUTER_HARD_THRESHOLD: "bad", AUTO_ROUTER_VERBOSE: "yes" }, { hardThreshold: -1, verbose: "truthy" });
  assert.equal(config.hardThreshold, 6); assert.equal(config.verbose, false);
  assert.equal(router.getConfig({ AUTO_ROUTER_VERBOSE: "FALSE" }, {}).verbose, false);
});

test("generic domain nouns do not push simple label edits to hard", () => {
  for (const prompt of [
    'Rename the "Authentication" menu item',
    "Change the Permissions button label",
    "Rename Architecture to System Design",
    "Update the Security Settings heading text",
    "Rename the Data Migration report title",
  ]) {
    const result = classifyTaskComplexity(message(prompt));
    assert.equal(result.level, "easy", prompt);
    assert.ok(result.score < 6, prompt);
  }
});

test("genuinely complex security/architecture/migration requests still route hard", () => {
  for (const prompt of [
    "Fully audit the authentication and permissions implementation.",
    "Investigate the security architecture for authentication flaws.",
    "Refactor the authentication, permissions, and architecture across the service.",
    "Plan a database migration with rollback safety.",
  ]) assert.equal(classifyTaskComplexity(message(prompt)).level, "hard", prompt);
});

test("semantic keywords only score user task intent", () => {
  const renamed = {
    model: "coder-auto",
    messages: [
      { role: "system", content: "Audit security architecture, plan migrations, and investigate concurrency." },
      { role: "assistant", content: "The security migration and race condition are complete." },
      { role: "tool", content: "generated source: fully audit authentication permissions" },
      { role: "user", content: 'Rename the button to "Security Settings".' },
    ],
  };
  const result = classifyTaskComplexity(renamed);
  assert.equal(result.level, "easy");
  assert.ok(result.score < 6);
  assert.equal(classifyTaskComplexity(message("Debug these intermittent failing tests")).level, "hard");
  assert.equal(classifyTaskComplexity(message("Plan this database migration")).level, "hard");
});

test("structured inspection tolerates circular and unusual request values", () => {
  const circular = { type: "input_text", text: "small edit" };
  circular.self = circular;
  const unusual = { toJSON() { throw new Error("must not serialize request values"); } };
  const body = { model: "coder-auto", input: [{ role: "user", content: [circular, unusual] }] };
  const result = classifyTaskComplexity(body);
  assert.equal(result.level, "easy");
  assert.ok(!result.reasons.includes("classifier-error"));
  assert.equal(classifyTaskComplexity({ model: "coder-auto", contents: [{ role: "user", parts: [{ type: "input_image", image_url: circular }, unusual, { text: "small edit" }] }] }).reasons.includes("modality-present"), true);
});

test("explicit target validation rejects self-targets, auto targets, and stale targets but permits normal combos", () => {
  const easy = message("hello"), hard = message("fully audit this concurrency race condition");
  // Direct self-reference: the easy target is the Auto Router combo itself.
  const selfEasy = { "auto-a": { fallbackStrategy: "auto", autoRouter: { easyTarget: "auto-a", hardTarget: "ordinary" } }, ordinary: { fallbackStrategy: "fallback" } };
  assert.throws(() => selectRoute(easy, "auto-a", { comboStrategies: selfEasy }), /is the Auto Router combo itself/);
  // Direct self-reference from the hard branch.
  const selfHard = { "auto-a": { fallbackStrategy: "auto", autoRouter: { easyTarget: "ordinary", hardTarget: "auto-a" } }, ordinary: { fallbackStrategy: "fallback" } };
  assert.throws(() => selectRoute(hard, "auto-a", { comboStrategies: selfHard }), /is the Auto Router combo itself/);
  // Target configured with fallbackStrategy: "auto" — Auto Router → Auto Router is unsupported.
  const autoTarget = { "auto-a": { fallbackStrategy: "auto", autoRouter: { easyTarget: "auto-b", hardTarget: "ordinary" } }, "auto-b": { fallbackStrategy: "auto" }, ordinary: { fallbackStrategy: "fallback" } };
  assert.throws(() => selectRoute(easy, "auto-a", { comboStrategies: autoTarget }), /chaining is not supported/);
  // No indirect graph traversal is claimed: a chain to another Auto Router is rejected at the direct hop.
  const indirect = { "auto-a": { fallbackStrategy: "auto", autoRouter: { easyTarget: "auto-b", hardTarget: "ordinary" } }, "auto-b": { fallbackStrategy: "auto", autoRouter: { easyTarget: "auto-c", hardTarget: "ordinary" } }, "auto-c": { fallbackStrategy: "auto", autoRouter: { easyTarget: "auto-a", hardTarget: "ordinary" } }, ordinary: { fallbackStrategy: "fallback" } };
  assert.throws(() => selectRoute(easy, "auto-a", { comboStrategies: indirect }), /chaining is not supported/);
  // Ordinary fallback/round-robin targets remain valid, including when combo existence is known.
  const ordinary = { "auto-a": { fallbackStrategy: "auto", autoRouter: { easyTarget: "fallback-combo", hardTarget: "round-robin-combo" } }, "fallback-combo": { fallbackStrategy: "fallback" }, "round-robin-combo": { fallbackStrategy: "round-robin" } };
  assert.equal(selectRoute(easy, "auto-a", { comboStrategies: ordinary, knownCombos: ["auto-a", "fallback-combo", "round-robin-combo"] }).target, "fallback-combo");
  assert.equal(selectRoute(hard, "auto-a", { comboStrategies: ordinary, knownCombos: ["auto-a", "fallback-combo", "round-robin-combo"] }).target, "round-robin-combo");
  // Stale target with combo information available fails with a specific message.
  assert.throws(() => selectRoute(easy, "auto-a", { comboStrategies: ordinary, knownCombos: ["auto-a", "round-robin-combo"] }), /Easy target "fallback-combo" does not exist/);
});

test("runtime target validation returns controlled easy and hard stale-target errors", async () => {
  const log = { info() {}, warn() {} };
  for (const [body, expected] of [[message("hello"), /Easy target "missing-easy" does not exist/], [message("fully audit this"), /Hard target "missing-hard" does not exist/] ]) {
    const response = await routeAutoCombo({ body, comboName: "auto", comboStrategies: { auto: { autoRouter: { easyTarget: "missing-easy", hardTarget: "missing-hard" } } }, log, targetExists: async () => false, delegate: () => new Response("unexpected") });
    assert.equal(response.status, 400);
    assert.match((await response.json()).error.message, expected);
  }
});

test("target resolver failures are not misreported as missing targets", async () => {
  const log = { info() {}, warn() {} };
  const comboStrategies = { auto: { autoRouter: { easyTarget: "coder", hardTarget: "coder-high" } } };
  // Resolver success delegates normally and forwards the chosen target.
  const delegated = [];
  const ok = await routeAutoCombo({ body: message("hello"), comboName: "auto", comboStrategies, log, targetExists: async () => true, delegate: (sent, target) => { delegated.push({ sent, target }); return new Response("ok"); } });
  assert.equal(ok.status, 200); assert.equal(await ok.text(), "ok"); assert.equal(delegated.length, 1); assert.equal(delegated[0].target, "coder");
  for (const [name, targetExists] of [
    ["synchronous", () => { throw new Error("resolver exploded"); }],
    ["asynchronous", async () => { throw new Error("resolver exploded"); }],
  ]) {
    const body = message("hello");
    await assert.rejects(
      routeAutoCombo({ body, comboName: "auto", comboStrategies, log, targetExists, delegate: () => new Response("unexpected") }),
      /resolver exploded/,
      `${name} resolver failure must propagate`,
    );
    // The failed attempt must not leave request/recursion tracking dirty for this body.
    const retry = await routeAutoCombo({ body, comboName: "auto", comboStrategies, log, targetExists: async () => true, delegate: (sent, target) => new Response(`retried ${target}`) });
    assert.equal(retry.status, 200, `${name} resolver failure must not poison the next request`);
    assert.equal(await retry.text(), "retried coder");
  }
});

test("cloned delegation cannot bypass static Auto Router protection", async () => {
  const body = message("hello"), log = { info() {}, warn() {} };
  const response = await routeAutoCombo({ body, comboName: "auto-a", comboStrategies: { "auto-a": { autoRouter: { easyTarget: "auto-b", hardTarget: "ordinary" } }, "auto-b": { fallbackStrategy: "auto" } }, log, delegate: (sent) => routeAutoCombo({ body: { ...sent }, comboName: "auto-b", comboStrategies: {}, log, delegate: () => new Response("unexpected") }) });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /chaining is not supported/);
});


test("model order is the Auto Router target source", () => {
  const easy = message("hello"), hard = message("fully audit this");
  assert.equal(selectConfiguredRoute(easy, "auto", { models: ["easy", "hard"] }).target, "easy");
  assert.equal(selectConfiguredRoute(hard, "auto", { models: ["easy", "hard", "ignored"] }).target, "hard");
  assert.equal(selectConfiguredRoute(easy, "auto", { models: ["hard", "easy", "ignored"] }).target, "hard");
  assert.equal(selectConfiguredRoute(hard, "auto", { models: ["replacement", "hard"] }).target, "hard");
  assert.equal(selectConfiguredRoute(easy, "auto", { models: ["replacement", "hard"] }).target, "replacement");
  assert.throws(() => selectConfiguredRoute(easy, "auto", { models: [] }), /requires two distinct usable models/);
  assert.throws(() => selectConfiguredRoute(easy, "auto", { models: ["only"] }), /requires two distinct usable models/);
  assert.throws(() => selectConfiguredRoute(easy, "auto", { models: ["same", "same"] }), /requires two distinct usable models/);
});
test("legacy target configuration remains effective until UI normalization", () => {
  const persisted = { auto: { fallbackStrategy: "auto", autoRouter: { easyTarget: "legacy-easy", hardTarget: "legacy-hard", hardThreshold: 1 } } };
  const legacy = selectConfiguredRoute(message("fully audit this"), "auto", { models: ["new-easy", "new-hard"], comboStrategies: persisted });
  assert.equal(legacy.target, "legacy-hard"); assert.equal(legacy.config.easyTarget, "legacy-easy");
  const normalized = selectConfiguredRoute(message("fully audit this"), "auto", { models: ["legacy-easy", "legacy-hard", "new-easy", "new-hard"], comboStrategies: { auto: { fallbackStrategy: "auto", autoRouter: { hardThreshold: 1 } } } });
  assert.equal(normalized.target, "legacy-hard"); assert.equal(normalized.config.easyTarget, "legacy-easy");
});
test("missing ordered models return a controlled runtime configuration error", async () => { const response = await router.routeAutoCombo({ body: message("hello"), comboName: "auto", comboStrategies: {}, models: ["only"], log: { info() {}, warn() {} }, delegate: () => new Response("unexpected") }); assert.equal(response.status, 400); assert.match((await response.json()).error.message, /requires two distinct usable models/); });
