import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
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
  const publishTags = publish.indexOf("Publish immutable image");
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
  for (const required of ["auto-router-config.cjs", "auto-router.cjs", "apply-patch.mjs", "9router-auto-router:v3", "routeAutoCombo", "9router-auto-router-ui:v9", "Models after position 2 are ignored by Auto Router", "Advanced", "org.opencontainers.image.revision", "upstream.digest"]) assert.ok(verifier.includes(required));
  assert.ok(verifier.includes('grep -o "label:\\"Auto Router\\\"" "$file" | wc -l)" -eq 1'));
  assert.ok(verifier.includes('grep -o "$UI_MARKER" "$file" | wc -l'));
  assert.ok(verifier.includes('grep -q "Advanced" "$file"'));
  for (const removed of ["Easy target", "Hard target"]) assert.ok(verifier.includes(`! grep -q "${removed}" "$file"`));
  assert.match(verifier, /node \/opt\/9router-auto-router\/apply-patch\.mjs \/app --check/);
  assert.doesNotMatch(verifier, /page-hash|app\/dashboard\/combos\/page/);
});

test("rollback browser regression attaches stdin, verifies execution markers, and saves through the UI", () => {
  const rollback = fs.readFileSync(path.join(root, "scripts/rollback-compatibility-test.sh"), "utf8");
  assert.match(rollback, /docker run --rm -i --network "\$NETWORK".*exec node -' <<'NODE'/);
  for (const marker of ["AUTO_ROUTER_BROWSER_TEST_START:${phase}", "AUTO_ROUTER_BROWSER_TEST_COMPLETE:${phase}", "Browser test did not start", "Browser test did not complete"]) assert.ok(rollback.includes(marker));
  assert.match(rollback, /page\.on\("pageerror"/);
  assert.match(rollback, /page\.waitForResponse\(response => response\.url\(\)\.includes\("\/api\/settings"\) && response\.request\(\)\.method\(\) === "PATCH" && response\.ok\(\)\)/);
  assert.match(rollback, /page\.waitForFunction\(async \(\) =>/);
  assert.doesNotMatch(rollback, /waitForTimeout\(250\)/);
  assert.match(rollback, /const strategy = card\.locator\("select"\)/);
  assert.match(rollback, /for \(const value of \["fallback", "round-robin", "fusion", "auto"\]\)/);
  assert.match(rollback, /option\[value="\$\{value\}"\]/);
  assert.match(rollback, /for \(const nextStrategy of \["round-robin", "fusion"\]\)/);
  assert.match(rollback, /strategy\.selectOption\(nextStrategy\)/);
  assert.match(rollback, /strategy\.selectOption\("auto"\)/);
  assert.match(rollback, /Edit Combo retained a Strategy selector/);
  assert.match(rollback, /did not label ordered model target as/);
  assert.match(rollback, /Legacy targets remain effective until this model order is saved/);
  assert.match(rollback, /!\("easyTarget" in config\)/);
  assert.match(rollback, /did not initialize model order from legacy routing/);
  assert.match(rollback, /JSON\.stringify\(combo\?\.models\) === JSON\.stringify\(\["coder", "coder-high", "coder-auto-model"\]\)/);
  assert.match(rollback, /browser_combos patched-before-auto true/);
  assert.match(rollback, /const hardThreshold = modal\.getByLabel\(\/Hard threshold\/\)/);
  assert.match(rollback, /hardThreshold\.inputValue\(\) !== "7"/);
  assert.match(rollback, /hardThreshold === 7/);
  assert.doesNotMatch(rollback, /waitForTimeout\(/);
});

test("browser helper images retain readable versions and immutable digests", () => {
  const rollback = fs.readFileSync(path.join(root, "scripts/rollback-compatibility-test.sh"), "utf8");
  assert.match(rollback, /mcr\.microsoft\.com\/playwright:v1\.58\.2-noble@sha256:[0-9a-f]{64}/);
  assert.match(rollback, /node:22-alpine@sha256:[0-9a-f]{64}/);
  assert.ok(rollback.includes('"$PLAYWRIGHT_IMAGE"'));
  assert.ok(rollback.includes('"$NODE_IMAGE"'));
});


test("immutable release tags encode the complete source and upstream identities", () => {
  const tagScript = path.join(root, "scripts/derive-image-tag.sh");
  const revision = "a".repeat(40);
  const firstUpstream = `sha256:${"b".repeat(64)}`;
  const secondUpstream = `sha256:${"c".repeat(64)}`;
  const run = (source, upstream) => {
    const result = childProcess.spawnSync("sh", [tagScript, source, upstream], { encoding: "utf8" });
    return { status: result.status, output: result.stdout.trim(), error: result.stderr };
  };

  assert.equal(run(revision, firstUpstream).output, `sha-${revision}-upstream-${"b".repeat(64)}`);
  assert.equal(run(revision, firstUpstream).output, run(revision, firstUpstream).output);
  assert.notEqual(run(revision, firstUpstream).output, run(revision, secondUpstream).output);
  assert.notEqual(run(revision, firstUpstream).output, run("d".repeat(40), firstUpstream).output);
  assert.equal(run(revision.slice(0, 12), firstUpstream).status, 1);
  assert.equal(run(revision.toUpperCase(), firstUpstream).status, 1);
  assert.equal(run(revision, "sha256:not-a-digest").status, 1);
});

test("publication is idempotent for matching immutable tags and fail-closed otherwise", () => {
  const publish = workflows.find(([file]) => file === "publish.yml")?.[1] || "";
  const publication = publish.slice(publish.indexOf("Publish immutable image"));
  assert.match(publication, /tag=\$\(\.\/scripts\/derive-image-tag\.sh "\$REVISION" "\$UPSTREAM_DIGEST"\)/);
  assert.match(publication, /existing_digest=.*imagetools inspect --format '\{\{json \.\}\}'/);
  assert.match(publication, /if \[ -n "\$existing_digest" \]; then/);
  assert.match(publication, /existing_revision.*org\.opencontainers\.image\.revision/);
  assert.match(publication, /existing_upstream.*upstream\.digest/);
  assert.match(publication, /\[ "\$existing_revision" != "\$REVISION" \] \|\| \[ "\$existing_upstream" != "\$UPSTREAM_DIGEST" \]/);
  assert.match(publication, /Immutable tag \$\{tag\} already identifies a different image/);
  const immutablePush = publication.indexOf('docker push "$image"');
  const attest = publication.indexOf("uses: actions/attest-build-provenance");
  const latestPush = publication.indexOf('docker buildx imagetools create --tag "${IMAGE}:latest" "${IMAGE}@${DIGEST}"');
  assert.ok(immutablePush >= 0, "the immutable image must be pushed");
  assert.ok(attest >= 0, "provenance attestation must run");
  assert.ok(latestPush >= 0, "latest must be promoted from the immutable digest");
  assert.ok(immutablePush < attest, "immutable publication must precede attestation");
  assert.ok(attest < latestPush, "latest must only advance after attestation succeeds");
  assert.match(publication, /DIGEST: \$\{\{ steps\.publish\.outputs\.digest \}\}/);
});

test("published GHCR image receives SHA-pinned provenance with least required permissions", () => {
  const publish = workflows.find(([file]) => file === "publish.yml")?.[1] || "";
  assert.match(publish, /attestations: write/);
  assert.match(publish, /id-token: write/);
  assert.match(publish, /packages: write/);
  assert.match(publish, /actions\/attest-build-provenance@e8998f949152b193b063cb0ec769d69d929409be # v2\.4\.0/);
  assert.match(publish, /subject-name: \$\{\{ steps\.publish\.outputs\.image \}\}/);
  assert.match(publish, /subject-digest: \$\{\{ steps\.publish\.outputs\.digest \}\}/);
  assert.match(publish, /push-to-registry: true/);
});

test("CI helper containers are digest-pinned", () => {
  const http = fs.readFileSync(path.join(root, "scripts/auto-router-http-test.sh"), "utf8");
  const rollback = fs.readFileSync(path.join(root, "scripts/rollback-compatibility-test.sh"), "utf8");
  const pipeline = fs.readFileSync(path.join(root, "scripts/auto-router-pipeline-parity-test.sh"), "utf8");
  assert.match(http, /node:22-alpine@sha256:[0-9a-f]{64}/);
  assert.match(rollback, /node:22-alpine@sha256:[0-9a-f]{64}/);
  assert.match(pipeline, /node:22-alpine@sha256:[0-9a-f]{64}/);
  assert.match(rollback, /mcr\.microsoft\.com\/playwright:v1\.58\.2-noble@sha256:[0-9a-f]{64}/);
  assert.doesNotMatch(http, /node:22-alpine node/);
});

test("badge-state publication is fail-closed against a newer main and never rewrites history", () => {
  const publish = workflows.find(([file]) => file === "publish.yml")?.[1] || "";

  const badgeJob = publish.indexOf("badge-state:");
  const latestPromotion = publish.indexOf('docker buildx imagetools create --tag "${IMAGE}:latest"');
  const semverTag = publish.indexOf("Tag immutable Auto Router SemVer release");
  assert.ok(latestPromotion >= 0 && semverTag >= 0 && badgeJob > latestPromotion,
    "badge state must be recorded only after SemVer tagging and latest promotion");
  assert.ok(semverTag < latestPromotion, "SemVer identity precedes latest promotion");

  const guard = publish.indexOf("Verify this run still owns badge state on main");
  const write = publish.indexOf("Update known-good version badge state");
  const push = publish.indexOf("Publish badge state as a fast-forward of validated source");
  assert.ok(guard >= 0 && guard < write && write < push);

  // Ownership is re-derived from a freshly fetched remote before anything is written.
  assert.match(publish, /node scripts\/badge-state-guard\.mjs \\\n\s+--validated-revision "\$VALIDATED_REVISION" \\\n\s+--known-good-revision "\$KNOWN_GOOD_REVISION"/);
  assert.match(publish, /steps\.ownership\.outputs\.skip != 'true'/);
  assert.match(publish, /git push origin HEAD:main --force-with-lease=refs\/heads\/main:"\$VALIDATED_REVISION"/);
  assert.doesNotMatch(publish, /git push origin HEAD:main\s*$/m);
  assert.doesNotMatch(publish, /--force(?![-\w])/);
  assert.match(publish, /git diff --cached --quiet -- \.github\/badges/);

  // A stale run skips instead of failing, so a later production run owns the badge
  // state. The push step re-runs the same tested guard against a private output file
  // rather than trusting the earlier verdict or hand-rolled `git rev-parse` shell.
  const publishStep = publish.slice(push);
  assert.match(publishStep, /node scripts\/badge-state-guard\.mjs \\\n\s+--validated-revision "\$VALIDATED_REVISION" \\\n\s+--known-good-revision "\$VALIDATED_REVISION"/);
  assert.match(publishStep, /--github-output "\$recheck"/);
  assert.match(publishStep, /grep -qx 'skip=true' "\$recheck"/);
  assert.match(publishStep, /exit 0/);
  assert.doesNotMatch(publishStep, /exit 1/);
  // The ownership step must read the guard's verdict without shadowing GITHUB_OUTPUT.
  assert.doesNotMatch(publish, /skip=\$\(grep/);
  assert.doesNotMatch(publish, /lease=\$\(git rev-parse FETCH_HEAD\)/);

  const guardScript = fs.readFileSync(path.join(root, "scripts/badge-state-guard.mjs"), "utf8");
  assert.match(guardScript, /ls-remote/);
  assert.match(guardScript, /refs\/heads\/\$\{branch\}/);
});

test("lint blocks warnings and restricts CommonJS globals to runtime code", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  assert.match(manifest.scripts.lint, /eslint eslint\.config\.js auto-router-config\.cjs src patches test scripts --max-warnings=0/);
  const config = fs.readFileSync(path.join(root, "eslint.config.js"), "utf8");
  assert.match(config, /files: \["eslint\.config\.js", "patches\/\*\*\/\*\.mjs", "scripts\/\*\*\/\*\.mjs", "test\/\*\*\/\*\.mjs"\]/);
  assert.match(config, /files: \["auto-router-config\.cjs", "src\/\*\*\/\*\.cjs"\]/);
  assert.match(config, /sourceType: "commonjs"/);
});
