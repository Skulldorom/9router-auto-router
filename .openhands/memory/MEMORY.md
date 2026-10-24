# Project memory: 9router-auto-router

## Facts
- Repo: github.com/Skulldorom/9router-auto-router. Default branch `main`. Local dir `/root/projects/9router-auto-router-upstream-109-fix` (worktree for PR #45).
- Node project (`type: module`). Validation: `npm run check` (syntax + eslint) and `npm test` (`node --test`, 167 tests as of Oct 2026).
- Upstream base image: `decolua/9router`. Validated upstream for 0.5.109: digest `sha256:28474ba417ac76198abce43b6758b187201e0acac364f72ff3918b0f7e11b040`, revision `f39d8f07481ae8518e93175f0ecaaafa61573c6c`.
- Picker detection is AST-based (`pickerTypedKindSets` in `patches/apply-patch.mjs`): `new Set([...])` of string literals whose members are exactly `image,tts,stt,embedding,imageToText` optionally plus `systemone`. Matching is order/quote/whitespace independent; extra/dropped/duplicate kinds and multiple sets per file fail closed. Never match on chunk filenames or minified identifiers.
- `scripts/check-upstream-compatibility.sh` runs `node patches/apply-patch.mjs <workdir> --check` on `.next` copied out of a `docker create` container; `UPSTREAM_IMAGE` selects the digest.

## Environment quirks
- Workspace disk is 20 GB and fills up: the rollback test pulls the pinned Playwright image (3.4 GB) and installs Playwright in a container. `npm cache clean --force`, `docker builder prune`, and clearing `/root/.cache/ms-playwright` reclaim space; `ENOSPC`/`nospc` errors in tests are disk, not code.
- `rollback-compatibility-test.sh` requires `UPSTREAM_IMAGE` to be an immutable digest, not a tag.

## History
- Oct 2026: PR #45 (`fix/upstream-0.5.109-compatibility`) — upstream 0.5.109 added `systemone` natively to `TYPED_KINDS` (commit `bc4a3cc`), so the old byte-exact literal regex found 0 picker candidates. Replaced with AST detection; patch now appends `systemone` to the actual members and is a no-op when already native.
- Upstream 0.5.109 commit `ca7b540` ("fall through on empty-content streaming responses") treats a single unterminated Ollama JSON stream object as empty content and advances to the next combo model, which fans out the parity capture. The parity mock must emit newline-terminated NDJSON chunks.
