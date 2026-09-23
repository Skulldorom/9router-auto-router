import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { evaluateBadgeOwnership, normalizeRevision, resolveRemoteMainTip } from "../scripts/badge-state-guard.mjs";

const REPO = path.resolve(import.meta.dirname, "..");
const BADGES = path.join(REPO, "scripts/update-version-badges.sh");

const A = "a".repeat(40);
const B = "b".repeat(40);
const C = "c".repeat(40);

function git(cwd, args, options = {}) {
  return childProcess.execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

function commit(cwd, message) {
  git(cwd, ["add", "-A"]);
  git(cwd, ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-q", "-m", message]);
  return git(cwd, ["rev-parse", "HEAD"]).trim();
}

// Bare `origin` plus a working clone, so `git ls-remote origin refs/heads/main`
// exercises the real remote path the production guard uses.
function makeRemote() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "badge-race-"));
  const origin = path.join(root, "origin.git");
  const work = path.join(root, "work");
  const other = path.join(root, "other");
  fs.mkdirSync(origin);
  fs.mkdirSync(work);
  fs.mkdirSync(other);
  git(origin, ["init", "--bare", "-b", "main"]);
  git(work, ["init", "-b", "main"]);
  git(work, ["remote", "add", "origin", origin]);
  fs.writeFileSync(path.join(work, "src.txt"), "one\n");
  const first = commit(work, "first");
  git(work, ["push", "-q", "origin", "main"]);
  return { root, origin, work, other, first };
}

function advanceMain(env) {
  childProcess.execFileSync("git", ["clone", "-q", env.origin, env.other], { stdio: "pipe" });
  fs.writeFileSync(path.join(env.other, "src.txt"), "two\n");
  const second = commit(env.other, "second");
  git(env.other, ["push", "-q", "origin", "main"]);
  return second;
}

test("normalizeRevision accepts only full lowercase git SHAs", () => {
  assert.equal(normalizeRevision(A), A);
  assert.equal(normalizeRevision(A.toUpperCase()), A);
  assert.equal(normalizeRevision(`  ${A}  `), A);
  assert.equal(normalizeRevision("a".repeat(39)), null);
  assert.equal(normalizeRevision("z".repeat(40)), null);
  assert.equal(normalizeRevision(""), null);
  assert.equal(normalizeRevision(undefined), null);
});

test("badge state is written only when main still matches the validated revision", () => {
  const owned = evaluateBadgeOwnership({ mainTip: A, validatedRevision: A, knownGoodRevision: A });
  assert.equal(owned.stale, false);
  assert.equal(owned.reason.includes(A), true);
});

test("a newer commit on main makes the older run stale instead of pushing badge state", () => {
  const verdict = evaluateBadgeOwnership({ mainTip: B, validatedRevision: A, knownGoodRevision: A });
  assert.equal(verdict.stale, true);
  assert.match(verdict.reason, /main advanced to/);
  assert.match(verdict.reason, /newer source revision owns badge state/);
});

test("an image recording a different revision than this run validated is stale", () => {
  const verdict = evaluateBadgeOwnership({ mainTip: A, validatedRevision: A, knownGoodRevision: B });
  assert.equal(verdict.stale, true);
  assert.match(verdict.reason, /known-good image records/);
});

test("an unresolvable or malformed revision fails closed", () => {
  assert.equal(evaluateBadgeOwnership({ mainTip: A, validatedRevision: "not-a-sha", knownGoodRevision: A }).stale, true);
  assert.equal(evaluateBadgeOwnership({ mainTip: "", validatedRevision: A, knownGoodRevision: A }).stale, true);
  assert.equal(evaluateBadgeOwnership({ mainTip: A, validatedRevision: A, knownGoodRevision: "" }).stale, true);
});

test("a stale run cannot overwrite badge state owned by a newer release", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "badge-state-"));
  const run = (autoRouter, upstream, revision) =>
    childProcess.execFileSync("sh", [BADGES, autoRouter, upstream, revision], {
      encoding: "utf8",
      env: { ...process.env, BADGE_STATE_DIR: dir },
    });

  // The newer release publishes first and owns current production state.
  run("0.2.0", "0.5.90", C);
  const ownerAuto = fs.readFileSync(path.join(dir, "auto-router.json"), "utf8");
  const ownerUpstream = fs.readFileSync(path.join(dir, "9router.json"), "utf8");
  assert.match(ownerAuto, /"message":\s*"v0\.2\.0"/);

  // The older release job retries later with the same revision it validated. Its
  // stale, lower version must be refused rather than rolled back or duplicated.
  run("0.1.0", "0.5.86", A);
  assert.equal(fs.readFileSync(path.join(dir, "auto-router.json"), "utf8"), ownerAuto);
  assert.equal(fs.readFileSync(path.join(dir, "9router.json"), "utf8"), ownerUpstream);

  // Re-running the owning release leaves both badge files byte-identical.
  run("0.2.0", "0.5.90", C);
  assert.equal(fs.readFileSync(path.join(dir, "auto-router.json"), "utf8"), ownerAuto);
  assert.equal(fs.readFileSync(path.join(dir, "9router.json"), "utf8"), ownerUpstream);
});

test("the guard reads the live remote tip and skips once main advances", () => {
  const env = makeRemote();
  try {
    assert.equal(resolveRemoteMainTip({ cwd: env.work }), env.first);

    const owned = evaluateBadgeOwnership({
      mainTip: resolveRemoteMainTip({ cwd: env.work }),
      validatedRevision: env.first,
      knownGoodRevision: env.first,
    });
    assert.equal(owned.stale, false);

    // A newer commit lands on main after the image was published but before the
    // badge commit; the older run must observe it and skip.
    const second = advanceMain(env);
    const newTip = resolveRemoteMainTip({ cwd: env.work });
    assert.equal(newTip, second);
    assert.notEqual(newTip, env.first);

    const stale = evaluateBadgeOwnership({
      mainTip: newTip,
      validatedRevision: env.first,
      knownGoodRevision: env.first,
    });
    assert.equal(stale.stale, true);

    // Skipping leaves the newer source state exactly where it was.
    assert.equal(resolveRemoteMainTip({ cwd: env.work }), second);
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

test("the CLI exits successfully and reports skip through GITHUB_OUTPUT", () => {
  const env = makeRemote();
  const output = path.join(env.root, "output.txt");
  fs.writeFileSync(output, "");
  try {
    advanceMain(env);
    const exitCode = childProcess.spawnSync(
      process.execPath,
      [
        path.join(REPO, "scripts/badge-state-guard.mjs"),
        "--validated-revision", env.first,
        "--known-good-revision", env.first,
        "--github-output", output,
      ],
      { cwd: env.work, encoding: "utf8" },
    );
    assert.equal(exitCode.status, 0);
    assert.match(exitCode.stdout, /Skipping badge state/);
    assert.match(fs.readFileSync(output, "utf8"), /^skip=true$/m);
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});
