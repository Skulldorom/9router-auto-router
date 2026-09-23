import test from "node:test";
import assert from "node:assert/strict";

import {
  computeNextVersion,
  highestVersionTag,
  isNonReleasePath,
  isReleaseAffecting,
  resolveRelease,
  selectBump,
  versionTags,
} from "../scripts/release-version.mjs";
import { labelsForRevision, pickMergedPullRequest } from "../scripts/resolve-release-labels.mjs";

const SHA = "a".repeat(40);
const NEXT = "b".repeat(40);
const RELEASE = ["src/auto-router.cjs"];
const DOCS_ONLY = ["README.md", "docs/routing.md"];

function releasesAt(version, sha) {
  return [{ name: `v${version}`, sha }];
}

test("release-affecting PR without a version label defaults to PATCH", () => {
  const result = resolveRelease({ currentSha: NEXT, tags: releasesAt("0.1.0", SHA), changedFiles: RELEASE, labels: [] });
  assert.equal(result.version, "0.1.1");
  assert.equal(result.bump, "patch");
  assert.equal(result.releaseAffecting, true);
  assert.equal(result.createTag, true);
});

test("version:patch label keeps the PATCH bump", () => {
  assert.equal(selectBump(["version:patch"]), "patch");
  const result = resolveRelease({ currentSha: NEXT, tags: releasesAt("0.1.0", SHA), changedFiles: RELEASE, labels: ["version:patch"] });
  assert.equal(result.version, "0.1.1");
});

test("version:minor label selects a MINOR bump", () => {
  assert.equal(selectBump(["version:minor"]), "minor");
  const result = resolveRelease({ currentSha: NEXT, tags: releasesAt("0.1.0", SHA), changedFiles: RELEASE, labels: ["version:minor"] });
  assert.equal(result.version, "0.2.0");
});

test("version:major label selects a MAJOR bump", () => {
  assert.equal(selectBump(["version:major"]), "major");
  const result = resolveRelease({ currentSha: NEXT, tags: releasesAt("0.1.0", SHA), changedFiles: RELEASE, labels: ["version:major"] });
  assert.equal(result.version, "1.0.0");
});

test("conflicting version labels fail rather than choosing arbitrarily", () => {
  assert.throws(() => selectBump(["version:minor", "version:major"]), /Conflicting version labels/);
  assert.throws(() => selectBump(["version:patch", "version:minor", "version:major"]), /Conflicting version labels/);
});

test("bump type is never inferred from commit wording or unrelated labels", () => {
  assert.equal(selectBump(["feat!", "breaking change", "release", "bug"]), "patch");
});

test("README-only changes do not bump Auto Router", () => {
  const result = resolveRelease({ currentSha: NEXT, tags: releasesAt("0.1.0", SHA), changedFiles: ["README.md"], labels: [] });
  assert.equal(result.version, "0.1.0");
  assert.equal(result.releaseAffecting, false);
  assert.equal(result.createTag, false);
  assert.equal(result.bump, null);
});

test("docs-only changes do not bump Auto Router", () => {
  const result = resolveRelease({ currentSha: NEXT, tags: releasesAt("0.1.0", SHA), changedFiles: ["docs/release.md", "LICENSE"], labels: ["version:major"] });
  assert.equal(result.version, "0.1.0");
  assert.equal(result.releaseAffecting, false);
  assert.equal(result.createTag, false);
});

test("mixed code and documentation changes bump", () => {
  const result = resolveRelease({ currentSha: NEXT, tags: releasesAt("0.1.0", SHA), changedFiles: ["docs/x.md", "README.md", "src/auto-router.cjs"], labels: [] });
  assert.equal(result.version, "0.1.1");
  assert.equal(result.releaseAffecting, true);
});

test("test-only changes remain release affecting so release logic can ship", () => {
  assert.equal(isNonReleasePath("test/release-version.test.mjs"), false);
  const result = resolveRelease({ currentSha: NEXT, tags: releasesAt("0.1.0", SHA), changedFiles: ["test/release-version.test.mjs"], labels: [] });
  assert.equal(result.version, "0.1.1");
});

test("badge state changes are never release affecting", () => {
  assert.equal(isNonReleasePath(".github/badges/9router.json"), true);
  assert.equal(isReleaseAffecting([...DOCS_ONLY, ".github/badges/auto-router.json"]), false);
});

test("direct release-affecting push without merged PR labels defaults to PATCH", () => {
  // resolve-release-labels returns [] for a direct push, so the resolver must fall back.
  const result = resolveRelease({ currentSha: NEXT, tags: releasesAt("1.4.2", SHA), changedFiles: RELEASE, labels: [] });
  assert.equal(result.version, "1.4.3");
});

test("a retried or scheduled run reuses the version already tagged on the revision", () => {
  const first = resolveRelease({ currentSha: NEXT, tags: releasesAt("0.1.0", SHA), changedFiles: RELEASE, labels: [] });
  const retry = resolveRelease({ currentSha: NEXT, tags: releasesAt(first.version, NEXT), changedFiles: RELEASE, labels: ["version:major"] });
  assert.equal(retry.version, "0.1.1");
  assert.equal(retry.alreadyVersioned, true);
  assert.equal(retry.createTag, false);
  assert.equal(retry.bump, null);
});

