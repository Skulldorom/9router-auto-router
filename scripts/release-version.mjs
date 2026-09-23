#!/usr/bin/env node
// Deterministic, idempotent Auto Router release version selection.
//
// The Auto Router semantic version is derived from durable git state, never from
// workflow run numbers, timestamps, commit counts, or image counts:
//
//   * annotated `vX.Y.Z` git tags map a source revision to an Auto Router version
//   * the highest tag is the base version for the next release
//   * a revision that already carries a version tag always reuses that version
//   * the bump is taken from the merged PR labels (PATCH by default)
//
// A revision is only "release affecting" when at least one changed path is not on
// the documented non-release allowlist. Scheduled upstream rebuilds of the same
// revision are therefore always idempotent.

import fs from "node:fs";
import path from "node:path";
import childProcess from "node:child_process";
import { fileURLToPath } from "node:url";

export const VERSION_TAG_PATTERN = /^v(\d+)\.(\d+)\.(\d+)$/;

export const BUMP_LABELS = Object.freeze({
  "version:patch": "patch",
  "version:minor": "minor",
  "version:major": "major",
});

// Explicitly documented non-release paths. Everything else is release affecting.
//
// `test/` intentionally is NOT exempt: tests guard the release/versioning logic, so a
// change to them must be able to ship as a new Auto Router version. Only pure
// documentation and the generated known-good badge state are exempt.
export const NON_RELEASE_FILES = Object.freeze([".gitignore", "LICENSE", "README.md"]);
export const NON_RELEASE_PREFIXES = Object.freeze([".github/badges/", "docs/"]);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export function parseVersion(value) {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(value ?? "").trim().replace(/^v/, ""));
  if (!match) return null;
  return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

export function formatVersion({ major, minor, patch }) {
  return `${major}.${minor}.${patch}`;
}

export function compareVersions(a, b) {
  const left = typeof a === "string" ? parseVersion(a) : a;
  const right = typeof b === "string" ? parseVersion(b) : b;
  if (!left || !right) throw new Error(`Invalid semantic version comparison: ${a} vs ${b}`);
  return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

export function versionTags(tags) {
  const byVersion = new Map();
  for (const tag of Array.isArray(tags) ? tags : []) {
    const match = VERSION_TAG_PATTERN.exec(String(tag?.name ?? ""));
    if (!match) continue;
    const version = `${match[1]}.${match[2]}.${match[3]}`;
    if (byVersion.has(version)) {
      throw new Error(`Duplicate Auto Router version tag v${version} is ambiguous.`);
    }
    byVersion.set(version, { name: tag.name, sha: tag.sha, version });
  }
  return [...byVersion.values()].sort((a, b) => compareVersions(a.version, b.version));
}

export function highestVersionTag(tags) {
  const sorted = versionTags(tags);
  return sorted.length ? sorted[sorted.length - 1] : null;
}

export function isNonReleasePath(file) {
  const normalized = String(file).replace(/^\.\//, "");
  return NON_RELEASE_FILES.includes(normalized)
    || NON_RELEASE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

export function isReleaseAffecting(files) {
  const list = Array.isArray(files) ? files.filter(Boolean) : [];
  if (list.length === 0) return false;
  return list.some((file) => !isNonReleasePath(file));
}

export function validateBumpLabels(labels) {
  const list = Array.isArray(labels) ? labels.filter(Boolean) : [];
  const applied = list.filter((label) => Object.hasOwn(BUMP_LABELS, label));
  const distinct = [...new Set(applied.map((label) => BUMP_LABELS[label]))];
  if (distinct.length > 1) {
    throw new Error(
      `Conflicting version labels present: ${[...applied].sort().join(", ")}. `
      + "Apply exactly one of version:patch, version:minor, or version:major.",
    );
  }
  return applied;
}

export function selectBump(labels) {
  const applied = validateBumpLabels(labels);
  return applied.length ? BUMP_LABELS[applied[0]] : "patch";
}

export function computeNextVersion(baseVersion, bump) {
  const base = parseVersion(baseVersion);
  if (!base) throw new Error(`Invalid base version: ${baseVersion}`);
  if (bump === "major") return formatVersion({ major: base.major + 1, minor: 0, patch: 0 });
  if (bump === "minor") return formatVersion({ major: base.major, minor: base.minor + 1, patch: 0 });
  if (bump === "patch") return formatVersion({ major: base.major, minor: base.minor, patch: base.patch + 1 });
  throw new Error(`Unsupported bump type: ${bump}`);
}

export function resolveRelease({ currentSha, tags = [], changedFiles = [], labels = [], baseVersion = "0.1.0" }) {
  // Label hygiene is validated for every release decision, not only when the change
  // happens to be release affecting, so a conflicting label always fails clearly.
  validateBumpLabels(labels);

  const versioned = versionTags(tags).find((tag) => tag.sha === currentSha);
  if (versioned) {
    return {
      version: versioned.version,
      baseVersion: versioned.version,
      previousTag: versioned.name,
      bump: null,
      releaseAffecting: false,
      alreadyVersioned: true,
      createTag: false,
    };
  }

  const highest = highestVersionTag(tags);
  const base = highest ? highest.version : baseVersion;
  const releaseAffecting = isReleaseAffecting(changedFiles);
  if (!releaseAffecting) {
    return {
      version: base,
      baseVersion: base,
      previousTag: highest ? highest.name : null,
      bump: null,
      releaseAffecting: false,
      alreadyVersioned: false,
      createTag: false,
    };
  }

  const bump = selectBump(labels);
  return {
    version: computeNextVersion(base, bump),
    baseVersion: base,
    previousTag: highest ? highest.name : null,
    bump,
    releaseAffecting: true,
    alreadyVersioned: false,
    createTag: true,
  };
}

export function readBaseVersion(root = ROOT) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  if (!parseVersion(manifest.version)) throw new Error(`package.json has an invalid version: ${manifest.version}`);
  return manifest.version;
}

export function collectVersionTags(cwd = process.cwd()) {
  const output = childProcess.execFileSync(
    "git",
    ["for-each-ref", "--format=%(refname:short)%09%(objectname)%09%(*objectname)", "refs/tags"],
    { cwd, encoding: "utf8" },
  );
  return output
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, objectname, dereferenced] = line.split("\t");
      return { name, sha: (dereferenced || objectname || "").trim() };
    })
    .filter((tag) => VERSION_TAG_PATTERN.test(tag.name));
}

