import test from "node:test";
import assert from "node:assert/strict";
import router from "../src/auto-router.cjs";

const { classifyTaskComplexity, selectRoute, routeAutoCombo } = router;
const message = (content) => ({ model: "coder-auto", messages: [{ role: "user", content }] });

test("short simple prompt and small single-file edit are easy", () => {
  assert.equal(classifyTaskComplexity(message("What is a JavaScript closure?")).level, "easy");
  assert.equal(classifyTaskComplexity(message("Update src/index.js to rename one function.")).level, "easy");
});
test("high-signal task language is hard", () => {
  for (const prompt of ["Fully audit this repository.", "Plan a database migration.", "Investigate this concurrency race condition."]) assert.equal(classifyTaskComplexity(message(prompt)).level, "hard", prompt);
});
test("long context, many tools, tool histories, and modalities add complexity", () => {
  assert.match(classifyTaskComplexity(message("x".repeat(24000))).reasons.join(","), /large-context/);
  assert.equal(classifyTaskComplexity({ ...message("help"), tools: Array.from({ length: 5 }, (_, n) => ({ type: "function", function: { name: `tool_${n}` } })) }).level, "hard");
  assert.equal(classifyTaskComplexity({ model: "coder-auto", messages: [{ role: "user", content: "continue" }, ...Array.from({ length: 3 }, () => ({ role: "tool", content: "x".repeat(5000) }))] }).level, "hard");
  assert.equal(classifyTaskComplexity({ model: "coder-auto", messages: [{ role: "user", content: [{ type: "input_file", file: { file_data: "data:application/pdf;base64,AA==" } }] }] }).level, "hard");
});
test("OpenAI Responses and Anthropic-shaped bodies are inspected", () => {
  assert.equal(classifyTaskComplexity({ model: "coder-auto", input: [{ role: "user", content: [{ type: "input_text", text: "deep review this architecture" }] }] }).level, "hard");
  assert.equal(classifyTaskComplexity({ model: "coder-auto", contents: [{ role: "user", parts: [{ text: "small edit" }] }] }).level, "easy");
});
test("malformed or empty requests safely choose hard", () => { assert.equal(classifyTaskComplexity(null).level, "hard"); assert.equal(classifyTaskComplexity({}).level, "hard"); });
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
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /recursion blocked/);
});
test("auto chooses exactly one route and preserves stream/tools/body", async () => {
  const body = { ...message("small change"), stream: true, tools: [{ type: "function", function: { name: "read_file" } }] }, calls = [];
  const response = await routeAutoCombo({ body, comboName: "coder-auto", comboStrategies: {}, log: { info() {}, warn() {} }, delegate: (sent, target) => { calls.push({ sent, target }); return new Response("ok"); } });
  assert.equal(response.status, 200); assert.equal(calls.length, 1); assert.equal(calls[0].target, "coder"); assert.equal(calls[0].sent, body); assert.equal(calls[0].sent.stream, true); assert.equal(calls[0].sent.tools, body.tools);
});
