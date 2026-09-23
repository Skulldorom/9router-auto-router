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

test("validation installs cached dependencies before static checks", () => {
  const validate = workflows.find(([file]) => file === "validate-image.yml")?.[1] || "";
  const setup = validate.indexOf("actions/setup-node@");
  const install = validate.indexOf("- run: npm ci");
  const check = validate.indexOf("- run: npm run check");
  const tests = validate.indexOf("- run: npm test");
  assert.ok(setup >= 0 && setup < install && install < check && check < tests);
  assert.match(validate, /node-version: 22\n\s+cache: npm/);
});

test("derived image verification precedes every image integration test", () => {
  const validate = workflows.find(([file]) => file === "validate-image.yml")?.[1] || "";
  const verification = validate.indexOf("Verify the built derived image");
  const smoke = validate.indexOf("./scripts/smoke-test.sh");
  const runtime = validate.indexOf("./scripts/runtime-test.sh");
  const persistence = validate.indexOf("./scripts/settings-persistence-test.sh");
  const http = validate.indexOf("./scripts/auto-router-http-test.sh");
  const parity = validate.indexOf("./scripts/auto-router-pipeline-parity-test.sh");
  const rollback = validate.indexOf("./scripts/rollback-compatibility-test.sh");
  assert.ok(verification >= 0 && verification < smoke && smoke < runtime && runtime < persistence && persistence < http && http < parity && parity < rollback);
  assert.match(validate, /verify-built-image\.sh "\$\{\{ inputs\.image_tag \}\}" "\$REVISION" "\$UPSTREAM_DIGEST"/);
  const verifier = fs.readFileSync(path.join(root, "scripts/verify-built-image.sh"), "utf8");
  for (const required of ["auto-router.cjs", "apply-patch.mjs", "9router-auto-router:v3", "routeAutoCombo", "9router-auto-router-ui:v4", "Easy target", "Hard target", "Advanced", "org.opencontainers.image.revision", "upstream.digest", "availableCombos:"]) assert.ok(verifier.includes(required));
  assert.ok(verifier.includes('grep -o "label:\\"Auto Router\\\"" "$file" | wc -l)" -eq 2'));
  assert.ok(verifier.includes('grep -o "9router-auto-router-ui:v4" "$file" | wc -l'));
  for (const modalControl of ["Easy target", "Hard target", "Advanced"]) assert.ok(verifier.includes(`grep -q "${modalControl}" "$file"`));
  assert.match(verifier, /node \/opt\/9router-auto-router\/apply-patch\.mjs \/app --check/);
  assert.doesNotMatch(verifier, /page-hash|app\/dashboard\/combos\/page/);
});

test("rollback browser regression attaches stdin, verifies execution markers, and saves through the UI", () => {
  const rollback = fs.readFileSync(path.join(root, "scripts/rollback-compatibility-test.sh"), "utf8");
  assert.match(rollback, /docker run --rm -i --network "\$NETWORK".*exec node -' <<'NODE'/);
  assert.match(rollback, /AUTO_ROUTER_BROWSER_TEST_START:\$\{phase\}/);
  assert.match(rollback, /AUTO_ROUTER_BROWSER_TEST_COMPLETE:\$\{phase\}/);
  assert.match(rollback, /Browser test did not start/);
  assert.match(rollback, /Browser test did not complete/);
  assert.match(rollback, /page\.on\("pageerror"/);
  assert.match(rollback, /page\.waitForResponse\(response => response\.url\(\)\.includes\("\/api\/settings"\) && response\.request\(\)\.method\(\) === "PATCH" && response\.ok\(\)\)/);
  assert.match(rollback, /page\.waitForFunction\(async \(\) =>/);
  assert.doesNotMatch(rollback, /waitForTimeout\(250\)/);
  assert.match(rollback, /locator\("xpath=ancestor::\*\[\.\/\/button\[@title=\\"Edit\\"\]\]\[1\]"\)\.locator\("button\[title=\\"Edit\\"\]"\)\.click\(\)/);
  assert.match(rollback, /const strategy = page\.locator\("select"\)\.first\(\);\n    await strategy\.selectOption\("auto"\)/);
  assert.match(rollback, /getByLabel\("Easy target"\)\.selectOption\("coder"\)/);
  assert.match(rollback, /getByLabel\("Hard target"\)\.selectOption\("coder-high"\)/);
  assert.match(rollback, /leaked Easy target onto the combo card/);
  assert.match(rollback, /getByRole\("button", \{ name: "Save", exact: true \}\)\.click\(\)/);
  assert.match(rollback, /getByRole\("button", \{ name: "Cancel", exact: true \}\)\.click\(\)/);
  assert.match(rollback, /browser_combos patched-before-auto true/);
  assert.match(rollback, /getByLabel\(\/Hard threshold\/\)\.inputValue\(\) !== "7"/);
  assert.match(rollback, /hardThreshold === 7/);
  assert.match(rollback, /removed-easy-target/);
  assert.match(rollback, /missing Easy target did not render as a disabled warning option/);
  assert.match(rollback, /silently replaced a missing Easy target/);
  assert.doesNotMatch(rollback, /waitForTimeout\(/);
});

test("browser helper images retain readable versions and immutable digests", () => {
  const rollback = fs.readFileSync(path.join(root, "scripts/rollback-compatibility-test.sh"), "utf8");
  assert.match(rollback, /mcr\.microsoft\.com\/playwright:v1\.58\.2-noble@sha256:[0-9a-f]{64}/);
  assert.match(rollback, /node:22-alpine@sha256:[0-9a-f]{64}/);
  assert.ok(rollback.includes('"$PLAYWRIGHT_IMAGE"'));
  assert.ok(rollback.includes('"$NODE_IMAGE"'));
});


test("lint blocks warnings and restricts CommonJS globals to runtime code", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.match(manifest.scripts.lint, /eslint eslint\.config\.js src patches test --max-warnings=0/);
  const config = fs.readFileSync(path.join(root, "eslint.config.js"), "utf8");
  assert.match(config, /files: \["eslint\.config\.js", "patches\/\*\*\/\*\.mjs", "test\/\*\*\/\*\.mjs"\]/);
  assert.match(config, /files: \["src\/\*\*\/\*\.cjs"\]/);
  assert.match(config, /sourceType: "commonjs"/);
});