test("scheduled upstream-only rebuild of an already released revision keeps the Auto Router version", () => {
  const result = resolveRelease({ currentSha: NEXT, tags: releasesAt("0.1.1", NEXT), changedFiles: ["Dockerfile"], labels: [] });
  assert.equal(result.version, "0.1.1");
  assert.equal(result.releaseAffecting, false);
  assert.equal(result.createTag, false);
});

test("the same source revision always resolves to the same Auto Router version", () => {
  const tags = [...releasesAt("0.1.0", SHA), ...releasesAt("0.1.1", "c".repeat(40))];
  const inputs = { currentSha: NEXT, tags, changedFiles: RELEASE, labels: [] };
  const runs = Array.from({ length: 5 }, () => resolveRelease(inputs).version);
  assert.deepEqual(new Set(runs), new Set(["0.1.2"]));
});

test("upstream version changes cannot alter Auto Router identity when source is unchanged", () => {
  // Upstream version/digest are inputs to validation only, never to version selection.
  const tags = releasesAt("1.4.2", SHA);
  const a = resolveRelease({ currentSha: SHA, tags, changedFiles: [], labels: [] });
  const b = resolveRelease({ currentSha: SHA, tags, changedFiles: ["Dockerfile"], labels: [] });
  assert.equal(a.version, "1.4.2");
  assert.equal(b.version, "1.4.2");
});

test("the highest existing version tag, not the declared base, seeds the next release", () => {
  const tags = [...releasesAt("1.4.2", SHA), ...releasesAt("1.4.3", "c".repeat(40))];
  const result = resolveRelease({ currentSha: NEXT, tags, changedFiles: RELEASE, labels: [] });
  assert.equal(result.version, "1.4.4");
  assert.equal(result.previousTag, "v1.4.3");
});

test("empty base version falls back to package.json base when no tag exists", () => {
  const result = resolveRelease({ currentSha: NEXT, tags: [], changedFiles: RELEASE, labels: [], baseVersion: "0.1.0" });
  assert.equal(result.version, "0.1.1");
});

test("version tags are ordered by semantic value, not string order", () => {
  const names = versionTags([
    { name: "v0.1.10", sha: SHA },
    { name: "v0.1.9", sha: SHA },
    { name: "not-a-version", sha: SHA },
  ]).map((tag) => tag.name);
  assert.deepEqual(names, ["v0.1.9", "v0.1.10"]);
  assert.equal(highestVersionTag([{ name: "v0.1.10", sha: SHA }, { name: "v0.1.9", sha: SHA }]).name, "v0.1.10");
});

test("duplicate version tags are rejected instead of silently choosing one", () => {
  assert.throws(() => versionTags([{ name: "v0.1.1", sha: SHA }, { name: "v0.1.1", sha: NEXT }]), /Duplicate Auto Router version tag/);
});

test("computeNextVersion implements MAJOR.MINOR.PATCH resets", () => {
  assert.equal(computeNextVersion("0.1.0", "patch"), "0.1.1");
  assert.equal(computeNextVersion("0.1.0", "minor"), "0.2.0");
  assert.equal(computeNextVersion("0.1.0", "major"), "1.0.0");
  assert.equal(computeNextVersion("1.4.2", "minor"), "1.5.0");
  assert.throws(() => computeNextVersion("0.1.0", "huge"), /Unsupported bump type/);
});

test("PR label resolution uses the merged PR owning the revision", () => {
  const pulls = [
    { number: 10, merged_at: "2026-01-01T00:00:00Z", merge_commit_sha: SHA, labels: [{ name: "version:minor" }] },
    { number: 11, merged_at: "2026-01-02T00:00:00Z", merge_commit_sha: NEXT, head: { sha: "d".repeat(40) }, labels: [{ name: "version:major" }] },
  ];
  assert.equal(pickMergedPullRequest(pulls, SHA).number, 10);
  assert.deepEqual(labelsForRevision(pulls, SHA), ["version:minor"]);
});

test("a later PR's labels never apply to an earlier revision", () => {
  const pulls = [{ number: 11, merged_at: "2026-01-02T00:00:00Z", merge_commit_sha: NEXT, labels: [{ name: "version:major" }] }];
  assert.equal(pickMergedPullRequest(pulls, SHA), null);
  assert.deepEqual(labelsForRevision(pulls, SHA), []);
});

test("squash and rebase merges fall back to the PR head commit match", () => {
  const pulls = [{ number: 12, merged_at: "2026-01-03T00:00:00Z", merge_commit_sha: "e".repeat(40), head: { sha: NEXT }, labels: ["version:patch"] }];
  assert.equal(pickMergedPullRequest(pulls, NEXT).number, 12);
  assert.deepEqual(labelsForRevision(pulls, NEXT), ["version:patch"]);
});

test("unmerged pull requests and non-version labels are ignored", () => {
  const pulls = [
    { number: 1, merged_at: null, merge_commit_sha: SHA, labels: [{ name: "version:major" }] },
    { number: 2, merged_at: "2026-01-01T00:00:00Z", merge_commit_sha: SHA, labels: [{ name: "enhancement" }] },
  ];
  assert.deepEqual(labelsForRevision(pulls, SHA), ["enhancement"]);
  assert.equal(selectBump(labelsForRevision(pulls, SHA)), "patch");
});
