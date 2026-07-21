# Normalize Crawl4AI browser_config and crawler_config payload shapes

- **Status**: Draft
- **Task**: normalize-crawl4ai-config-payloads
- **Last Updated**: 2026-07-21
- **Document Scope**: One unit of work: make every Web Tools entry point emit one canonical, upstream-accepted Crawl4AI config envelope, honor caller-supplied config keys instead of silently dropping them, and stop emitting field shapes the pinned image rejects.

---

## Goal

### Problem

Web Tools sends two different, mutually incompatible config envelopes to the same Crawl4AI `crawl` tool depending on the entry point:

- `packages/toolkit/src/functions.ts` `web_fetch` sends the **wrapped** `{ type, params }` form.
- `packages/cli/src/commands/crawl.ts` builds a **flat** `crawler_config`, and `web_crawl` forwards it verbatim to `callCrawlTool`.
- `packages/toolkit/src/schemas.ts` `WebCrawlInput.crawler_config` publishes the **flat** form as the documented contract, while `browser_config` is `z.record(z.unknown())` so both forms validate.

Independently, `web_crawl` reads `params.browser_config.params` and therefore **silently discards** an unwrapped caller `browser_config`. Given `{"headless": false}` the caller gets no error and a browser configured from defaults instead.

### Confirmed upstream behavior (first scope item of the card)

This was confirmed **empirically**, not inferred. Method: the pinned `unclecode/crawl4ai:0.9.1` image was pulled and run locally, and the real MCP `crawl` tool was invoked over `/mcp/sse` — the same transport `packages/toolkit/src/crawl4ai.ts` uses — with each envelope in turn. The image's own server source (`/app/server.py`, `/app/api.py`, `/app/mcp_bridge.py`, `crawl4ai/async_configs.py`) was read to explain each result.

> Environment note: the repository's `services/crawl4ai/Dockerfile` build guard checks an amd64-only Playwright path (`chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell`) and therefore fails to build on arm64, where the same install lands at `chromium_headless_shell-*/chrome-linux/headless_shell`. The probe used an equivalent locally built image with that path corrected. This is a build-portability observation only; changing `services/crawl4ai/Dockerfile` is **out of scope** for this story.

**Result 1 — the card's hypothesis is refuted.** The flat envelope is **not** what Crawl4AI rejects. Flat and wrapped are accepted identically:

| Probe | Outgoing config | Result |
| --- | --- | --- |
| A | wrapped `browser_config` + wrapped `crawler_config` (today's `web_fetch` shape, no proxy) | accepted, `success: true` |
| B | flat `browser_config` + flat `crawler_config`, same fields | accepted, `success: true` |
| G | flat `crawler_config: {css_selector: "main"}` (CLI `--selector`) | accepted, `success: true` |
| H | flat `crawler_config: {screenshot: true}` (CLI `--screenshot`) | accepted, `success: true` |
| J | no `browser_config` and no `crawler_config` | accepted, `success: true` |
| L / M | unknown key `not_a_real_key` in the flat form / in the wrapped form | both accepted, both silently drop the key, byte-identical results |
| N | flat `crawler_config: { js_only: true, semaphore_count: 3, css_selector: "body" }` — two keys `WebCrawlInput` declares today | accepted, `success: true`, result byte-identical to probe L; both keys silently dropped |

Probe N's two keys are absent from `crawl4ai.async_configs.UNTRUSTED_FIELD_ALLOWLIST["CrawlerRunConfig"]` in the pinned image, which is why they are dropped rather than honored: `_filter_untrusted_fields` keeps only allowlisted keys and drops the rest silently. So `WebCrawlInput` currently publishes two keys that can never take effect, in addition to the forbidden ones in Result 2.

Upstream reason: `/app/server.py` and `/app/api.py` call `BrowserConfig.load(...)` / `CrawlerRunConfig.load(...)` with `provenance=Provenance.UNTRUSTED`. `crawl4ai.async_configs.from_serializable_dict` enters the typed-object branch **only** for a dict that has both a string `type` and a `params` key; anything else falls through to the raw-dict branch and is then passed to `from_kwargs`. Both paths apply the same untrusted filtering. So the envelope makes no difference to acceptance.

**Result 2 — what actually returns 400 is a forbidden-field allowlist, in either envelope.** `crawl4ai.async_configs._filter_untrusted_fields` raises `UntrustedConfigError` for a *forbidden* field and silently drops a merely *unknown* one; `server.py:884` and `api.py:803` map `UntrustedConfigError` to `HTTPException(400, ...)`, and `/app/mcp_bridge.py` re-raises the loopback status verbatim to the MCP caller. Observed responses:

| Probe | Outgoing config | Result |
| --- | --- | --- |
| C | wrapped `browser_config.params.proxy_config` (today's `web_fetch` shape whenever `Config.proxy` is set) | **400** `Rejected request: field 'proxy_config' is not permitted on BrowserConfig from an untrusted request` |
| D | flat `browser_config.proxy_config` | **400**, same message |
| E | wrapped `crawler_config.params.session_id` (today's `web_fetch` shape whenever a caller passes `session_id`) | **400** `Rejected config: field 'session_id' is not permitted on CrawlerRunConfig from an untrusted request` |
| F | flat `crawler_config: {magic: true}` (CLI `--magic`) | **400** `Rejected config: field 'magic' is not permitted on CrawlerRunConfig` |
| K | flat `crawler_config: {js_code: ...}` | **400** `Rejected config: field 'js_code' is not permitted on CrawlerRunConfig` |
| I | flat `browser_config: {headless: false}` | accepted (**not** 400); the crawl then fails with an upstream 500 because a headful browser cannot launch in the container |

The forbidden sets, read from `crawl4ai.async_configs.UNTRUSTED_FORBIDDEN_FIELDS` in the pinned image:

- `BrowserConfig`: `browser_context_id`, `cdp_url`, `channel`, `chrome_channel`, `cookies`, `debugging_port`, `extra_args`, `headers`, `host`, `init_scripts`, `proxy`, `proxy_config`, `storage_state`, `target_id`, `user_data_dir`
- `CrawlerRunConfig`: `base_url`, `c4a_script`, `deep_crawl_strategy`, `experimental`, `fallback_fetch_function`, `js_code`, `js_code_before_wait`, `magic`, `override_navigator`, `process_in_browser`, `proxy_config`, `proxy_rotation_strategy`, `proxy_session_auto_release`, `proxy_session_id`, `proxy_session_ttl`, `session_id`, `shared_data`, `simulate_user`

**Result 3 — a rejected request is currently invisible.** The MCP bridge returns the 400 as ordinary tool *content*, not as an MCP error: the tool result text is `{"error": 400, "detail": "{\"detail\":\"Rejected config: ...\"}"}` with no `isError` flag. `proxyCrawl4AI` therefore treats it as a successful crawl and hands the error JSON back as page content. Classifying upstream *responses* is story `classify-crawl-upstream-status` and stays out of scope here; this story's contribution is that Web Tools stops emitting the rejected request in the first place.

**Incident attribution.** Per the card and [`../issues/crawl4ai-400-burst-root-cause-unrecoverable.md`](../issues/crawl4ai-400-burst-root-cause-unrecoverable.md), this story does **not** close the 2026-07-18 incident. Result 2 identifies request shapes this repository can emit that the pinned image rejects with 400, but the retained logs carry no URL, validation detail, or correlation id, so no rejection can be attributed to any specific call. Attribution remains impossible and remains the province of `request-correlation-logging`.

### Change

1. Add one normalization helper in `packages/toolkit/src/crawl4ai.ts` and route **every** outgoing Crawl4AI call through it.
2. Accept either caller envelope (flat or wrapped) and always emit the canonical wrapped envelope.
3. Reject a forbidden field before the request leaves Web Tools, with an actionable error naming the field — never silently drop a caller key, never emit a shape the pinned image answers with 400.
4. Make `web_crawl` merge caller `browser_config` keys regardless of envelope.
5. Make `WebCrawlInput` and `WebFetchInput` describe only what the implementation and the pinned image actually accept.

### Non-goals

- Zod validation at the REST transport (`validate-tool-inputs-at-transport-boundary`).
- Structured logging, request ids, or an outgoing-argument shape summary (`request-correlation-logging`).
- Classifying upstream Crawl4AI error responses, including the 400-as-content case in Result 3 (`classify-crawl-upstream-status`).
- Any change to the Crawl4AI image, `services/crawl4ai/Dockerfile`, `docker-compose.yml`, or the deployment (`align-compose-stack-with-deployed-images`).
- Restoring per-request proxying or session reuse by any other mechanism. The pinned image forbids both from a network caller; re-enabling them is a Crawl4AI **service-level** configuration change and belongs to a separate story.
- Changing the CLI's flag surface. `--magic` keeps mapping to `crawler_config.magic` exactly as today.

## Design

### Canonical outgoing envelope

The canonical outgoing form is the **wrapped** one:

```jsonc
"browser_config": { "type": "BrowserConfig",    "params": { /* fields */ } }
"crawler_config": { "type": "CrawlerRunConfig", "params": { /* fields */ } }
```

Rationale: both forms are accepted (Result 1), so the choice is ours; the wrapped form is upstream's own `dump()`/`load()` serialization, it is the form the production-proven `web_fetch` path already emits, and it is unambiguous when a config legitimately carries a field named `type`.

The caller-facing form stays **flat**, which is what `WebCrawlInput` already publishes and what a REST or CLI caller naturally writes. The wrapped form remains accepted from callers for backward compatibility.

### The helper

Added to `packages/toolkit/src/crawl4ai.ts` (the card names this file, and it is the single choke point every Crawl4AI call already passes through):

- `normalizeCrawl4AIArgs(args)` — returns a new args object in which `browser_config` and `crawler_config`, when present, are canonicalized. Every other key passes through untouched.
- `unwrapCrawl4AIConfig(value, typeName)` — the shared unwrap primitive, exported so `web_crawl` can read caller-supplied fields without duplicating envelope detection.
- `Crawl4AIConfigError` — the typed error thrown for a forbidden field.

Envelope detection mirrors upstream exactly: a value is wrapped **iff** it is a plain object whose `type` is the string matching the expected class name (`BrowserConfig` / `CrawlerRunConfig`) and which has a `params` object. Everything else is treated as flat. This is the same predicate `from_serializable_dict` applies, so Web Tools and Crawl4AI can never disagree about which branch a payload takes.

Forbidden-field sets are encoded as a single named constant per config type, each carrying a comment citing the pinned image and `crawl4ai/async_configs.py: UNTRUSTED_FORBIDDEN_FIELDS` as the source, so a future image bump has one place to revisit.

`normalizeCrawl4AIArgs` is applied inside the shared `call(name, args)` function so `crawl`, `md`, `screenshot`, `pdf`, and `execute_js` are all covered. The last three carry no config keys today, so for them it is a pass-through.

### Consequences for existing behavior

- **Proxy.** `web_fetch` and `web_crawl` both inject `browser_config.params.proxy_config` whenever `Config.proxy` is set (`PROXY_SERVER` + `PROXY_USERNAME`) — `web_fetch` unconditionally, `web_crawl` through its `needProxy` merge. Probe C proves that request is rejected with 400 today, so both code paths are already non-functional wherever a proxy is configured. After this change both fail fast with an actionable error naming `proxy_config` and stating that the pinned image does not accept per-request proxy configuration. Silently dropping it instead is rejected as a design: it would send traffic from the datacenter IP and defeat the documented Cloudflare-bypass recipe without the operator knowing, and the card requires that no caller-supplied config key be discarded without an error. `PROXY_SERVER`/`PROXY_USERNAME` are optional and undocumented in `README.md` and `RAILWAY.md`, so the production deployment is unaffected.
- **`web_fetch` `session_id`.** Probe E proves every `web_fetch` call carrying `session_id` is rejected with 400 today. The parameter is undocumented in `README.md`, `docs/ARCHITECTURE.md`, and `docs/PRODUCT.md` and unused by the CLI. It is removed from `WebFetchInput` and no longer emitted, so the published contract stops advertising a parameter that cannot work. This is not an exception to "never silently drop a caller key": that rule governs keys inside a caller-supplied `browser_config` / `crawler_config`, where the caller is addressing Crawl4AI's config directly. `session_id` is a first-class `web_fetch` parameter that this story deletes from the published schema, so after this change there is no such caller key to drop — an MCP or CLI caller is told by the schema itself that the parameter does not exist. A `session_id` sent inside a `crawler_config` by a `web_crawl` caller is still rejected with an actionable error like any other forbidden field.
- **CLI `--magic`.** The flag-to-config mapping is unchanged per the card. The invocation is rejected with 400 today; after this change it returns an actionable Web Tools error naming `magic`. Removing or remapping the flag is left as a follow-up.

### Deviations from the card, and why

The card's first scope item commissioned an empirical check precisely so the rest of the card could be corrected by what it found. It found that two of the card's own statements cannot both hold against the pinned image. These deviations are deliberate and must be carried into the story-acceptance review rather than being quietly absorbed.

1. **Card acceptance criterion "The default stealth *and proxy* `browser_config` behavior is preserved when the caller supplies no `browser_config`" is only half satisfiable.** Preserving today's proxy behavior means emitting `browser_config.params.proxy_config`, which probe C proves the pinned image answers with 400. That directly contradicts the card's own Expected behavior clause, "No Web Tools code path can emit a config shape that Crawl4AI rejects with a 400." The stealth half is preserved exactly (`headless: true`, `enable_stealth: true`, unchanged). The proxy half is **not** preserved: a configured proxy now produces an actionable error instead of a request that upstream rejects. Restoring proxying requires configuring egress on the Crawl4AI **service** — the pinned image ships its own `egress_broker`/`egress_proxy` for exactly this — which the card puts out of scope ("Any change to the Crawl4AI image"). This needs a follow-up story; it cannot be resolved inside this unit.

2. **Card scope item "Keep the CLI's flag-to-config mapping working unchanged from the user's point of view" holds for every flag except `--magic`.** The mapping itself is untouched for all flags. But `magic` is on the pinned image's forbidden list (probe F), so `--magic` fails today and still fails after this change — the difference is that the failure becomes an explicit non-zero exit with a message naming the field, instead of today's apparent success carrying `{"error": 400, ...}` as page content (Result 3). Making a silently-wrong result into a loud correct one is the intended direction of the card, but it *is* a user-visible change to one flag and is recorded here as such. Removing or remapping `--magic` is out of scope and left as a follow-up.

### Coordination

- `request-correlation-logging` also edits `packages/toolkit/src/crawl4ai.ts` (`call`) and `packages/toolkit/src/functions.ts` (`proxyCrawl4AI`). Keep this unit's edits additive and confined to config normalization: do not touch `proxyCrawl4AI`, the `log` helper, or the transport/connection code. Whichever story lands second resolves a small additive conflict inside `call`.
- `health-liveness-readiness-split` and `align-compose-stack-with-deployed-images` are also in flight. Do not touch health endpoints, `docker-compose.yml`, or `services/`.
- The repository already has a test runner: Node's built-in `node:test`, `*.test.ts` beside the source compiled through `tsconfig.test.json` into `dist-test/`, run by each package's `test` script. The card's "introduce a test runner" scope item was satisfied by a sibling story that has since landed; **detect and reuse the existing runner, do not add one or add a test dependency.**

### Boundary

Production files this unit may change — all in `packages/toolkit`, which owns provider protocol per `packages/CLAUDE.md`:

- `packages/toolkit/src/crawl4ai.ts` — the helper, its exports, and its application inside `call`
- `packages/toolkit/src/functions.ts` — `web_fetch` and `web_crawl` config construction only
- `packages/toolkit/src/schemas.ts` — `WebCrawlInput`, `WebFetchInput`
- `packages/toolkit/src/index.ts` — only if a new export must be surfaced

Test files this unit may add:

- New `*.test.ts` beside the sources in `packages/toolkit/src/`
- New `*.test.ts` beside the sources in `packages/cli/src/`, **test-only**. One requirement below asserts that the CLI's flag-to-config mapping still reaches Crawl4AI in the accepted form, and that mapping lives in `packages/cli/src/commands/crawl.ts`. The test scope therefore extends to the package that owns the behavior; `packages/cli` already has a `test` script and an existing `packages/cli/src/search.test.ts` to follow. **No CLI production source may change** — the point of the test is to prove the existing mapping still works.

Dependency edit this unit may make, solely to make the CLI test runnable:

- `packages/cli/package.json` — add `@modelcontextprotocol/sdk` to `devDependencies` — plus the resulting `pnpm-lock.yaml` update. The CLI test needs the capture server described under Validation, and pnpm's isolated linking means the SDK is not resolvable from `packages/cli` today (it is a dependency of `@web-tools/toolkit` and `@web-tools/api`, not of `@web-tools/cli`). This is the protocol SDK the CLI's own call path already speaks through the toolkit, not a test framework, so it does not violate `packages/CLAUDE.md`'s "do not add a test framework dependency" rule. Pin it to the same `^1.12.1` range the other two packages use. Change nothing else in any `package.json`.

Out of bounds: any production file under `packages/api` or `packages/cli`, `services/`, `docker-compose.yml`, `docs/` beyond this spec (the writer owns the docs pass), any board card.

### Validation

Test infrastructure scope: `packages/toolkit` and `packages/cli` — between them they own every behavior asserted below, so every scenario runs in the package where its behavior lives. The CLI test exercises `registerCrawlCommand` directly (register it on a `commander` `Command` and `parseAsync` an argv), which drives the real flag mapping into the real `web_crawl`; it needs no CLI source change and no subprocess.

Two ordering constraints apply to **every** test file that uses the capture server, the CLI one included:

- `packages/toolkit/src/config.ts` parses the environment at import time, and the capture server's port is only known after it listens on `0`. So each such test file must start the server, set `process.env.CRAWL4AI_URL` (and any other env the scenario needs, such as `PROXY_SERVER`/`PROXY_USERNAME`), and only then reach the module under test through a top-level `await import(...)`. A static import of `registerCrawlCommand` — which transitively imports the toolkit and therefore `config.ts` — would freeze the default `CRAWL4AI_URL` and the scenario would fail or hang.
- The CLI `crawl` action calls `process.exit(1)` and writes to `console` on the error branch. The CLI test must therefore stub `process.exit` and `console` for the duration of the parse and restore them afterwards, so a failure surfaces as an assertion rather than killing the test process.

Automated, via `pnpm --filter @web-tools/toolkit test`:

- Direct unit tests of the exported helper for envelope, merge, and forbidden-field behavior.
- End-to-end capture of the **outgoing tool arguments**: stand up an in-process MCP server over SSE on an ephemeral port using `@modelcontextprotocol/sdk` (already a toolkit dependency), point `CRAWL4AI_URL` at it by setting `process.env.CRAWL4AI_URL` **before** importing the toolkit modules (`config.ts` parses the environment at import time, so use a top-level `await import(...)`), record the `crawl` tool arguments it receives, and assert against them. This captures the true wire payload with no production test seam. `node --test` runs each test file in its own process, so a scenario needing different environment (for example `PROXY_SERVER`/`PROXY_USERNAME`) belongs in its own test file.

Also required, and run before the unit is reported complete:

- `pnpm build` and `pnpm typecheck` from the repository root.
- `pnpm test` from the repository root (all three packages), to prove no adapter regressed.
- The live-instance check under "Requirement: The CLI's flag mapping keeps working end to end" below, against a locally run pinned Crawl4AI container.

## Requirements

### Requirement: One canonical outgoing envelope regardless of caller envelope

#### Scenario: Flat caller crawler_config is canonicalized

- **WHEN** `web_crawl` is called with `{ urls: ["https://example.com"], crawler_config: { css_selector: "main" } }`
- **THEN** the arguments captured at the MCP server contain `crawler_config` equal to `{ type: "CrawlerRunConfig", params: { css_selector: "main" } }`

#### Scenario: Wrapped caller crawler_config is passed through in canonical form

- **WHEN** `web_crawl` is called with `{ urls: ["https://example.com"], crawler_config: { type: "CrawlerRunConfig", params: { css_selector: "main" } } }`
- **THEN** the captured `crawler_config` is byte-identical to the one captured for the flat call in the previous scenario

#### Scenario: A flat config carrying a field named type is not mistaken for a wrapper

- **WHEN** `normalizeCrawl4AIArgs` is given `crawler_config: { type: "CrawlerRunConfig" }` with no `params` key
- **THEN** the result is `{ type: "CrawlerRunConfig", params: { type: "CrawlerRunConfig" } }`, matching upstream's own wrapped-detection predicate, which requires both `type` and `params`

#### Scenario: Absent configs are not invented

- **WHEN** `web_crawl` is called with `{ urls: ["https://example.com"] }` and no `crawler_config`
- **THEN** the captured arguments contain no `crawler_config` key

### Requirement: web_fetch and web_crawl emit identical envelopes for equivalent input

#### Scenario: Identical browser_config for default input

- **WHEN** `web_fetch({ url: "https://example.com" })` and `web_crawl({ urls: ["https://example.com"] })` are each called with no proxy configured
- **THEN** the `browser_config` captured for both is byte-identical, namely `{ type: "BrowserConfig", params: { headless: true, enable_stealth: true } }`

#### Scenario: Identical crawler_config for equivalent input

- **WHEN** `web_fetch({ url: "https://example.com" })` is called, and `web_crawl` is called with the crawler fields `web_fetch` applies by default (`wait_until: "load"`, `page_timeout: 120000`, `delay_before_return_html: 15`) supplied flat
- **THEN** the `crawler_config` captured for both is byte-identical

### Requirement: No caller-supplied browser_config key is silently discarded

#### Scenario: Unwrapped caller key is honored

- **WHEN** `web_crawl` is called with `{ urls: ["https://example.com"], browser_config: { headless: false } }`
- **THEN** the captured `browser_config.params.headless` is `false`

#### Scenario: Wrapped caller key is honored

- **WHEN** `web_crawl` is called with `{ urls: ["https://example.com"], browser_config: { type: "BrowserConfig", params: { headless: false } } }`
- **THEN** the captured `browser_config` is byte-identical to the one captured for the unwrapped call in the previous scenario

#### Scenario: Caller keys merge with defaults rather than replacing them

- **WHEN** `web_crawl` is called with `{ urls: ["https://example.com"], browser_config: { viewport_width: 1920 } }`
- **THEN** the captured `browser_config.params` contains `viewport_width: 1920` **and** the defaults `headless: true` and `enable_stealth: true`

#### Scenario: Default stealth behavior is preserved when no browser_config is supplied

- **WHEN** `web_crawl` is called with `{ urls: ["https://example.com"] }` and no proxy configured
- **THEN** the captured `browser_config` is `{ type: "BrowserConfig", params: { headless: true, enable_stealth: true } }`

> The card's matching acceptance criterion also names default *proxy* behavior. Per Deviation 1 above, that half is deliberately not preserved; the fail-fast behavior that replaces it is asserted by the two proxy scenarios below.

### Requirement: No request carrying a field the pinned image forbids is sent

#### Scenario: A forbidden crawler field is rejected before the request is sent

- **WHEN** `web_crawl` is called with `{ urls: ["https://example.com"], crawler_config: { magic: true } }`
- **THEN** the tool result has `isError: true`, its text names `magic` and states that the pinned Crawl4AI image does not permit the field from an untrusted request, and the MCP server records **no** `crawl` invocation

#### Scenario: A forbidden browser field is rejected before the request is sent

- **WHEN** `web_crawl` is called with `{ urls: ["https://example.com"], browser_config: { cdp_url: "http://127.0.0.1:9222" } }`
- **THEN** the tool result has `isError: true`, its text names `cdp_url`, and the MCP server records no `crawl` invocation

#### Scenario: A configured proxy fails fast on the web_fetch path

- **WHEN** `PROXY_SERVER` and `PROXY_USERNAME` are set and `web_fetch({ url: "https://example.com" })` is called
- **THEN** the tool result has `isError: true`, its text names `proxy_config` and states that the pinned image does not accept per-request proxy configuration, and the MCP server records no `crawl` invocation

#### Scenario: A configured proxy fails fast on the web_crawl path

- **WHEN** `PROXY_SERVER` and `PROXY_USERNAME` are set and `web_crawl({ urls: ["https://example.com"] })` is called with no caller `browser_config`, so `web_crawl`'s own default-proxy merge is the source of the field
- **THEN** the tool result has `isError: true`, its text names `proxy_config`, and the MCP server records no `crawl` invocation — the proxy is neither sent nor silently dropped

#### Scenario: An unknown but non-forbidden key is forwarded unchanged

- **WHEN** `web_crawl` is called with `{ urls: ["https://example.com"], crawler_config: { css_selector: "main", not_a_real_key: 1 } }`
- **THEN** the request is sent and the captured `crawler_config.params` contains both keys, because upstream silently drops unknown keys in either envelope (probes L and M) and Web Tools must not invent a stricter contract than the provider's

### Requirement: The published schema describes only what is actually accepted

#### Scenario: WebCrawlInput no longer documents forbidden or dropped keys

- **WHEN** `WebCrawlInput.crawler_config` is inspected
- **THEN** it declares no key in the pinned image's `CrawlerRunConfig` forbidden set (`js_code`, `magic`, `override_navigator`, `session_id`, `simulate_user` — Result 2, probes E/F/K) and none of the keys upstream silently drops because they are absent from `UNTRUSTED_FIELD_ALLOWLIST` (`js_only`, `semaphore_count` — probe N)

#### Scenario: WebCrawlInput documents the flat shape at the nesting level the implementation accepts

- **WHEN** a caller sends a `crawler_config` built strictly from the keys `WebCrawlInput` declares, at the top level as declared
- **THEN** the call is normalized and sent, and no declared key is rejected or dropped by Web Tools

#### Scenario: WebFetchInput no longer publishes session_id

- **WHEN** `WebFetchInput` is inspected
- **THEN** it declares no `session_id` parameter, and a `session_id` value passed to `web_fetch` is not emitted in the outgoing `crawler_config`

### Requirement: The CLI's flag mapping keeps working end to end

#### Scenario: CLI screenshot flag reaches Crawl4AI in the accepted form

- **WHEN** `registerCrawlCommand` from `packages/cli/src/commands/crawl.ts` is registered on a `commander` `Command` in a `packages/cli/src/*.test.ts` and parsed with argv `["crawl", "--screenshot", "https://example.com"]`, against a toolkit pointed at the in-process capture server
- **THEN** the captured `crawler_config` is `{ type: "CrawlerRunConfig", params: { screenshot: true } }`, with no change to `packages/cli/src/commands/crawl.ts`

#### Scenario: CLI selector and timeout flags reach Crawl4AI in the accepted form

- **WHEN** the same command is parsed with argv `["crawl", "--selector", "main", "--timeout", "30000", "https://example.com"]`
- **THEN** the captured `crawler_config` is `{ type: "CrawlerRunConfig", params: { css_selector: "main", page_timeout: 30000 } }`

#### Scenario: CLI screenshot crawl succeeds against a live Crawl4AI instance

- **WHEN** a pinned `unclecode/crawl4ai:0.9.1` instance is running locally, `CRAWL4AI_URL` (and `CRAWL4AI_API_TOKEN` if the instance requires one) point at it, and `web-tools crawl --screenshot https://example.com` is run from the built CLI
- **THEN** the command exits 0 with extracted content, and `docker logs` for the container contains zero `POST http://127.0.0.1:11235/crawl "HTTP/1.1 400 Bad Request"` lines emitted during the run

## Tasks

- [ ] Read this spec's confirmed-upstream-behavior section; it is the authority for which shapes are accepted. Do not re-derive it.
- [ ] Add `Crawl4AIConfigError`, the two forbidden-field constants (each citing `unclecode/crawl4ai:0.9.1` / `crawl4ai/async_configs.py: UNTRUSTED_FORBIDDEN_FIELDS`), `unwrapCrawl4AIConfig`, and `normalizeCrawl4AIArgs` to `packages/toolkit/src/crawl4ai.ts`.
- [ ] Apply `normalizeCrawl4AIArgs` inside the shared `call(name, args)` so every Crawl4AI tool call is routed through it. Keep the edit additive and away from the transport and connection code.
- [ ] Rework `web_crawl` in `packages/toolkit/src/functions.ts` to read caller `browser_config` fields through `unwrapCrawl4AIConfig` and merge them over the stealth/proxy defaults, so no caller key is dropped in either envelope.
- [ ] Make `web_fetch` build its config from the same defaults so the two entry points emit byte-identical envelopes for equivalent input; stop emitting `session_id`.
- [ ] Surface the config rejection as an `isError` tool result with an actionable message naming the offending field, on both the `web_fetch` and `web_crawl` paths.
- [ ] Update `WebCrawlInput` and `WebFetchInput` in `packages/toolkit/src/schemas.ts` per the schema requirement above.
- [ ] Add `*.test.ts` beside the sources covering every scenario, using the existing `node:test` runner and the in-process MCP SSE capture server described under Validation. Put the two proxy scenarios in their own test file so it can set its own environment.
- [ ] Add the CLI flag-mapping test as a new `packages/cli/src/*.test.ts` driving `registerCrawlCommand`, without changing any CLI production source.
- [ ] Run `pnpm build`, `pnpm typecheck`, and `pnpm test` from the repository root.
- [ ] Run the live-instance check: build a local pinned Crawl4AI image, run it, point `CRAWL4AI_URL` at it, run `web-tools crawl --screenshot https://example.com`, and confirm zero `400 Bad Request` lines in the container log for the run.
