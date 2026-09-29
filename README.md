# 9Router Auto Router

<p align="left">
  <a href="https://github.com/Skulldorom/9router-auto-router/releases"><img src="https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FSkulldorom%2F9router-auto-router%2Fmain%2F.github%2Fbadges%2Fauto-router.json" alt="Auto Router version" /></a>
  <a href="https://github.com/decolua/9router"><img src="https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2FSkulldorom%2F9router-auto-router%2Fmain%2F.github%2Fbadges%2F9router.json" alt="Validated 9Router version" /></a>
</p>

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

Auto Router selects **one** target combo and delegates the request back to normal 9Router processing. The routing method is configured per Auto Router combo:

- **Local classifier** performs a fast, deterministic local complexity check. It makes no additional model call and sends no prompt externally for classification.
- **Jev** calls the configured System One decision model with bounded, sanitized decision context. That request incurs the configured provider's applicable usage and cost; Sticky + Upgrade reduces repeated decision calls.

Your providers, accounts, quotas, fallback chains, Round Robin configuration, streaming, tools, models, and provider execution remain managed by 9Router.

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

Create another combo, for example `coder-auto`. On its combo card, select **Auto Router** from the normal **Strategy** selector.

Open **Edit Combo** and select the routing method.

For **Local**, arrange the Models list:

```text
1  coder        Easy
2  coder-high   Hard
3  backup       Ignored
```

Local uses position 1 for Easy, position 2 for Hard, and ignores models after position 2. Reorder the list to change targets.

For **Jev**, all configured models are candidates. Order them from cheapest/lower capability to strongest/higher capability; the configured System One decision model selects the lowest sufficient candidate. **Advanced** contains classifier tuning, Jev's decision model and timeout, and verbose logging.

Strategy selection stays on the combo card. Auto Router details stay in **Edit Combo**. No `AUTO_ROUTER_*` environment variables are required for normal setup.

### 4. Use it

Point any OpenAI-compatible client at 9Router as usual and use the Auto Router combo as the model:

```text
model: coder-auto
```

Local now decides whether each request should go to `coder` or `coder-high`; Jev selects from its ordered candidate list. Everything after that decision is normal 9Router routing.

Jev Sticky + Upgrade requires an API-key-scoped client identity and a stable conversation identity. The preferred client integration is the client-agnostic canonical header:

```text
X-9Router-Conversation-ID: <opaque stable conversation ID>
```

Header names are case-insensitive. `X-Conversation-ID`, `X-Session-ID`, and `X-Thread-ID` are also supported. For compatible request bodies, 9Router recognizes top-level `conversation_id`/`conversationId`, `session_id`/`sessionId`, and `thread_id`/`threadId`; nested `conversation.id`, `session.id`, or `thread.id`; and the same six fields in `metadata`.

Sticky selections are scoped to the combo, a hashed API-key-scoped client identity, and a hashed resolved conversation identity. Raw Authorization values and raw conversation identifiers are neither logged nor persisted in sticky or pending cache keys. Clients without a supported conversation identity remain stateless for Jev routing.

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

Both methods choose exactly **one** target and never fan out or compare model responses. Local uses no second model request. Jev makes one bounded System One decision request before normal 9Router delegation.

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

Semantic task phrases are currently primarily English-oriented. Language-independent structural signals—context and history size, tool availability and activity, tool-result size, modalities, and request shape—still apply to every request. Non-English prompts can therefore rely more heavily on structural complexity; adjust the per-combo thresholds and Easy/Hard targets when that better matches your workload.

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

Local classification happens entirely inside the 9Router container. Jev sends the following bounded, sanitized decision context to the configured System One provider:

- the current user request, bounded to about 4,000 characters;
- up to two previous user messages, bounded to about 600 characters each;
- structural metadata: message counts, tool-call/result counts and sizes, and modalities.

Jev does **not** send raw system prompts, tool definitions, raw tool output, credentials, raw Authorization headers, or the complete incoming OpenAI request envelope. Auto Router does not fan out requests, persist request text, or log prompt text.

Every routing decision can log the combo, level, selected target, bounded public score, and reason labels without logging request text. Verbose mode adds structural classification metadata, not prompt content.

## Configuration

Most users should configure Auto Router entirely through the normal 9Router UI.