export function changedFilesBetween(from, to, cwd = process.cwd()) {
  if (!from || !to) throw new Error("changedFilesBetween requires both base and target revisions.");
  return childProcess.execFileSync("git", ["diff", "--name-only", from, to], { cwd, encoding: "utf8" })
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function appendOutput(target, result, changedFileCount) {
  const lines = [
    `version=${result.version}`,
    `base_version=${result.baseVersion}`,
    `previous_tag=${result.previousTag ?? ""}`,
    `bump=${result.bump ?? "none"}`,
    `release_affecting=${result.releaseAffecting}`,
    `already_versioned=${result.alreadyVersioned}`,
    `create_tag=${result.createTag}`,
    `changed_file_count=${changedFileCount}`,
  ];
  const payload = `${lines.join("\n")}\n`;
  if (target) fs.appendFileSync(target, payload);
  process.stdout.write(payload);
}

function parseArgs(argv) {
  const args = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const value = argv[index + 1] && !argv[index + 1].startsWith("--") ? argv[++index] : "true";
      args[key] = value;
    } else {
      args._.push(token);
    }
  }
  return args;
}

function readLabels(labelsFile, inline) {
  if (inline !== undefined) {
    const parsed = JSON.parse(inline);
    return Array.isArray(parsed) ? parsed : [];
  }
  if (!labelsFile) return [];
  const raw = fs.readFileSync(labelsFile, "utf8").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // fall through to newline-delimited labels
  }
  return raw.split("\n").map((line) => line.trim()).filter(Boolean);
}

function commandResolve(args) {
  const currentSha = args.sha;
  if (!currentSha) throw new Error("resolve requires --sha <revision>");
  const tags = collectVersionTags();
  const highest = highestVersionTag(tags);
  const changedFiles = highest
    ? changedFilesBetween(highest.sha, currentSha)
    : changedFilesBetween(childProcess.execFileSync("git", ["rev-list", "--max-parents=0", currentSha], { encoding: "utf8" }).trim(), currentSha);
  const result = resolveRelease({
    currentSha,
    tags,
    changedFiles,
    labels: readLabels(args["labels-file"], args.labels),
    baseVersion: args["base-version"] || readBaseVersion(),
  });
  appendOutput(args["github-output"], result, changedFiles.length);
  return 0;
}

function commandResolveLabels(args) {
  const currentSha = args.sha;
  if (!currentSha) throw new Error("resolve-labels requires --sha <revision>");
  const tags = collectVersionTags();
  const highest = highestVersionTag(tags);
  const changedFiles = highest
    ? changedFilesBetween(highest.sha, currentSha)
    : changedFilesBetween(childProcess.execFileSync("git", ["rev-list", "--max-parents=0", currentSha], { encoding: "utf8" }).trim(), currentSha);
  const aliases = { patch: "version:patch", minor: "version:minor", major: "version:major" };
  const bump = selectBump(readLabels(args["labels-file"], args.labels));
  process.stdout.write(
    `release_affecting=${isReleaseAffecting(changedFiles)}\n`
    + `bump=${bump}\n`
    + `validated_label=${aliases[bump]}\n`,
  );
  return 0;
}

function commandCheckLabels() {
  const labels = readLabels(undefined, process.env.PR_LABELS || "[]");
  const bump = selectBump(labels);
  process.stdout.write(`bump=${bump}\n`);
  return 0;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];
  const commands = {
    resolve: () => commandResolve(args),
    "resolve-labels": () => commandResolveLabels(args),
    "check-labels": () => commandCheckLabels(),
  };
  if (!commands[command]) {
    process.stderr.write("Usage: release-version.mjs <resolve|resolve-labels|check-labels> [options]\n");
    return 2;
  }
  return commands[command]();
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`release-version: ${error.message}\n`);
    process.exitCode = 1;
  }
}
