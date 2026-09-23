#!/usr/bin/env node
// Recovers the labels of the pull request that introduced a source revision.
//
// A push event on `main` carries no PR metadata, so the release workflow asks the
// GitHub API which merged PR owns the commit. Only the PR whose merge commit (or,
// for rebases, head commit) is exactly the revision is used, which prevents a
// later PR's labels from being applied to an earlier commit. A direct push has no
// merged PR and yields no labels, so the resolver falls back to a PATCH bump.


export function pickMergedPullRequest(pulls, sha) {
  const list = Array.isArray(pulls) ? pulls.filter((pull) => pull && pull.merged_at && pull.merge_commit_sha) : [];
  const byMergeCommit = list.filter((pull) => pull.merge_commit_sha === sha);
  if (byMergeCommit.length > 1) {
    throw new Error(`Multiple merged pull requests claim merge commit ${sha}.`);
  }
  if (byMergeCommit.length === 1) return byMergeCommit[0];
  const byHead = list.filter((pull) => pull.head && pull.head.sha === sha);
  if (byHead.length > 1) {
    throw new Error(`Multiple merged pull requests claim head commit ${sha}.`);
  }
  return byHead.length === 1 ? byHead[0] : null;
}

export function labelsForRevision(pulls, sha) {
  const pull = pickMergedPullRequest(pulls, sha);
  if (!pull) return [];
  return (pull.labels || []).map((label) => (typeof label === "string" ? label : label?.name)).filter(Boolean);
}

export async function fetchPullsForCommit({ repository, sha, token, fetchImpl = fetch }) {
  const pulls = [];
  for (let page = 1; page <= 5; page += 1) {
    const url = `https://api.github.com/repos/${repository}/commits/${sha}/pulls?per_page=100&page=${page}`;
    const response = await fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    if (response.status === 404) return pulls;
    if (!response.ok) {
      throw new Error(`GitHub API request failed (${response.status}) for ${url}`);
    }
    const batch = await response.json();
    if (!Array.isArray(batch)) break;
    pulls.push(...batch);
    if (batch.length < 100) break;
  }
  return pulls;
}

async function main() {
  const sha = process.argv[2] || process.env.GITHUB_SHA;
  if (!sha) throw new Error("A source revision argument or GITHUB_SHA is required.");
  const repository = process.env.GITHUB_REPOSITORY || "Skulldorom/9router-auto-router";
  const token = process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "";
  const pulls = await fetchPullsForCommit({ repository, sha, token });
  const pull = pickMergedPullRequest(pulls, sha);
  const labels = labelsForRevision(pulls, sha);
  process.stderr.write(
    pull
      ? `Auto Router release labels for ${sha}: PR #${pull.number} (${labels.join(", ") || "no labels"})\n`
      : `Auto Router release labels for ${sha}: direct push, using defaults\n`,
  );
  process.stdout.write(`${JSON.stringify(labels)}\n`);
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  main().catch((error) => {
    process.stderr.write(`resolve-release-labels: ${error.message}\n`);
    process.exitCode = 1;
  });
}

