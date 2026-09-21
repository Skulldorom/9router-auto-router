import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const runtimeTest = fs.readFileSync(path.join(root, "scripts/runtime-test.sh"), "utf8");
const workflows = fs.readdirSync(path.join(root, ".github/workflows"))
  .filter((file) => file.endsWith(".yml"))
  .map((file) => [file, fs.readFileSync(path.join(root, ".github/workflows", file), "utf8")]);

test("runtime test uses the shared image runtime user for tmpfs ownership", () => {
  assert.match(runtimeTest, /\. "\$ROOT\/scripts\/lib-container-test\.sh"/);
  assert.match(runtimeTest, /RUNTIME_USER=\$\(container_runtime_user "\$IMAGE"\)/);
  assert.match(runtimeTest, /--tmpfs "\/app\/data:uid=\$\{RUNTIME_UID\},gid=\$\{RUNTIME_GID\}"/);
  assert.doesNotMatch(runtimeTest, /(?:uid|gid)=1000/);
});

test("external GitHub Actions are immutable SHA pins with release comments", () => {
  for (const [file, workflow] of workflows) {
    for (const line of workflow.split("\n").filter((candidate) => candidate.includes("uses:"))) {
      const reference = line.match(/uses:\s+([^\s#]+)/)?.[1];
      if (!reference || reference.startsWith("./")) continue;
      assert.match(reference, /^[\w-]+\/[\w.-]+@[0-9a-f]{40}$/, `${file}: ${line}`);
      assert.match(line, /# v\d+\.\d+\.\d+\s*$/, `${file}: ${line}`);
    }
  }
});
