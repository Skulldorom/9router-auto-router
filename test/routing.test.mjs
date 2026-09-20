import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const patcher = path.join(root, "patches/apply-patch.mjs");
const source = "w=c(46945),x=a([e,j]);async function y(){if(\"fusion\"===f)return t.info(\"CHAT\",`Combo \"${d}\" with ${u.length} models (strategy: fusion)`),(0,o.vt);if(\"fusion\"===j)return t.info(\"CHAT\",`Combo \"${b}\" with ${f.length} models (strategy: fusion)`),(0,o.vt);}";
test("patcher applies both dispatch points once and is idempotent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-router-patch-")), target = path.join(dir, ".next/server/chunks");
  fs.mkdirSync(target, { recursive: true }); fs.writeFileSync(path.join(target, "8635.js"), source);
  for (let run = 0; run < 2; run += 1) assert.equal(spawnSync(process.execPath, [patcher, dir], { encoding: "utf8" }).status, 0);
  const patched = fs.readFileSync(path.join(target, "8635.js"), "utf8");
  assert.equal((patched.match(/9router-auto-router:v1/g) || []).length, 1); assert.equal((patched.match(/routeAutoCombo/g) || []).length, 2);
  assert.match(patched, /delegate:\(nextBody,target\)=>z\(nextBody,target,b,a,j\)/); assert.match(patched, /delegate:\(a,b\)=>z\(a,b,c,d,e\)/);
});
test("patcher fails closed when the upstream anchor changes", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "auto-router-bad-"));
  fs.mkdirSync(path.join(dir, ".next/server/chunks"), { recursive: true }); fs.writeFileSync(path.join(dir, ".next/server/chunks/8635.js"), "changed upstream");
  const result = spawnSync(process.execPath, [patcher, dir], { encoding: "utf8" });
  assert.notEqual(result.status, 0); assert.match(result.stderr, /compatibility check failed/);
});
