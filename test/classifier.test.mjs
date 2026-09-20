import test from "node:test";
import assert from "node:assert/strict";
import router from "../src/auto-router.cjs";

const { classifyTaskComplexity, selectRoute, routeAutoCombo } = router;
const message = (content) => ({ model: "coder-auto", messages: [{ role: "user", content }] });
const openHandsTools = ["terminal", "file_editor", "browser", "task_tracker", "canvas_ui_control", "search", "git", "python", "node", "docker", "planner", "workspace"].map((name) => ({ type: "function", function: { name, description: `Sanitized ${name} tool`, parameters: { type: "object", properties: {} } } }));
const harness = (request) => ({ model: "coder-auto", stream: true, tools: openHandsTools, messages: [
  { role: "system", content: "You are a software engineering agent. Inspect the repository, preserve request bodies and tools, and make focused changes.".repeat(12) },
  { role: "system", content: "Workspace: /workspace/project. Follow project instructions. Do not expose credentials. Use repository tests." },
  { role: "user", content: request },
] });

test("short simple prompt and small single-file edit are easy", () => {
  assert.equal(classifyTaskComplexity(message("What is a JavaScript closure?")).level, "easy");
  assert.equal(classifyTaskComplexity(message("Update src/index.js to rename one function.")).level, "easy");
});
test("realistic OpenHands toolset does not make a simple request hard", () => {
  const body = harness("Rename this variable in src/foo.js");
  const result = classifyTaskComplexity(body);
  assert.equal(result.level, "easy"); assert.equal(selectRoute(body, "coder-auto").target, "coder");
  assert.ok(result.score < 6); assert.ok(result.reasons.includes("tools-present"));
});
test("realistic OpenHands hard audit routes coder-high with bounded reasons", () => {
  const body = harness("Fully audit the concurrency and revision implementation and identify race conditions.");
  const result = classifyTaskComplexity(body);
  assert.equal(result.level, "hard"); assert.equal(selectRoute(body, "coder-auto").target, "coder-high");
  assert.ok(result.score <= 7); assert.deepEqual(result.reasons.filter((reason) => ["audit", "concurrency"].includes(reason)), ["audit", "concurrency"]);
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
test("malformed and empty requests safely choose hard without rejecting sparse requests", () => {
  assert.equal(classifyTaskComplexity(null).level, "hard"); assert.equal(classifyTaskComplexity({}).level, "hard");
  assert.equal(classifyTaskComplexity({ model: "coder-auto", messages: [{ role: "user", content: "ok" }] }).level, "easy");
});
test("configured target selection and recursion protection work", () => {
  const env = { AUTO_ROUTER_EASY_TARGET: "fast", AUTO_ROUTER_HARD_TARGET: "careful" };
  assert.equal(selectRoute(message("hello"), "coder-auto", { env }).target, "fast");
  assert.equal(selectRoute(message("fully audit this"), "coder-auto", { env }).target, "careful");
  assert.throws(() => selectRoute(message("hello"), "coder-auto", { env: { AUTO_ROUTER_EASY_TARGET: "coder-auto" } }), /recursion blocked/);
  assert.throws(() => selectRoute(message("hello"), "coder-auto", { env, comboStrategies: { fast: { fallbackStrategy: "auto" } } }), /recursion blocked/);
});
test("indirect recursion is blocked per request", async () => {
  const body = message("hello"), log = { info() {}, warn() {} };
  const response = await routeAutoCombo({ body, comboName: "coder-auto", comboStrategies: {}, log, delegate: () => routeAutoCombo({ body, comboName: "coder-auto", comboStrategies: {}, log, delegate: () => new Response("unexpected") }) });
  assert.equal(response.status, 400); assert.match((await response.json()).error.message, /recursion blocked/);
});
test("auto chooses one route, preserves original body/tools/stream, and delegates nested combos", async () => {
  const body = { ...harness("small change"), stream: true }, calls = [];
  const response = await routeAutoCombo({ body, comboName: "coder-auto", comboStrategies: { coder: { fallbackStrategy: "fallback" }, "coder-high": { fallbackStrategy: "round-robin" } }, log: { info() {}, warn() {} }, delegate: (sent, target) => { calls.push({ sent, target }); return new Response(target === "coder" ? "nested fallback retained" : "unexpected"); } });
  assert.equal(response.status, 200); assert.equal(calls.length, 1); assert.equal(calls[0].target, "coder"); assert.equal(calls[0].sent, body); assert.equal(calls[0].sent.stream, true); assert.equal(calls[0].sent.tools, body.tools); assert.equal(await response.text(), "nested fallback retained");
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

test("invalid explicit numeric values fail safely to built-in defaults", () => {
  const result = selectRoute(message("hello"), "coder-auto", {
    env: { AUTO_ROUTER_HARD_THRESHOLD: "2" },
    comboStrategies: { "coder-auto": { autoRouter: { hardThreshold: -1, longContextChars: "bad" } } },
  });
  assert.equal(result.config.hardThreshold, 6);
  assert.equal(result.config.longContextChars, 24000);
});
