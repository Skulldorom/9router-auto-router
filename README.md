# 9Router Auto Router

Small Docker overlay for [decolua/9router](https://github.com/decolua/9router). It is **not a 9Router fork**. It adds a local deterministic `auto` combo strategy that selects one normal 9Router route before generation.

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

`coder` and `coder-high` remain ordinary 9Router models/combos. This overlay never stores credentials, knows provider names, calls Luna/Terra, changes data, or replaces 9Router fallback/account/SSE/capability logic.

## Auto vs Fusion

Fusion fans out to multiple panel models and has a judge synthesize their answers. `auto` classifies **before** generation and invokes exactly one selected target. The target then runs its normal 9Router combo fallback chain. Tools, streaming, input bodies, and upstream capability routing are passed through unchanged.

## Current upstream integration

Validated against `decolua/9router:0.5.75` (upstream source commit `a8c9d3802c5933500fba95416f5bf0c130581396`, source version 0.5.81 on 2026-09-18; Docker Hub's newest published pin at implementation time is 0.5.75).

Upstream's production image is a Next standalone build. The source integration design is `src/sse/handlers/chat.js`: it obtains `settings.comboStrategies[combo].fallbackStrategy`, calls Fusion only when it equals `fusion`, otherwise calls `handleComboChat`. `open-sse/services/combo.js` supplies `handleComboChat`, `getRotatedModels`, `detectRequiredCapabilities`, and `reorderByCapabilities`; `accountFallback.js` owns fallback error semantics. The runtime equivalent is compiled in `/app/.next/server/chunks/8635.js`, with the combo service retained at `/app/open-sse/services/combo.js`.

The overlay copies one owned module to `/opt/9router-auto-router/auto-router.cjs`, then applies three small guarded edits to the compiled chat chunk:

1. require the owned module;
2. add `strategy === "auto"` in the public combo dispatch;
3. add the same branch in recursive combo dispatch, so a selected normal combo follows normal fallback.

Every anchor must occur exactly once. Changed/missing/ambiguous anchors fail the Docker build. The patch marker is idempotent; a second run detects it and does not duplicate code. Upstream `ENTRYPOINT ["/entrypoint.sh"]`, `CMD ["node", "custom-server.js"]`, port `20128`, `/app/data`, `/app/data-home`, user handling, and persistent data remain unchanged.

## Configure 9Router

Create normal `coder` and `coder-high` combos/models in 9Router first. Create `coder-auto` with any non-empty placeholder model list; 9Router currently recognizes a combo only when it has at least one model. Those placeholder members are never executed when `coder-auto` has `auto` strategy.

Set the per-combo strategy through the existing settings API/UI data, for example:

```json
{
  "comboStrategies": {
    "coder-auto": { "fallbackStrategy": "auto" }
  }
}
```

Do not configure `coder` or `coder-high` as `auto`; they should be normal fallback or round-robin combos. Do not target `coder-auto` from either environment variable. Direct and obvious auto-target cycles return a clear `400` instead of recursing.

Point OpenHands at the usual 9Router OpenAI-compatible endpoint and set `model = coder-auto`. No special session ID is assumed: classification is stateless and examines full request history, including OpenAI Chat `messages`, Responses `input`, and translated `contents`. This makes a later `continue` retain earlier tool/history signals.

## Classification

The classifier is local, deterministic, and logs metadata only. It uses approximate character counts, message count, tool definitions/history/results, current request modalities, and a bounded high-signal phrase set. It does not tokenize, persist bodies, log prompt text, use an LLM, call external services, or add telemetry.

Defaults:

| Variable | Default | Meaning |
| --- | --- | --- |
| `AUTO_ROUTER_EASY_TARGET` | `coder` | Target for easy requests |
| `AUTO_ROUTER_HARD_TARGET` | `coder-high` | Target for hard requests |
| `AUTO_ROUTER_HARD_THRESHOLD` | `6` | Score at which a request is hard |
| `AUTO_ROUTER_LONG_CONTEXT_CHARS` | `24000` | Large context threshold |
| `AUTO_ROUTER_LARGE_TOOL_RESULT_CHARS` | `12000` | Large tool-result threshold |
| `AUTO_ROUTER_MANY_TOOLS` | `5` | Many-tool threshold |
| `AUTO_ROUTER_VERBOSE` | `false` | Emit numeric metadata, never request text |

Strong terms such as `fully audit`, `migration`, `concurrency`, and `race condition` route hard. Large contexts, many tools, repeated/large tool results, and complex modalities add or independently trigger hard routing. Malformed, empty, or classifier-error requests fail safe to hard. Typical log:

```
AUTO-ROUTER coder-auto → coder-high level=hard score=6 reasons=short-context,no-tools,keyword:fully-audit
```

No request-level override is implemented in v1. Adding a non-standard body field risks OpenAI compatibility, and header propagation would require broader upstream handler changes. Use a separate `coder` or `coder-high` model selection when an explicit override is required.

## Build and deploy

Use a pin in production:

```sh
docker build --build-arg UPSTREAM_IMAGE=decolua/9router:0.5.75 -t 9router-auto-router:0.5.75 .
docker run -d --name 9router -p 20128:20128 \
  -v "$HOME/.9router:/app/data" -e DATA_DIR=/app/data \
  -e AUTO_ROUTER_EASY_TARGET=coder -e AUTO_ROUTER_HARD_TARGET=coder-high \
  9router-auto-router:0.5.75
```

For upstream latest, deliberately opt in and validate first:

```sh
UPSTREAM_IMAGE=decolua/9router:latest ./scripts/check-upstream-compatibility.sh
docker build --build-arg UPSTREAM_IMAGE=decolua/9router:latest -t 9router-auto-router:latest .
```

`examples/docker-compose.yml` retains the documented upstream `/app/data` mount. Adjust ports, env files, headroom, and named volume choices to match the existing deployment rather than replacing them.

## Safe upgrades, rollback, troubleshooting

Upgrade sequence: pull/check candidate upstream image, run unit tests, build the overlay, run smoke test, then deploy only if all pass:

```sh
npm run check && npm test
UPSTREAM_IMAGE=decolua/9router:0.5.75 ./scripts/check-upstream-compatibility.sh
docker build --build-arg UPSTREAM_IMAGE=decolua/9router:0.5.75 -t 9router-auto-router:0.5.75 .
./scripts/smoke-test.sh 9router-auto-router:0.5.75
```

Rollback by switching the service image back to the previously known overlay tag, or the original `decolua/9router:<known-good>` image. Both keep `/app/data` untouched.

- **Build fails with compatibility check:** upstream's compiled handler changed. Do not force the patch; review the current upstream integration points and update guarded anchors/tests.
- **`AUTO-ROUTER recursion blocked`:** target points at the auto combo, or a target is configured as `auto`. Restore normal target combo strategies.
- **Auto does not activate:** verify `coder-auto` exists as a non-empty combo and `comboStrategies.coder-auto.fallbackStrategy` is exactly `auto`.
- **Capability/tool issue:** target combos still use upstream routing. Check their model capability settings and normal 9Router logs; Auto never strips tools or bypasses `detectRequiredCapabilities`.

## Development

No runtime dependencies are added. `npm test` covers classifier signals, malformed/empty safety, target configuration, recursion prevention, single-route/no-fan-out semantics, streaming/tools preservation, request-shape coverage, and guarded patch behavior. CI performs syntax checks, tests, upstream compatibility validation, Docker build, and an image smoke test. It publishes nothing.
