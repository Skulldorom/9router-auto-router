#!/usr/bin/env node
// Verifies the Auto Router / upstream version metadata contract of a derived image.
//
// CI must prove the published metadata is correct rather than only setting it, so
// the expected values are passed in from the resolved release inputs, not read
// back from the image.

import childProcess from "node:child_process";
import { fileURLToPath } from "node:url";

export const REQUIRED_LABELS = Object.freeze({
  "org.opencontainers.image.revision": "sourceRevision",
  "org.opencontainers.image.version": "autoRouterVersion",
  "io.github.skulldorom.9router-auto-router.version": "autoRouterVersion",
  "io.github.skulldorom.9router-auto-router.upstream.version": "upstreamVersion",
  "io.github.skulldorom.9router-auto-router.upstream.digest": "upstreamDigest",
});

export function readImageLabels(image, { execFileSync = childProcess.execFileSync } = {}) {
  const raw = execFileSync(
    "docker",
    ["image", "inspect", image, "--format", "{{json .Config.Labels}}"],
    { encoding: "utf8" },
  );
  return JSON.parse(raw || "{}");
}

export function verifyImageMetadata(labels, expected) {
  const failures = [];
  for (const [label, field] of Object.entries(REQUIRED_LABELS)) {
    const actual = labels[label];
    const wanted = expected[field];
    if (!actual || actual === "unknown") {
      failures.push(`missing or unknown label ${label}`);
      continue;
    }
    if (wanted && actual !== wanted) {
      failures.push(`label ${label} is "${actual}", expected "${wanted}"`);
    }
  }
  const upstreamDigest = labels["io.github.skulldorom.9router-auto-router.upstream.digest"];
  if (upstreamDigest && !/^sha256:[0-9a-f]{64}$/.test(upstreamDigest)) {
    failures.push(`upstream digest label is not an immutable sha256 digest: ${upstreamDigest}`);
  }
  const autoRouterVersion = labels["io.github.skulldorom.9router-auto-router.version"];
  if (autoRouterVersion && !/^\d+\.\d+\.\d+$/.test(autoRouterVersion)) {
    failures.push(`Auto Router version label is not SemVer: ${autoRouterVersion}`);
  }
  const upstreamVersion = labels["io.github.skulldorom.9router-auto-router.upstream.version"];
  if (upstreamVersion && upstreamVersion !== "unknown" && !/^\d+\.\d+\.\d+$/.test(upstreamVersion)) {
    failures.push(`upstream version label is not SemVer: ${upstreamVersion}`);
  }
  return failures;
}

export function verifyImageMetadataFor(image, expected, options) {
  return verifyImageMetadata(readImageLabels(image, options), expected);
}

function main() {
  const [image, sourceRevision, autoRouterVersion, upstreamVersion, upstreamDigest] = process.argv.slice(2);
  if (!image || !autoRouterVersion || !upstreamVersion || !upstreamDigest) {
    process.stderr.write(
      "Usage: verify-image-metadata.mjs <image> <source-revision> <auto-router-version> <upstream-version> <upstream-digest>\n",
    );
    return 2;
  }
  const failures = verifyImageMetadataFor(image, {
    sourceRevision,
    autoRouterVersion,
    upstreamVersion,
    upstreamDigest,
  });
  if (failures.length) {
    process.stderr.write(`Image metadata verification failed for ${image}:\n- ${failures.join("\n- ")}\n`);
    return 1;
  }
  process.stdout.write(
    `Image metadata verified: ${image} revision=${sourceRevision} auto-router=${autoRouterVersion} upstream=${upstreamVersion} upstream_digest=${upstreamDigest}\n`,
  );
  return 0;
}

const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (invokedDirectly) {
  try {
    process.exitCode = main();
  } catch (error) {
    process.stderr.write(`verify-image-metadata: ${error.message}\n`);
    process.exitCode = 1;
  }
}
