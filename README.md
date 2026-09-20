# 9Router Auto Router

Small Docker overlay for [decolua/9router](https://github.com/decolua/9router). It remains a drop-in 9Router image: Auto Router chooses exactly one normal 9Router combo, then delegates execution back to 9Router.

## UI-first setup

Use `ghcr.io/skulldorom/9router-auto-router:latest` and preserve the existing `/app/data` volume. Open the normal 9Router UI, open **Combos**, create or edit a combo, choose **Auto Router**, select **Easy target** and **Hard target**, optionally expand **Advanced**, and save. No `AUTO_ROUTER_*` variables are required.

The normal Compose example contains only the custom image and normal 9Router persistence. Target combos retain their existing fallback or Round Robin behavior.

```json
{
  "comboStrategies": {
    "coder-auto": {
      "fallbackStrategy": "auto",
      "autoRouter": {
        "easyTarget": "coder",
        "hardTarget": "coder-high",
        "hardThreshold": 6,
        "longContextChars": 24000,
        "largeToolResultChars": 12000,
        "manyTools": 16,
        "verbose": false
      }
    }
  }
}
```

The existing `/api/settings` and `/app/data` path persists this per-combo structure. Precedence is explicit `comboStrategies[comboName].autoRouter` field, then the matching legacy `AUTO_ROUTER_*` environment variable, then the built-in default. Legacy environment-only deployments continue to work.

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

Validated upstream `decolua/9router:0.5.75` / `latest` image digest `sha256:7c893bc2c27ecea2ae337abd5eacfec9e5763091b3a3b7862fc0625b770bb156` during initial integration. The release workflow resolves and validates the current immutable digest before every publish. The production server uses the compiled Next standalone assets; `/app/open-sse/services/combo.js` is not imported by that runtime copy, so changing it would not affect requests.

The overlay dynamically discovers the single runtime handler under `/app/.next/server`, rather than assuming a chunk name. It requires exactly one file containing all of these semantic anchors:

- `comboStrategies`
- `strategy: fusion`
- `Combo "`
- `handleSingleModel`
- `comboStickyRoundRobinLimit`

It then requires exactly two distinct Fusion dispatches and validates nearby `body`, combo-strategy, and settings bindings before adding guarded `auto` branches. Both branches delegate back into the original 9Router handler, so `coder` and `coder-high` run their normal fallback logic. Discovery returns zero or multiple candidates, missing anchors, unexpected bindings, or patch-integrity failures as build failures. The checker and patcher execute the same discovery code.

The current upstream UI has a compact serialized combo strategy list in one server and one client asset. The overlay validates both assets using the `Fallback`, `Round Robin`, and `Fusion` labels, then adds **Auto Router**, per-combo target selectors, and Advanced controls. If that exact structure changes, the build fails closed instead of modifying an uncertain asset. Upstream entrypoint, command, data mounts, user handling, and persistent data are unchanged.

## Configure 9Router

Create ordinary `coder` and `coder-high` combos first. Configure their existing fallback/round-robin chains normally. Create `coder-auto` with a non-empty placeholder model list if required by the upstream combo editor; its placeholder members are never executed once its strategy is `auto`.

Select **Auto Router** in the normal Combo strategy selector. The editor then exposes Easy target, Hard target, and Advanced settings. Do not configure `coder` or `coder-high` as `auto`, and never target `coder-auto`. Direct, target, and per-request re-entry cycles return `400` instead of recursing.

### Legacy environment compatibility

Existing deployments may retain `AUTO_ROUTER_*` variables. They are optional compatibility fallbacks, not the normal setup path. Per-combo UI fields take precedence over environment values, and missing fields use the built-in defaults listed below.

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

## Deploy the published image

Use the prebuilt GHCR image. No repository clone, Node.js installation, patch command, or local Docker build is required. It is a drop-in replacement for `decolua/9router:latest` and keeps the upstream command, ports, environment variables, networks, `/app/data` path, and persistent configuration behavior.

Change only the image:

```diff
services:
  9router:
-   image: decolua/9router:latest
+   image: ghcr.io/skulldorom/9router-auto-router:latest
```

Keep the existing volume unchanged. In particular, this persistent 9Router configuration remains intact:

```yaml
volumes:
  - 9router-data:/app/data
```

Accounts, settings, combos, provider configuration, ports, networks, and Headroom configuration continue to work without changes.

### Complete Compose example

```yaml
services:
  9router:
    image: ghcr.io/skulldorom/9router-auto-router:latest
    restart: unless-stopped
    ports:
      - "20128:20128"
    volumes:
      - 9router-data:/app/data
    environment:
      DATA_DIR: /app/data
      HEADROOM_URL: http://headroom:8787
      AUTO_ROUTER_EASY_TARGET: coder
      AUTO_ROUTER_HARD_TARGET: coder-high
    depends_on:
      headroom:
        condition: service_started

  headroom:
    image: ghcr.io/headroomlabs-ai/headroom:latest
    command: headroom proxy --host 0.0.0.0 --port 8787
    restart: unless-stopped

volumes:
  9router-data:
```

`HEADROOM_URL: http://headroom:8787` is retained exactly. The Auto Router overlay does not need any Headroom-specific configuration.

### Update and rollback

Pull and restart to update to the latest validated release:

```sh
docker compose pull
docker compose up -d
```

Every release also has recoverable immutable tags: `sha-<auto-router-commit>` and, when the upstream version label is available, `9router-<version>-sha-<auto-router-commit>`. Pin one to roll back:

```yaml
services:
  9router:
    image: ghcr.io/skulldorom/9router-auto-router:sha-<auto-router-commit>
```

The GitHub Actions release workflow validates the exact `decolua/9router@sha256:...` base before building. It runs static checks, all tests, compatibility discovery, Docker smoke tests, and a live container response test before it authenticates and updates `latest`. A six-hour scheduled check rebuilds only if this source commit or the upstream digest changed; failed validation leaves the prior known-good `latest` untouched.

## Development and advanced local builds

Local builds are for development, upstream compatibility work, or testing a candidate image. Use the immutable upstream digest that passed compatibility checks; do not treat a mutable `latest` tag as reproducible.

```sh
npm run check && npm test
UPSTREAM_IMAGE=decolua/9router@sha256:<digest> ./scripts/check-upstream-compatibility.sh
docker build \
  --build-arg UPSTREAM_IMAGE=decolua/9router@sha256:<digest> \
  --build-arg AUTO_ROUTER_REVISION="$(git rev-parse HEAD)" \
  --build-arg UPSTREAM_DIGEST=sha256:<digest> \
  --build-arg UPSTREAM_VERSION=<version> \
  --tag 9router-auto-router:local .
./scripts/smoke-test.sh 9router-auto-router:local
./scripts/runtime-test.sh 9router-auto-router:local
```

Compatibility errors report the image, candidate count/files, expected semantic anchors, and failure reason without dumping minified source. Do not force an incompatible build; update the guarded discovery and tests after reviewing upstream changes.

No runtime dependencies are added. Tests cover deterministic classification, realistic sanitized OpenHands fixtures, history reclassification, bounded keyword scoring, modality weighting, one-route/no-fan-out selection, body/tools/stream preservation, nested delegation, recursion protection, semantic discovery, zero/multiple candidate failures, idempotence, compatibility checks, Docker build, smoke tests, and runtime responses.