For **Local**, ordered `models` are targets: `models[0]` is Easy, `models[1]` is Hard, and later models are ignored.

```json
{
  "comboStrategies": {
    "coder-auto": {
      "fallbackStrategy": "auto",
      "autoRouter": {
        "method": "local",
        "hardThreshold": 6,
        "longContextChars": 24000,
        "largeToolResultChars": 12000,
        "verbose": false
      }
    }
  }
}
```

For **Jev**, every configured model is a candidate and must be ordered from cheapest/lower capability to strongest/higher capability. Its persisted form includes the System One decision model and wait timeout:

```json
{
  "comboStrategies": {
    "coder-auto": {
      "fallbackStrategy": "auto",
      "autoRouter": {
        "method": "jev",
        "jev": {
          "decisionModel": "<system-one-model>",
          "timeoutMs": 1500
        }
      }
    }
  }
}
```

`jev.timeoutMs` controls how long Auto Router waits for the System One decision. On timeout, Auto Router aborts its local fetch to `/api/v1/systemone` and takes the existing fallback or sticky-route path. Current 9Router releases do not propagate that request signal through the System One handler to its provider fetch, so this is best-effort local cancellation, not a guarantee that the provider request stops or avoids usage.

Jev dispatches to the internal HTTP listener at `http://127.0.0.1:${PORT:-20128}` rather than the external request origin, so HTTPS reverse proxies cannot change its internal transport. Set `NINE_ROUTER_INTERNAL_ORIGIN` to an `http:` or `https:` origin only when the 9Router listener is reached through a different internal service address. The incoming 9Router `Authorization` header is forwarded only to satisfy 9Router API-key authentication; provider credentials remain resolved inside the System One handler.

The **Advanced** controls expose the classifier thresholds:

| Setting | Default | Supported range | Purpose |
| --- | ---: | ---: | --- |
| Hard threshold | `6` | `1`–`100` | Score at which a request becomes hard |
| Long context | `24000` | `1`–`10000000` | Character threshold for large context |
| Large tool result | `12000` | `1`–`10000000` | Character threshold for large tool output |
| Verbose | `false` | — | Log structural routing metadata without request text |

The UI restores an invalid saved or typed numeric value to that field's default. Runtime validation uses these same inclusive bounds for persisted configuration and legacy environment fallbacks; out-of-range values fall through to the next configuration source. Static tool availability does not independently raise complexity: large agent tool catalogs can accompany trivial tasks. Actual tool calls, tool results, and tool-result size still contribute to classification.

Configuration is resolved independently per field in this order:

1. valid per-combo `comboStrategies[comboName].autoRouter` value;
2. valid matching legacy `AUTO_ROUTER_*` environment value;
3. built-in default.

Invalid or missing values fall through to the next source.

### Target rules

Both methods require at least two distinct usable models. Local uses only the first two; Jev uses all ordered models as candidates. The runtime returns a controlled configuration error for zero, one, duplicate, or malformed targets. Reordering Models changes the effective targets on the next saved combo.

Auto Router → Auto Router chaining is intentionally unsupported. Runtime validation independently rejects self-references and Auto Router targets before delegation. A per-request re-entry guard remains as defense-in-depth.

### Legacy configuration compatibility

Earlier Auto Router releases stored `autoRouter.easyTarget` and `autoRouter.hardTarget`. A patched installation continues using those values until the combo is saved in **Edit Combo**. The editor presents them as positions 1 and 2, followed by existing Models after duplicates are removed, so its visible order matches runtime routing. On Save, the visible model order—after any reorder or replacement—is persisted exactly, and the duplicate legacy fields are removed while Advanced settings are retained. This is idempotent: after the first save, the visible model list is authoritative. Stock 9Router safely ignores the additional `autoRouter` settings during rollback.

Legacy environment variables remain fallback sources for classifier tuning only:

| Variable | Default | Meaning |
| --- | --- | --- |
| `AUTO_ROUTER_HARD_THRESHOLD` | `6` | Hard score threshold (`1`–`100`) |
| `AUTO_ROUTER_LONG_CONTEXT_CHARS` | `24000` | Large-context threshold (`1`–`10000000`) |
| `AUTO_ROUTER_LARGE_TOOL_RESULT_CHARS` | `12000` | Large tool-output threshold (`1`–`10000000`) |
| `AUTO_ROUTER_VERBOSE` | `false` | Emit structural metadata, never request text |

