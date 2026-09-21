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


test("publish gates latest on both current source and current upstream digest before registry login", () => {
  const publish = workflows.find(([file]) => file === "publish.yml")?.[1] || "";
  const freshness = publish.indexOf("Refuse stale source or upstream validation");
  const login = publish.indexOf("Authenticate to GHCR after validation");
  const publishTags = publish.indexOf("Publish immutable tags, then last-known-good latest");
  assert.ok(freshness >= 0 && freshness < login && login < publishTags);
  assert.match(publish, /VALIDATED_UPSTREAM_DIGEST: \$\{\{ needs\.validate\.outputs\.upstream_digest \}\}/);
  assert.match(publish, /docker buildx imagetools inspect "\$UPSTREAM_IMAGE"/);
  assert.match(publish, /current_upstream=.*upstream-inspect\.txt/);
  assert.match(publish, /\[ "\$current_upstream" != "\$VALIDATED_UPSTREAM_DIGEST" \]/);
  assert.match(publish, /skip latest until a new run validates it/);
  assert.match(publish, /if: steps\.current\.outputs\.publish == 'true'/);
});

test("derived image verification precedes every image integration test", () => {
  const validate = workflows.find(([file]) => file === "validate-image.yml")?.[1] || "";
  const verification = validate.indexOf("Verify the built derived image");
  const smoke = validate.indexOf("./scripts/smoke-test.sh");
  const runtime = validate.indexOf("./scripts/runtime-test.sh");
  const persistence = validate.indexOf("./scripts/settings-persistence-test.sh");
  const http = validate.indexOf("./scripts/auto-router-http-test.sh");
  assert.ok(verification >= 0 && verification < smoke && smoke < runtime && runtime < persistence && persistence < http);
  assert.match(validate, /verify-built-image\.sh "\$\{\{ inputs\.image_tag \}\}" "\$REVISION" "\$UPSTREAM_DIGEST"/);
  const verifier = fs.readFileSync(path.join(root, "scripts/verify-built-image.sh"), "utf8");
  for (const required of ["auto-router.cjs", "apply-patch.mjs", "9router-auto-router:v3", "routeAutoCombo", "9router-auto-router-ui:v3", "Easy target", "Hard target", "org.opencontainers.image.revision", "upstream.digest"]) assert.ok(verifier.includes(required));
  assert.doesNotMatch(verifier, /page-hash|app\/dashboard\/combos\/page/);
});
