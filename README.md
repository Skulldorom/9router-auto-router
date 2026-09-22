# 9Router Auto Router

<p align="center">
  <a href="https://ko-fi.com/skulldorom"><img src="https://ko-fi.com/img/githubbutton_sm.svg" alt="Support me on Ko-fi" /></a>
</p>

Adaptive model routing for [9Router](https://github.com/decolua/9router).

9Router Auto Router adds an **Auto Router** strategy to 9Router that automatically chooses between two existing 9Router combos based on the complexity of each request.

Instead of manually deciding which combo should handle a task:

```text
OpenHands / Client
       │
       ▼
   coder-auto
       │
       ├── easy ──► coder ─────► Luna High
       │
       └── hard ──► coder-high ► Terra High
```

Auto Router performs a fast, local, deterministic complexity check, selects **one** target combo, and delegates the request back to normal 9Router processing.

Your providers, accounts, quotas, fallback chains, Round Robin configuration, streaming, tools, models, and provider execution remain managed by 9Router.

Auto Router does **not** call another LLM to classify requests, fan requests out to multiple models, or send prompts to an external classification service.

## Getting started

If you already run 9Router with Docker Compose, getting started only requires changing the image.

### 1. Change the image

Update your existing Compose file:

```diff
services:
  9router:
-   image: decolua/9router:latest
+   image: ghcr.io/skulldorom/9router-auto-router:latest
```

Keep your existing ports, volumes, environment variables, networks, Headroom configuration, and other 9Router settings unchanged.

Then pull and start the new image:

```sh
docker compose pull
docker compose up -d
```

Keep your existing `/app/data` volume. Your accounts, settings, combos, and provider configuration remain intact.

### 2. Create your normal combos

In the 9Router UI, create or use the two ordinary combos that Auto Router should choose between.

For example:

```text
coder
└── Luna High

coder-high
└── Terra High
```

These are normal 9Router combos and can keep their own fallback or Round Robin configuration.

### 3. Create an Auto Router combo

Create another combo, for example `coder-auto`.

Select **Edit Combo**, choose **Auto Router** in the **Strategy** selector, configure:

```text
Easy target: coder
Hard target: coder-high
```

Optionally expand **Advanced** to tune the classifier thresholds, then select **Save**. The combo card only displays its selected strategy; Auto Router controls stay in **Edit Combo**.

No `AUTO_ROUTER_*` environment variables are required for normal setup.

### 4. Use it

Point OpenHands, VS Code, or any other OpenAI-compatible client at 9Router as usual and use the Auto Router combo as the model:

```text
model: coder-auto
```

Auto Router now decides whether each request should go to `coder` or `coder-high`. Everything after that decision is normal 9Router routing.

## How it works

Auto Router sits on top of normal 9Router combo handling. It does not replace 9Router's routing system.

```text
                    ┌─────────────┐
                    │   Request   │
                    └──────┬──────┘
                           │
                           ▼
                    ┌─────────────┐
                    │ Auto Router │
                    │ Classifier  │
                    └──────┬──────┘
                           │
                    Complexity
                      decision
                     /        \
                    /          \
                 Easy          Hard
                  │              │
                  ▼              ▼
               coder        coder-high
                  │              │
                  └──────┬───────┘
                         ▼
               Normal 9Router handling
```

The classifier chooses exactly **one** target. There is no fan-out, judge model, second LLM request, or comparison between model responses.

Once a target is selected, that combo behaves exactly as it normally would in 9Router. For example, `coder` can itself contain normal fallback routing:

```text
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

Auto Router only decides which existing combo receives the request.

### What makes a request hard?

Classification is local and deterministic.

The classifier considers signals including:

- task-oriented complexity phrases;
- conversation history;
- accumulated context size;
- actual tool calls and tool results;
- large tool output;
- multi-file or repository-wide work;
- debugging, audit, concurrency, root-cause, and similar complex tasks.

Strong phrases such as `fully audit`, `deep review`, `race condition`, `root cause`, `financial precision`, `performance investigation`, `debug intermittent`, `failing tests with unclear cause`, `repository-wide`, and `multi-file` carry meaningful weight.

Generic technical words such as `security`, `authentication`, `permissions`, `architecture`, and `migration` are deliberately weak signals by themselves.

For example, a simple request such as:

```text
Rename Authentication to Login
```

should remain easy, while:

```text
Fully audit the authentication and permissions implementation
```

provides much stronger evidence for the hard route.

Available tools are also deliberately weak evidence because agents such as OpenHands may expose a large toolset even for trivial tasks. Actual work history and substantial tool output are stronger signals.

### Supported request shapes

Classification reads the current user task from supported request bodies:

- OpenAI Chat Completions `messages`;
- OpenAI Responses-style `input`;
- translated Anthropic-style `contents`;
- nested 9Router request wrappers.

When several representations describe the same logical conversation, one populated canonical representation is inspected rather than double-counting the request.

Semantic scoring focuses on user task content. System prompts, assistant output, tool output, generated code, and metadata cannot independently make a request hard, although structural history and tool-result signals can still contribute to complexity.

Malformed requests, empty recognized requests, and classifier exceptions fail closed to the **hard** target.

### Privacy

Classification happens locally inside the 9Router container.

Auto Router does not:

- call an external classifier;
- call another LLM to decide the route;
- fan out to multiple models;
- persist request text;
- log prompt text.

Every routing decision can log the combo, level, selected target, bounded score, and reason labels without logging request text. Verbose mode adds structural classification metadata, not prompt content.

## Configuration

Most users should configure Auto Router entirely through the normal 9Router UI.

The persisted per-combo configuration looks like:

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

The **Advanced** controls expose the classifier thresholds:

| Setting | Default | Purpose |
| --- | ---: | --- |
| Hard threshold | `6` | Score at which a request becomes hard |
| Long context | `24000` | Character threshold for large context |
| Large tool result | `12000` | Character threshold for large tool output |
| Many tools | `16` | Threshold for unusually large toolsets |
| Verbose | `false` | Log structural routing metadata without request text |

Configuration is resolved independently per field in this order:

1. valid per-combo `comboStrategies[comboName].autoRouter` value;
2. valid matching legacy `AUTO_ROUTER_*` environment value;
3. built-in default.

Invalid or missing values fall through to the next source.

### Target rules

Easy and Hard targets must be ordinary 9Router combos.

Auto Router → Auto Router chaining is intentionally unsupported. The UI excludes the current combo and other Auto Router combos from the target selectors, and the runtime independently rejects self-referencing, missing, or Auto Router targets before delegation.

A resolver result that proves the target is missing produces the Auto Router configuration error. Unexpected resolver exceptions are allowed to propagate through the normal 9Router error path rather than being incorrectly reported as missing targets.

A per-request re-entry guard remains as defense-in-depth.

### Legacy environment compatibility

Existing deployments can continue using the original environment variables:

| Variable | Default | Meaning |
| --- | --- | --- |
| `AUTO_ROUTER_EASY_TARGET` | `coder` | Easy target |
| `AUTO_ROUTER_HARD_TARGET` | `coder-high` | Hard target |
| `AUTO_ROUTER_HARD_THRESHOLD` | `6` | Hard score threshold |
| `AUTO_ROUTER_LONG_CONTEXT_CHARS` | `24000` | Large-context threshold |
| `AUTO_ROUTER_LARGE_TOOL_RESULT_CHARS` | `12000` | Large tool-output threshold |
| `AUTO_ROUTER_MANY_TOOLS` | `16` | Large-toolset threshold |
| `AUTO_ROUTER_VERBOSE` | `false` | Emit structural metadata, never request text |

These variables are compatibility fallbacks, not the recommended setup path. New installations should use the UI.

## Updating

`latest` tracks the newest upstream 9Router image that has passed this project's compatibility and validation pipeline.

Update normally with:

```sh
docker compose pull
docker compose up -d
```

Before a new Auto Router image becomes `latest`, the release workflow resolves the upstream image to an immutable digest, validates compatibility, builds the overlay, and runs the project's validation suite.

If an upstream change breaks the integration, publishing fails closed and the previous known-good `latest` remains available.

A scheduled compatibility check runs every six hours and only rebuilds when the Auto Router source revision or upstream digest has changed.

### Pinning and rollback

For reproducible production deployments, pin the canonical full source revision tag:

```yaml
services:
  9router:
    image: ghcr.io/skulldorom/9router-auto-router:sha-<full-40-character-auto-router-commit>
```

Short SHA and upstream-version variants are also published, but the full SHA tag is the canonical immutable source identity.

To return to stock 9Router, change the image back:

```diff
services:
  9router:
-   image: ghcr.io/skulldorom/9router-auto-router:latest
+   image: decolua/9router:latest
```

Keep the existing `/app/data` volume.

The overlay does not migrate or replace the normal 9Router combo schema. Auto Router configuration remains in normal per-combo strategy settings.

After changing images, a browser may retain a cached patched Next.js bundle. If the Combos page looks stale after rollback, hard-refresh or use a clean/private browser session before assuming the persistent volume is damaged.

## Upstream compatibility

9Router Auto Router is an overlay rather than a fork of 9Router.

The published image starts from the upstream 9Router image and adds Auto Router while preserving the upstream command, ports, environment variables, networks, persistence path, providers, accounts, models, and normal routing behavior.

Because 9Router ships compiled Next.js assets, the overlay discovers the relevant runtime and UI structures using semantic and structural checks instead of relying on fixed minified filenames.

Runtime discovery requires the expected 9Router semantic anchors and exactly the expected Fusion dispatch structure. Bindings are associated structurally with their dispatch paths rather than by arbitrary fixed byte windows.

The UI patch similarly validates the expected strategy-selector structure before adding **Auto Router**, target selectors, and Advanced controls.

If the expected runtime or UI structures cannot be identified unambiguously, the build stops instead of patching an uncertain upstream version.

The compatibility checker and patcher use the same discovery logic, and the release pipeline validates the exact immutable upstream digest that is later used for the build.

## Relationship to 9Router

9Router continues to own:

- providers and accounts;
- authentication and quotas;
- models;
- fallback chains;
- Round Robin;
- capability routing;
- request translation;
- streaming and SSE;
- tools;
- provider execution.

Auto Router adds one decision:

```text
Which existing 9Router combo should handle this request?
```

Everything after that decision is normal 9Router.

## Development

Normal users do **not** need to clone this repository, install Node.js, run the patcher, or build an image locally.

Use:

```text
ghcr.io/skulldorom/9router-auto-router:latest
```

Local builds are intended for development, compatibility work, and testing.

### Local build

```sh
docker build -t 9router-auto-router .
```

This uses the Dockerfile's default `decolua/9router:latest` base and is convenient for development, but it is not reproducible over time.

### Reproducible build

Use an immutable upstream digest:

```sh
npm run check
npm test

UPSTREAM_IMAGE=decolua/9router@sha256:<digest> \
  ./scripts/check-upstream-compatibility.sh

docker build \
  --build-arg UPSTREAM_IMAGE="decolua/9router@sha256:<digest>" \
  --build-arg AUTO_ROUTER_REVISION="$(git rev-parse HEAD)" \
  --build-arg UPSTREAM_DIGEST=sha256:<digest> \
  --build-arg UPSTREAM_VERSION=<version> \
  -t 9router-auto-router:local .

./scripts/smoke-test.sh 9router-auto-router:local
./scripts/runtime-test.sh 9router-auto-router:local
```

The test suite covers deterministic classification, false-positive regressions, routing, target validation, configuration precedence, UI integration, semantic/structural upstream discovery, persistence, runtime behavior, and the patched-container HTTP request path.

`./scripts/auto-router-pipeline-parity-test.sh 9router-auto-router:local` sends one realistic 62-message, 83-tool OpenHands-style payload directly to `coder-high` and through `coder-auto` configured to select `coder-high`. Deterministic local Headroom and provider services capture both paths and require byte-identical target-provider bodies, Headroom input/output, RTK output, message/tool sizes, stream behavior, fallback/sticky combo handling, and format conversion. The direct `POST coder-high → provider` versus delegated `POST provider → provider` label is request logging identity; the captured target pipeline is identical.

Compatibility failures report the relevant image, candidate information, expected semantic structures, and failure reason without dumping minified source.

## Dependabot

Dependabot checks the ordinary dependency ecosystems in this overlay: npm and GitHub Actions.

Compatible minor and patch updates are grouped, major updates remain separate, and updates are not auto-merged.

Docker is deliberately handled by the dedicated upstream digest-validation pipeline instead of blind dependency bumps, because a new 9Router image must pass compatibility and runtime validation before it can replace the known-good Auto Router image.

## License

MIT