These variables are compatibility fallbacks, not the recommended setup path. New installations should use the UI. Persisted `manyTools` and `AUTO_ROUTER_MANY_TOOLS` from older installations are accepted and ignored; an Auto Router save deliberately removes the obsolete persisted field.

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

For reproducible production deployments, pin the canonical immutable tag. It identifies both the full Auto Router source revision and the exact upstream manifest digest:

```yaml
services:
  9router:
    image: ghcr.io/skulldorom/9router-auto-router:sha-<full-40-character-auto-router-commit>-upstream-<64-character-upstream-digest>
```

The tag omits the `sha256:` separator before the upstream digest. Every source-and-upstream pair receives one immutable tag. A retry skips an existing tag only when both image labels match that pair; any mismatch fails closed. `latest` remains the mutable last-known-good pointer and changes only after the immutable image is published, its provenance attestation succeeds, and both source and upstream freshness checks pass.

Each immutable GHCR image also receives a signed SLSA build-provenance attestation. Verify a deployed image with:

```sh
gh attestation verify \
  oci://ghcr.io/skulldorom/9router-auto-router@sha256:<published-image-manifest-digest> \
  --owner Skulldorom
```

Use the manifest digest reported by `docker buildx imagetools inspect` for the immutable tag. The attestation is bound to that digest, not to mutable `latest`.

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

## Versions

Two independent versions describe a published Auto Router image:

* **Auto Router `vX.Y.Z`** tracks this overlay's own source. It advances only when
  a release-affecting change lands on `main`.
* **9Router `vA.B.C`** tracks the upstream 9Router version the currently published
  known-good image was validated against. It can advance on its own without moving
  the Auto Router version.

They are intentionally independent, so an upstream-only rebuild keeps the Auto
Router version and only advances the 9Router version.

Auto Router bumps follow `MAJOR.MINOR.PATCH`:

* a normal release-affecting pull request uses a **patch** bump;
* `version:patch` keeps the **patch** bump;
* `version:minor` requests a **minor** bump;
* `version:major` requests a **major** bump.

Only one `version:*` label may apply to a pull request; conflicting labels fail the
release instead of choosing one arbitrarily. Documentation-only changes (`README.md`,
`docs/**`) do not bump the Auto Router version, and neither do scheduled upstream
checks or retries. When a change mixes documentation with release-affecting files,
the Auto Router version still bumps.

### Tagging and immutability policy

A published image can carry several tags with different mutability guarantees:

* `latest` is mutable and points at the newest known-good source-and-upstream combination.
* `sha-<source-revision>-upstream-<upstream-digest>` is the immutable exact
  source/upstream identity described under [Pinning and rollback](#pinning-and-rollback).
* `vX.Y.Z` is the immutable Auto Router SemVer release tag. It is created once for
  the source release that first produced it and is never repointed; a later
  upstream-only rebuild moves `latest` without mutating it.
* The annotated git tag `vX.Y.Z` is the durable source of truth that maps an Auto
  Router source revision to its semantic version. Only the release workflow creates
  it, and only for the revision that introduced the version.

The annotated git tag is what makes version selection deterministic and idempotent:
scheduled rebuilds, retries, and manual re-dispatches of an already versioned revision
always reuse the tagged version. No version is ever derived from workflow run numbers,
timestamps, commit counts, or image counts.

The README badges read repository-hosted badge state that is written only after the
known-good image has been published and attested, so the 9Router badge never reports
an upstream version that has not passed this project's validation.

## Upstream compatibility

9Router Auto Router is an overlay rather than a fork of 9Router.

The published image starts from the upstream 9Router image and adds Auto Router while preserving the upstream command, ports, environment variables, networks, persistence path, providers, accounts, models, and normal routing behavior.

Because 9Router ships compiled Next.js assets, the overlay discovers the relevant runtime and UI structures using semantic and structural checks instead of relying on fixed minified filenames.

Runtime discovery requires the expected 9Router semantic anchors and exactly the expected Fusion dispatch structure. Bindings are associated structurally with their dispatch paths rather than by arbitrary fixed byte windows.

The UI patch similarly validates the expected strategy-selector structure before appending **Auto Router**, retaining native strategy persistence, and adding model-order labels with Advanced controls.

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
