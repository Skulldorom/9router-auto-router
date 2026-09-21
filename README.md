# 9Router Auto Router

<p align="center">
  <a href="https://ko-fi.com/skulldorom"><img src="https://ko-fi.com/img/githubbutton_sm.svg" alt="Support me on Ko-fi" /></a>
</p>

Small Docker overlay for [decolua/9router](https://github.com/decolua/9router). It remains a drop-in 9Router image: Auto Router chooses exactly one normal 9Router combo, then delegates execution back to 9Router.

## UI-first setup

Use `ghcr.io/skulldorom/9router-auto-router:latest` and preserve the existing `/app/data` volume. Open the normal 9Router UI, open **Combos**, create or edit a combo, choose **Auto Router**, select **Easy target** and **Hard target**, optionally expand **Advanced**, and save. The target selectors list existing combos and exclude the combo being edited. No `AUTO_ROUTER_*` variables are required.

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

The existing `/api/settings` and `/app/data` path persists this per-combo structure. Precedence is independently applied to every field: valid `comboStrategies[comboName].autoRouter` value, then a valid matching legacy `AUTO_ROUTER_*` environment value, then the built-in default. Empty targets, non-positive/non-integer thresholds, and non-boolean verbose values are invalid and therefore fall through to the next source. Legacy environment-only deployments continue to work.

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

Nested combos retain their upstream behavior, but Auto Router chaining is intentionally not supported:

```
coder-auto
    │
    ├── easy
    │    └── coder                     (ordinary combo; may use fallback/round-robin)
    │         ├── Luna High
    │         └── existing fallback(s)
    │
    └── hard
         └── coder-high                (ordinary combo; may use fallback/round-robin)
              ├── Terra High
              └── existing fallback(s)
```

An Auto Router target must be an ordinary (non-`auto`) combo. Auto Router → Auto Router chaining is intentionally unsupported: an easy/hard target that the same Auto Router combo, or one whose `fallbackStrategy` is `auto`, is rejected with a controlled `400` before delegation. A per-request re-entry guard remains as defense-in-depth, but correctness does not depend on request object identity surviving delegation.

`coder`, `coder-high`, providers, accounts, quotas, capability adapters, fallback chains, SSE, request bodies, tools, and streaming remain owned by 9Router. Auto does not fan out, invoke a judge, persist requests, log prompts, call an LLM, or know provider/model names.

## Current upstream integration

Validated upstream `decolua/9router:0.5.75` / `latest` image digest `sha256:7c893bc2c27ecea2ae337abd5eacfec9e5763091b3a3b7862fc0625b770bb156` during initial integration. The release workflow resolves and validates the current immutable digest before every publish. The production server uses the compiled Next standalone assets; `/app/open-sse/services/combo.js` is not imported by that runtime copy, so changing it would not affect requests.

The overlay dynamically discovers the single runtime handler under `/app/.next/server`, rather than assuming a chunk name. It requires exactly one file containing all of these semantic anchors:

- `comboStrategies`
- `strategy: fusion`
- `Combo "`
- `handleSingleModel`
- `comboStickyRoundRobinLimit`

It then requires exactly two distinct Fusion dispatches. For each dispatch it parses that dispatch's own object literal, then walks enclosing brace scopes to associate the `body`, models-resolver, `comboStrategies`/settings, and single-model delegation that belong to the same dispatch path before adding guarded `auto` branches. Association is structural, not distance-based: bindings may sit arbitrarily far from the Fusion anchor, and extraneous properties on the dispatch are ignored. Both branches delegate back into the original 9Router handler, so `coder` and `coder-high` run their normal fallback logic. Discovery returns zero or multiple candidates, missing anchors, unexpected or ambiguous bindings, or patch-integrity failures as build failures. The checker and patcher execute the same discovery code.

The current upstream UI has a compact serialized combo strategy list in one server and one client asset. The overlay validates both assets using the `Fallback`, `Round Robin`, and `Fusion` labels, then adds **Auto Router**, per-combo target selectors, and Advanced controls. If that exact structure changes, the build fails closed instead of modifying an uncertain asset. Upstream entrypoint, command, data mounts, user handling, and persistent data are unchanged.

## Configure 9Router

Create ordinary `coder` and `coder-high` combos first. Configure their existing fallback/round-robin chains normally. Create `coder-auto` with a non-empty placeholder model list if required by the upstream combo editor; its placeholder members are never executed once its strategy is `auto`.

Select **Auto Router** in the normal Combo strategy selector. The editor exposes labeled **Easy target** and **Hard target** selectors, plus **Advanced** controls for **Hard threshold**, **Long context threshold (characters)**, **Large tool-result threshold (characters)**, **Many-tools threshold**, and **Verbose logging**. Numeric controls use synchronized editable state: external settings reloads update their displayed values, invalid edits restore the current persisted/default value on blur, and valid values save only on blur. Easy and Hard targets must be ordinary (non-`auto`) combos. The selector excludes the current combo and every other Auto Router combo, while ordinary fallback and Round Robin combos remain selectable. Persisted deleted or now-invalid targets remain visible as a disabled `missing or Auto Router — unsupported target` option; the UI never silently changes them. A target equal to the Auto Router combo itself, or configured with `fallbackStrategy: "auto"`, is still rejected with a controlled `400` before delegation, so stale/manual configurations cannot bypass the rule. Target existence is verified through the upstream resolver at the runtime boundary; this intentionally remains separate from settings strategy inspection because only that resolver can prove a persisted target still exists. A resolver that resolves to `false` means the configured target is genuinely missing and returns the existing Auto Router configuration error. A resolver that throws or rejects is an unexpected upstream/runtime failure: that error propagates through the normal 9Router error path and is never rewritten as a missing target. A per-request re-entry guard remains defense-in-depth and is released on failure, so a resolver failure cannot poison later routing.

### Legacy environment compatibility

Existing deployments may retain `AUTO_ROUTER_*` variables. They are optional compatibility fallbacks, not the normal setup path. Each valid per-combo UI field takes precedence over its matching environment value; missing or invalid UI fields use a valid environment value, otherwise the built-in default listed below.

Point OpenHands at the standard 9Router OpenAI-compatible endpoint with `model = coder-auto`. Classification is stateless and reads the request's supplied Chat `messages`, Responses `input`, or translated `contents`; a later `continue` can therefore use the supplied earlier history.

## Classification

Classification is local and deterministic. Every routing decision logs its combo, level, target, bounded score, and reason labels; request text is never logged. `AUTO_ROUTER_VERBOSE=true` additionally logs structural classification metadata, never request text. Semantic terms use case-insensitive whole tokens and adjacent token phrases, not raw substrings. Ordinary prose punctuation joins phrase words, so `fully-audit`, `fully: audit`, and `race-condition` retain their normal task meaning. Paths, filenames, snake_case, and camelCase identifiers remain atomic: `reviewStatus`, `migrationPlan`, and `migration-plan.json` do not count as task actions. Quoted actions alone do not score, while an unquoted task action can use quoted domain context such as `Investigate "authentication architecture"`.

Available tools are deliberately weak evidence. OpenHands commonly supplies a normal toolset for trivial requests, so a realistic set plus `Rename this variable in src/foo.js` remains **easy → coder**. Tool count alone cannot reach the default hard threshold.

Actual work history is stronger evidence: repeated tool calls/results, substantial tool output, long message history, and large accumulated context add materially more. One image or small attachment adds only a small complexity signal; 9Router's unchanged capability routing remains responsible for vision/file requirements.

Semantic scoring reads current user task content, with weak earlier-user context only; system prompts, assistant output, tool output, generated code, and metadata cannot independently make a request hard. Earlier user semantic evidence is capped at four total points and at one point below any configured hard threshold, so it helps a genuine follow-up without accumulating into a hard route by itself. Supported request bodies are OpenAI Chat Completions `messages`, OpenAI Responses `input` (string or role-tagged item array), and translated Anthropic-style `contents`; nested 9Router request wrappers are handled. When an adapter supplies several representations for the same logical conversation, exactly one populated canonical shape is inspected: `messages`, then `input`, then `contents`; empty placeholders fall through to a populated supported shape, while an all-empty recognized request fails closed. Other shapes are not treated as semantic user input. The validated upstream exposes Chat Completions as the public completion endpoint; Responses `input` and translated `contents` reach Auto Router only at its internal normalized request boundary, so deterministic unit regressions cover those shapes while the container test covers the public HTTP path. Structural history signals still apply. Strong task phrases (`fully audit`, `deep review`, `race condition`, `root cause`, `financial precision`, `performance investigation`, `debug intermittent`, `intermittent failing tests`, `failing tests with unclear cause`, `repository-wide`, `multi-file`) carry substantial weight. Generic domain nouns (`security`, `authentication`, `permissions`, `architecture`, `migration`) are treated as weak, label-prone terms: they only contribute when the same user text also carries a task-oriented action word, so editing a label named `Authentication` or `Permissions`, or renaming `Architecture to System Design`, remains easy, while `fully audit the authentication and permissions implementation` and `plan a database migration` still route hard. Classification is deterministic and never serializes the whole request; it traverses structured `messages`, Responses-style `input`, and Anthropic-style `contents` while tolerating circular values and hostile getters/`toJSON()`.

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
AUTO-ROUTER combo=coder-auto level=hard target=coder-high score=7 reasons=tools-present,audit,concurrency
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

**Use `latest` for automatic validated updates.** It can change when a newly validated `decolua/9router:latest` digest is released even if this repository's source commit did not change. Production environments requiring explicit change control should use the canonical `sha-<full-40-character-commit>` tag documented below.

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

`latest` is the automatically maintained validated tracking release. The scheduled compatibility check may move it when a new upstream 9Router image passes this project's complete compatibility and validation suite.

```sh
docker compose pull
docker compose up -d
```

For production or reproducible deployments, pin the canonical immutable source identity: the full Git commit SHA tag.

```yaml
services:
  9router:
    image: ghcr.io/skulldorom/9router-auto-router:sha-<full-40-character-auto-router-commit>
```

`sha-<12-character-commit>` is a convenient short alias, not the canonical identity. Upstream-version variants are also published. Existing full and short SHA aliases are refused if they already identify a different source revision or upstream digest.

The GitHub Actions release workflow validates the exact `decolua/9router@sha256:...` base before building. It resolves `latest` once per publish attempt and passes that immutable digest through compatibility checking, Docker build, metadata, and validation. Before registry authentication or tagging, it observes upstream `latest` again and requires both the validated source revision and validated upstream digest to remain current. If upstream moved, it skips publication instead of rebuilding or publishing the stale artifact; the next scheduled or manual run validates the new digest from the beginning. CI intentionally resolves the current upstream image independently. Validation includes static checks, all tests, smoke/runtime/persistence checks, and a production HTTP-path test. A six-hour scheduled check rebuilds only if this source commit or the upstream digest changed; failed validation leaves the prior known-good `latest` untouched.

## Dependabot

Dependabot checks the only ordinary dependency ecosystems in this overlay: `npm` and GitHub Actions, weekly. Compatible minor and patch updates are grouped; major updates remain separate. It does not auto-merge. Docker is deliberately not included: `decolua/9router:latest` is resolved by the dedicated current-upstream digest-validation pipeline, tested at that exact immutable digest, and only then used to publish. A blind Docker digest bump would weaken that release gate. Dependabot pull requests run the same blocking current-upstream CI job.

## Development and advanced local builds

This project patches compiled Next.js assets. Upstream releases can require an overlay update; compatibility checks intentionally fail closed when semantic anchors, candidates, dispatches, UI structure, bindings, or patch integrity differ. The scheduled upstream validation detects incompatible releases before they replace the last-known-good production image. Do not make the patcher guess at a new compiled structure: review the upstream change, then update its guarded discovery and regression tests.

### Convenience/local build

```sh
docker build -t 9router-auto-router .
```

This intentionally uses the Dockerfile default, `decolua/9router:latest`. It is convenient for local work but is not reproducible over time.

### Reproducible build

Use an immutable upstream digest that passed compatibility checks. Production GitHub Actions already resolves, validates, and builds from this immutable-digest form.

```sh
npm run check && npm test
UPSTREAM_IMAGE=decolua/9router@sha256:<digest> ./scripts/check-upstream-compatibility.sh
docker build \
  --build-arg UPSTREAM_IMAGE="decolua/9router@sha256:<digest>" \
  --build-arg AUTO_ROUTER_REVISION="$(git rev-parse HEAD)" \
  --build-arg UPSTREAM_DIGEST=sha256:<digest> \
  --build-arg UPSTREAM_VERSION=<version> \
  -t 9router-auto-router .
./scripts/smoke-test.sh 9router-auto-router
./scripts/runtime-test.sh 9router-auto-router
```

Compatibility errors report the image, candidate count/files, expected semantic anchors, and failure reason without dumping minified source.

The compiled-runtime patcher discovers assets by semantic anchors and data-flow characteristics rather than fixed minified names where practical, but a few bindings must remain structurally strict. The runtime resolver alias is read from its own call site and captured before any later inner rebinding, so harmless minifier renaming is handled; the dispatch delegate is likewise reconstructed from the discovered `handleSingleModel` call. Fusion dispatch bindings are located by parsing the dispatch's object literal and walking enclosing brace scopes, matching the branch's own strategy, combo name, and models binding, so they are not constrained to a fixed byte window around the anchor; a required binding that is missing or matches ambiguously stops the build. UI candidate shape, the strategy selector anchor, and the exact persisted-binding positions are still matched by data flow.

No runtime dependencies are added. `package.json` version `0.1.0` is private-package metadata, not a production release identity; production images rely on immutable source/upstream tags and labels. Tests cover deterministic classification, realistic sanitized OpenHands fixtures, history reclassification, bounded keyword scoring, weak-domain false-positive regressions, modality weighting, one-route/no-fan-out selection, body/tools/stream preservation, ordinary-target delegation, explicit self/auto/stale target rejection, resolver-failure propagation that is not reported as a missing target and does not poison later requests, defense-in-depth recursion protection, per-field precedence, server/client UI semantic fixtures, labels, empty-self target filtering, semantic discovery, structural discovery beyond the former fixed byte windows with unrelated decoys, zero/multiple/ambiguous candidate failures, idempotence, compatibility checks, Docker build, smoke tests, runtime responses, authenticated `/api/settings` persistence across a restart, and a patched-container HTTP-path test. The HTTP test boots the patched container with a deterministic local OpenAI-compatible mock provider, sends easy and hard OpenAI-compatible requests through the normal `/api/v1/chat/completions` path, and proves the patched auto strategy selects exactly one normal target combo, preserves body/stream/tools into delegation, executes the selected combo through normal 9Router handling, and fails closed with a controlled error for missing targets, self-targets, and Auto Router → Auto Router targets.
