# 9Router Auto Router

Small Docker overlay for [decolua/9router](https://github.com/decolua/9router). It is **not a 9Router fork**. It adds a local deterministic `auto` combo strategy that chooses exactly one normal 9Router target before generation.

```
OpenHands
   │
   ▼
coder-auto
   │
   ├── easy ──► coder ─────► Luna High
   │
   └── hard ──► coder-high ► Terra High
```

Nested combos retain their upstream behavior:

```
coder-auto
    │
    ├── easy
    │    └── coder
    │         ├── Luna High
    │         └── existing fallback(s)
    │
    └── hard
         └── coder-high
              ├── Terra High
              └── existing fallback(s)
```

`coder`, `coder-high`, providers, accounts, quotas, capability adapters, fallback chains, SSE, request bodies, tools, and streaming remain owned by 9Router. Auto does not fan out, invoke a judge, persist requests, log prompts, call an LLM, or know provider/model names.

## Current upstream integration

Inspected upstream default branch commit `a8c9d3802c5933500fba95416f5bf0c130581396` and published `decolua/9router:0.5.75` / `latest` image digest `sha256:7c893bc2c27ecea2ae337abd5eacfec9e5763091b3a3b7862fc0625b770bb156`. The production server uses the compiled Next standalone assets; `/app/open-sse/services/combo.js` is not imported by that runtime copy, so changing it would not affect requests.

The overlay dynamically discovers the single runtime handler under `/app/.next/server`, rather than assuming a chunk name. It requires exactly one file containing all of these semantic anchors:

- `comboStrategies`
- `strategy: fusion`
- `Combo "`
- `handleSingleModel`
- `comboStickyRoundRobinLimit`

It then requires exactly two distinct Fusion dispatches and validates nearby `body`, combo-strategy, and settings bindings before adding guarded `auto` branches. Both branches delegate back into the original 9Router handler, so `coder` and `coder-high` run their normal fallback logic. Discovery returns zero or multiple candidates, missing anchors, unexpected bindings, or patch-integrity failures as build failures. The checker and patcher execute the same discovery code.

The current upstream UI has a compact serialized combo strategy list in one server and one client asset. The overlay validates both assets using the `Fallback`, `Round Robin`, and `Fusion` labels, then adds **Auto — select one target**. If that exact structure changes, the build fails closed instead of modifying an uncertain asset. Upstream entrypoint, command, data mounts, user handling, and persistent data are unchanged.

## Configure 9Router

Create ordinary `coder` and `coder-high` combos first. Configure their existing fallback/round-robin chains normally. Create `coder-auto` with a non-empty placeholder model list because 9Router recognizes combos only when they have models. Its placeholder members are never executed once its strategy is `auto`.

The combo UI exposes **Strategy: Auto — select one target** after the overlay is built. Select it for `coder-auto`. Equivalent settings JSON is:

```json
{
  "comboStrategies": {
    "coder-auto": { "fallbackStrategy": "auto" }
  }
}
```

Do not configure `coder` or `coder-high` as `auto`, and never target `coder-auto`. Direct, target, and per-request re-entry cycles return `400` instead of recursing.

Point OpenHands at the standard 9Router OpenAI-compatible endpoint with `model = coder-auto`. Classification is stateless and reads the request's supplied Chat `messages`, Responses `input`, or translated `contents`; a later `continue` can therefore use the supplied earlier history.

## Classification

Classification is local and deterministic. It logs route, level, bounded score, and reason labels only; request text is never logged.

Available tools are deliberately weak evidence. OpenHands commonly supplies a normal toolset for trivial requests, so a realistic set plus `Rename this variable in src/foo.js` remains **easy → coder**. Tool count alone cannot reach the default hard threshold.

Actual work history is stronger evidence: repeated tool calls/results, substantial tool output, long message history, and large accumulated context add materially more. One image or small attachment adds only a small complexity signal; 9Router's unchanged capability routing remains responsible for vision/file requirements. Keyword groups are deduplicated and score-capped, so `fully audit this concurrency race condition` reports useful reasons such as `audit,concurrency` rather than a runaway score.

| Variable | Default | Meaning |
| --- | --- | --- |
| `AUTO_ROUTER_EASY_TARGET` | `coder` | Easy target |
| `AUTO_ROUTER_HARD_TARGET` | `coder-high` | Hard target |
| `AUTO_ROUTER_HARD_THRESHOLD` | `6` | Hard score threshold |
| `AUTO_ROUTER_LONG_CONTEXT_CHARS` | `24000` | Large-context threshold |
| `AUTO_ROUTER_LARGE_TOOL_RESULT_CHARS` | `12000` | Large tool-output threshold |
| `AUTO_ROUTER_MANY_TOOLS` | `16` | Large-toolset threshold; contributes at most 1, huge sets at most 2 |
| `AUTO_ROUTER_VERBOSE` | `false` | Emit numeric metadata, never request text |

Malformed requests, empty requests, and classifier exceptions fail closed to `hard`. Legitimate sparse OpenAI-compatible requests do not.

Example:

```
AUTO-ROUTER coder-auto → coder-high level=hard score=7 reasons=tools-present,audit,concurrency
```

## Build, compatibility, and deployment

Use a pinned image in production:

```sh
npm run check && npm test
UPSTREAM_IMAGE=decolua/9router:0.5.75 ./scripts/check-upstream-compatibility.sh
docker build --build-arg UPSTREAM_IMAGE=decolua/9router:0.5.75 -t 9router-auto-router:0.5.75 .
./scripts/smoke-test.sh 9router-auto-router:0.5.75
```

```sh
docker run -d --name 9router -p 20128:20128 \
  -v "$HOME/.9router:/app/data" -e DATA_DIR=/app/data \
  -e AUTO_ROUTER_EASY_TARGET=coder -e AUTO_ROUTER_HARD_TARGET=coder-high \
  9router-auto-router:0.5.75
```

`latest` is checked in CI as a non-blocking compatibility signal. Test it deliberately before deployment:

```sh
UPSTREAM_IMAGE=decolua/9router:latest ./scripts/check-upstream-compatibility.sh
```

Compatibility errors report the image, candidate count/files, expected semantic anchors, and failure reason without dumping minified source. Do not force an incompatible build; update the guarded discovery and tests after reviewing upstream changes. `examples/docker-compose.yml` retains the upstream `/app/data` mount.

## Development

No runtime dependencies are added. Tests cover deterministic classification, realistic sanitized OpenHands fixtures, history reclassification, bounded keyword scoring, modality weighting, one-route/no-fan-out selection, body/tools/stream preservation, nested delegation, recursion protection, semantic discovery, zero/multiple candidate failures, idempotence, compatibility checks, Docker build, and image smoke tests.
