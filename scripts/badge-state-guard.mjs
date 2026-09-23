#!/usr/bin/env node
// Decides whether this production run still owns `main`, i.e. whether it may attach
// generated known-good badge state to the current source revision.
//
// The release workflow validates and publishes an immutable image for one source
// revision and only records badge state later, after attestation, SemVer tagging and
// `latest` promotion. That is a long window: a newer commit can land on `main` in
// the meantime. Rather than relying on Git's non-fast-forward rejection, this guard
// explicitly compares the freshly fetched `origin/main` tip with the revision this
// run validated and with the revision the known-good image records. A stale run
// skips badge publication entirely (successfully) so the newer production run owns
// current badge state, and a badge-state job can never commit generated production
// state on top of source it did not validate.

import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const REVISION_PATTERN = /^[0-9a-f]{40}$/;

export function normalizeRevision(value) {
  if (value === undefined || value === null) return null;
  const revision = String(value).trim().toLowerCase();
  return REVISION_PATTERN.test(revision) ? revision : null;
}

export function evaluateBadgeOwnership({ mainTip, validatedRevision, knownGoodRevision }) {
  const validated = normalizeRevision(validatedRevision);
  if (!validated) {
    return { stale: true, reason: `validated source revision '${validatedRevision}' is not a 40-character git SHA` };
  }

  const tip = normalizeRevision(mainTip);
  if (!tip) {
    return { stale: true, reason: `could not resolve the current origin/main tip ('${mainTip}')` };
  }
  if (tip !== validated) {
    return {
      stale: true,
      reason: `main advanced to ${tip} after this run validated ${validated}; a newer source revision owns badge state`,
    };
  }

  const knownGood = normalizeRevision(knownGoodRevision);
  if (!knownGood) {
    return { stale: true, reason: `the known-good image does not record a source revision ('${knownGoodRevision}')` };
  }
  if (knownGood !== validated) {
    return {
      stale: true,
      reason: `the known-good image records ${knownGood}, not this run's validated revision ${validated}; `
        + "a newer release owns badge state",
    };
  }

  return { stale: false, reason: `origin/main tip ${tip} still matches the validated revision ${validated}` };
}

// Read-only remote query: no local refs are mutated, so repeated calls are safe.
export function resolveRemoteMainTip({ cwd = process.cwd(), remote = "origin", branch = "main" } = {}) {
  const output = childProcess.execFileSync("git", ["ls-remote", remote, `refs/heads/${branch}`], {
    cwd,
    encoding: "utf8",
  });
  const [sha] = output.trim().split(/\s+/);
  return sha ?? "";
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

function main(argv) {
  const args = parseArgs(argv);
  const remote = args.remote || "origin";
  const branch = args.branch || "main";

  const mainTip = resolveRemoteMainTip({ remote, branch });
  const verdict = evaluateBadgeOwnership({
    mainTip,
    validatedRevision: args["validated-revision"],
    knownGoodRevision: args["known-good-revision"],
  });

  process.stdout.write([
    `skip=${verdict.stale}`,
    `main_tip=${mainTip}`,
    `validated_revision=${normalizeRevision(args["validated-revision"]) ?? ""}`,
    `known_good_revision=${normalizeRevision(args["known-good-revision"]) ?? ""}`,
    `reason=${verdict.reason}`,
    "",
  ].join("\n"));
  if (args["github-output"]) {
    fs.appendFileSync(
      args["github-output"],
      `skip=${verdict.stale}\nreason=${verdict.reason}\nmain_tip=${mainTip}\n`,
    );
  }
  process.stdout.write(
    verdict.stale
      ? `Skipping badge state: ${verdict.reason}. The newer production run records current badge state.\n`
      : `This run still owns badge state: ${verdict.reason}.\n`,
  );
  return 0;
}

const invokedDirectly = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  try {
    process.exitCode = main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`badge-state-guard: ${error.message}\n`);
    process.exitCode = 1;
  }
}
