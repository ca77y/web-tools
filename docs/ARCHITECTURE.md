# Web Tools Architecture

## Overview

Web Tools is a pnpm TypeScript monorepo backed by three external runtime dependencies. Its core design rule is that tool behavior belongs to the framework-agnostic toolkit, while MCP, REST, and CLI are adapters over that behavior.

```mermaid
flowchart LR
    MCP[MCP client] -->|POST /mcp| API[Web Tools API]
    REST[REST client] -->|POST /api/v0/tool| API
    CLI[Web Tools CLI] --> Toolkit[Toolkit]
    API --> Toolkit
    Toolkit --> Search[SearXNG]
    Search --> Redis[(Redis)]
    Toolkit --> Crawl[Crawl4AI]
    Toolkit --> Archive[Wayback Machine]
```

The deployed stack has four owned services: Web Tools, Crawl4AI, SearXNG, and Redis. Wayback Machine is an external upstream, not an owned deployment service.

## Package Boundaries

### `packages/toolkit`

The toolkit owns the public tool model and all provider-facing behavior:

- Zod input schemas
- Tool names, descriptions, and MCP annotations
- The `toolsByName` registry
- Tool implementation functions
- SearXNG, Crawl4AI, and Wayback clients
- Normalized output types
- Process-local call, bandwidth, and estimated-cost counters
- Environment-derived provider configuration
- The shared structured logger and the request-correlation context, re-exported for the transport adapters

No toolkit function depends on Express or Commander. Provider protocol changes should be absorbed here without requiring transport-specific fixes.

### `packages/api`

The API package adapts HTTP requests to toolkit calls:

- Express application and JSON parsing
- Request-correlation and inbound request logging middleware, mounted after JSON parsing and before authentication
- API-key middleware
- Stateless Streamable HTTP MCP handling at `POST /mcp`
- REST discovery at `GET /api/v0`
- REST execution at `POST /api/v0/{tool_name}`
- Unauthenticated liveness response at `GET /health`
- Authenticated dependency readiness report at `GET /ready`
- Authenticated process-local statistics at `GET /stats`
- Transport-level status and error serialization

MCP and REST route through the same toolkit function map. The API package must not add separate provider behavior.

### `packages/cli`

The CLI package maps Commander commands and flags to toolkit inputs. It executes the toolkit in-process and does not call the REST API. This keeps local use independent of the API transport while preserving the same schemas and implementations.

## Runtime Services

### Web Tools

The Node.js 24 application hosts MCP and REST. It is stateless except for process-local usage counters. A restart creates a new statistics epoch identified by `started_at`.

### Crawl4AI

Crawl4AI owns browser-grade retrieval, rendering, extraction, screenshots, PDF generation, and JavaScript execution. Its protocol and result classification are encapsulated by the toolkit client. Web Tools reaches it over MCP/SSE and never calls its REST API directly; the image's own MCP-to-REST bridge performs that translation inside the container, so a loopback rejection surfaces to us as a bridge response rather than as a transport error. The repository owns the image it runs; see [Service Image Provenance](#service-image-provenance).

#### Crawl4AI Config Contract

`browser_config` and `crawler_config` are the two configuration payloads sent with every Crawl4AI call. The rules below are properties of the pinned `unclecode/crawl4ai:0.9.1` image, not Web Tools choices. They were established empirically — the image was run locally and its real MCP `crawl` tool invoked with each shape in turn — and cross-checked against the image's own `crawl4ai/async_configs.py`. Re-check them whenever the pinned image is bumped. Reproducing that check on arm64 currently needs a locally corrected image: `services/crawl4ai/Dockerfile`'s build guard checks an amd64-only Playwright path (`chromium_headless_shell-*/chrome-headless-shell-linux64/chrome-headless-shell`), while the same install lands at `chromium_headless_shell-*/chrome-linux/headless_shell` on arm64.

**The envelope does not affect acceptance.** A config may be sent flat (`{"css_selector": "main"}`) or wrapped as `{"type": "CrawlerRunConfig", "params": {...}}`. The image accepts both identically, so the envelope was never a cause of `HTTP 400`. Web Tools nevertheless emits exactly one canonical form — the wrapped `{type, params}` envelope, which is upstream's own `dump()`/`load()` serialization and is unambiguous when a config legitimately carries a field named `type`. A single normalization helper in `packages/toolkit/src/crawl4ai.ts`, applied inside the shared `call()`, canonicalizes every outgoing payload, so MCP, REST, and the CLI produce byte-identical arguments for equivalent input. Callers may still supply either envelope; wrapped detection mirrors upstream's `from_serializable_dict` predicate exactly — a value is wrapped only when it is an object carrying both a `type` equal to the config class name and a `params` object.

**What actually produces `HTTP 400` is untrusted-provenance field filtering.** A config arriving in a network request body is `Provenance.UNTRUSTED`. The image's `_filter_untrusted_fields` then treats fields in three ways: allowlisted fields are honored, unknown fields are **silently dropped** (the crawl succeeds, configured differently from what was asked), and *forbidden* fields raise `UntrustedConfigError`, which the server maps to `HTTP 400`.

The forbidden sets are:

- `BrowserConfig` — `browser_context_id`, `cdp_url`, `channel`, `chrome_channel`, `cookies`, `debugging_port`, `extra_args`, `headers`, `host`, `init_scripts`, `proxy`, `proxy_config`, `storage_state`, `target_id`, `user_data_dir`
- `CrawlerRunConfig` — `base_url`, `c4a_script`, `deep_crawl_strategy`, `experimental`, `fallback_fetch_function`, `js_code`, `js_code_before_wait`, `magic`, `override_navigator`, `process_in_browser`, `proxy_config`, `proxy_rotation_strategy`, `proxy_session_auto_release`, `proxy_session_id`, `proxy_session_ttl`, `session_id`, `shared_data`, `simulate_user`

Web Tools mirrors both sets as named constants beside the normalizer and rejects a forbidden field — or a `browser_config`/`crawler_config` that is present but is not an object — with `Crawl4AIConfigError` before any request leaves the process. The caller gets an actionable error naming the field instead of a rejection the bridge returns as ordinary tool content. Caller-supplied keys are merged over the stealth defaults rather than discarded, in either envelope. Unknown-but-permitted keys are forwarded unchanged; Web Tools does not invent a stricter contract than the provider's.

The published schemas describe only what the image honors: `WebFetchInput` no longer carries `session_id`, and `WebCrawlInput.crawler_config` no longer declares `js_code`, `js_only`, `magic`, `override_navigator`, `semaphore_count`, `session_id`, or `simulate_user` — each is either forbidden or outside the allowlist and therefore silently dropped.

**Operator consequence: per-request proxy configuration is not possible against this image.** `proxy_config` and `proxy` are forbidden on `BrowserConfig`, so a deployment that sets `PROXY_SERVER` and `PROXY_USERNAME` now fails fast with an actionable error rather than emitting a request the image rejects. Proxied egress must instead be configured on the Crawl4AI service itself, which is consistent with the tunnel ownership described in [`issues/proxy-exit-ip-health-unverifiable.md`](./issues/proxy-exit-ip-health-unverifiable.md): the CONNECT tunnel belongs to the Chromium process inside the Crawl4AI container, not to Web Tools. Session reuse (`session_id`) is unavailable for the same reason.

#### Crawl4AI MCP Client Lifecycle

The shared MCP client (`packages/toolkit/src/crawl4ai.ts`) is a module-level singleton reused across every `web_fetch`, `web_crawl`, `web_screenshot`, `web_pdf`, `web_execute_js`, and `web_archive` call. Its `call()` function draws a hard line between two failure classes, and treats them differently on purpose:

- **A connection-level failure** — `getClient()` itself fails to produce a connected client (a refused connect, a stalled or protocol-rejected `initialize` handshake, or anything else that keeps the connect step from finishing) — is retried **once** with a guaranteed-fresh connect attempt, then surfaces. `getClient()` never leaves a rejected attempt half-cleaned-up: whatever transport it built is closed and `client`/`connecting`/`activeTransport` are cleared before the rejection reaches any caller, so a retry (or a later, unrelated call) always starts a genuinely new attempt rather than replaying a permanently-rejected `connecting` promise.
- **An operation-level failure** — the `callTool` request itself rejects once a connection is established (a protocol error, an `ErrorCode.RequestTimeout`, or a transport-level `send()` failure) — is surfaced directly, with **no retry and no discard of the shared client**. The connection may still be healthy and serving other concurrent callers: the MCP SDK rejects every in-flight request on a client when its transport closes, so tearing down the shared client over one call's failure would abort every other tool call sharing it. This is also what stops a connection leak: previously, every operation-level failure discarded the shared client without closing it, forcing a needless reconnect (and orphaning the abandoned transport) on the very next call; now a healthy connection survives an operation-level failure and no reconnect happens at all.

**Timeout.** Every `callTool` call passes an explicit `timeout` (`Config.crawl4ai.callTimeoutMs`, configurable via `CRAWL4AI_CALL_TIMEOUT_MS`, default 150,000ms) instead of relying on the MCP SDK's 60-second default. The default is deliberately set above the toolkit's own largest crawl budget — `web_fetch`'s default recipe of `page_timeout: 120,000` plus `delay_before_return_html: 15` (15,000ms) — so a legitimately slow-but-successful crawl is not cut off client-side before Crawl4AI itself can finish. `RequestOptions.timeout` is a sibling field to the SDK's own `RequestOptions.signal`, so a future `AbortSignal` (owned by a sibling story) can be threaded through alongside it with no shape change.

**Retry scope, and why it cannot compound with a crawl-level retry.** The bounded connect retry above is the *only* retry this client performs, and it never re-invokes `callTool` — a connection-level failure retries the connect step and then calls the tool once; an operation-level failure (including a timeout) is not retried at all. A tool call therefore runs at most once per `call()` invocation regardless of how the connect step behaved. A future crawl-semantics retry (navigation timeout, HTTP 429, HTTP 503 — a separate concern layered on top of the tool call itself) therefore adds to this client's own retry count rather than multiplying with it: worst case is (1 + that retry's own count) tool invocations, each preceded by at most one extra connect attempt.

### SearXNG

SearXNG owns metasearch aggregation. Web Tools normalizes useful search fields and distinguishes valid no-result responses from upstream failure; the mechanism is documented under [Search Failure Classification](#search-failure-classification).

### Redis

Redis supports the SearXNG service. Web Tools does not expose Redis as a public dependency or tool.

### Wayback Machine

The toolkit calls external CDX and archive endpoints for snapshot discovery and archived content. Upstream availability and rate limits are outside the owned service boundary.

## Authoritative Contracts

`packages/toolkit/src/tools.ts` is the authoritative registry of tool names, descriptions, intended input schemas, and MCP annotations. `packages/toolkit/src/functions.ts` maps registered names to implementations. MCP registers the Zod schema shapes with the SDK; REST and CLI currently pass inputs directly to toolkit functions without parsing those schemas. Closing that validation gap is part of Phase 2 in [`PRODUCT.md`](./PRODUCT.md).

When changing a tool:

1. Change or add its Zod schema.
2. Change the toolkit implementation and normalized result type.
3. Update the registry definition and function map.
4. Adapt CLI flags if the tool is available there.
5. Verify MCP and REST expose the same contract.
6. Update user-facing and durable feature documentation.

New transport work must not broaden the registry contract. Existing REST and CLI validation behavior is known debt, not a second authoritative contract.

## Request Flows

### MCP

```mermaid
sequenceDiagram
    participant Client as MCP client
    participant API as Express API
    participant MCP as MCP server/transport
    participant Toolkit as Toolkit
    participant Provider as Upstream provider

    Client->>API: POST /mcp + Bearer key
    API->>API: Authenticate request
    API->>MCP: Handle JSON-RPC request
    MCP->>Toolkit: Validate and execute tool
    Toolkit->>Provider: Provider request
    Provider-->>Toolkit: Provider response or failure
    Toolkit-->>MCP: Normalized result or actionable error
    MCP-->>Client: JSON-RPC response
```

The API creates a stateless MCP server and transport per request, then closes both when the response closes.

### REST

```mermaid
sequenceDiagram
    participant Client as REST client
    participant API as Express API
    participant Handler as Tool handler
    participant Toolkit as Toolkit

    Client->>API: POST /api/v0/{tool} + Bearer key
    API->>API: Authenticate request
    API->>Handler: Route registered tool
    Handler->>Toolkit: Execute request body
    Toolkit-->>Handler: Result or error
    Handler-->>Client: JSON response
```

REST routes are generated from the toolkit registry, reducing the chance that a registered tool exists in one HTTP interface but not the other.

REST currently does not parse request bodies with the registered Zod schemas before execution. Toolkit functions perform uneven defensive checks, so invalid-input behavior can differ from MCP until Phase 2 validation work is complete.

### CLI

```mermaid
sequenceDiagram
    participant User
    participant CLI as Commander CLI
    participant Toolkit
    participant Provider

    User->>CLI: web-tools command flags
    CLI->>Toolkit: Construct and execute input
    Toolkit->>Provider: Provider request
    Provider-->>Toolkit: Response or failure
    Toolkit-->>CLI: Normalized result
    CLI-->>User: Terminal output
```

## Authentication And Trust

The API reads a bearer token from `Authorization` or an `api_key` query parameter and compares it with the configured key using fixed-length SHA-256 digests and `timingSafeEqual`. `/health` bypasses authentication. MCP, REST discovery, REST tool execution, `/ready`, and `/stats` require authentication. `/ready` is authenticated because it exposes internal topology and dependency failure detail; it follows `/stats`, not `/health`.

The API key protects access to the service; it does not make arbitrary target URLs trustworthy. URLs, scripts, crawler configuration, and upstream responses remain untrusted input and must be validated or constrained at their boundary.

Do not log API keys, full secrets, or sensitive target content. Preserve upstream status and diagnostic context only when safe to return. The safe-value rules that enforce this are documented under [Structured Logging And Request Correlation](#structured-logging-and-request-correlation); they are applied centrally in the log writer rather than at each call site, so a new field cannot opt out of redaction by omission.

### Request correlation identity

Callers may supply an `X-Request-Id` request header on any HTTP request. The API adopts it when present and otherwise mints a UUID, then carries it through the toolkit for the lifetime of the request so every record emitted for that request shares one `requestId`.

An inbound `X-Request-Id` is untrusted caller input. It is capped at 200 characters and stripped of everything outside `[A-Za-z0-9._:-]`; if nothing survives, a fresh ID is minted. Newlines therefore cannot survive adoption, so a hostile header can neither forge a log line nor grow log volume without bound.

## Failure Model

Failures can originate in five layers:

- Input validation
- HTTP or MCP transport
- Toolkit orchestration
- Owned provider services
- External websites or Wayback Machine

Each layer should preserve enough context for the caller to distinguish failure from a legitimate empty result. The toolkit should normalize provider errors, while transports should preserve appropriate protocol status instead of returning successful empty payloads.

Retries must be bounded and limited to operations known to be safe. Cancellation and timeout signals should propagate through the toolkit to provider clients where supported.

### Structured Logging And Request Correlation

One shared logger in `packages/toolkit/src/logging.ts` serves the toolkit and both transport adapters. There is no second logging path: `packages/api` and `packages/cli` import it rather than writing their own. Every record is a single line of JSON written to **stderr** only, so CLI stdout stays machine-parseable.

#### Record kinds

A top-level `kind` field discriminates exactly two record types, and `kind` carries no other meaning anywhere in the repository:

- `kind: "event"` — diagnostic or lifecycle records with no measurable outcome: process startup and shutdown, transport errors, and pre-dispatch summaries.
- `kind: "operation"` — anything with a measurable outcome. Every operation record carries `requestId`, `operation`, `outcome`, and `durationMs`. `outcome` is exactly one of `ok`, `empty`, or `error`; there is no `failed` token in the log vocabulary.

Not every operation record uses all three outcome values. `tool_call` (the wrapper around each public tool), `crawl4ai_dispatch`, and `http_request` derive their outcome from whether the result carries an error, so they report only `ok` or `error`. `empty` is reported by the records that can actually distinguish it: `crawl4ai_call` for an upstream reply with no extractable text, and `searxng_attempt_outcome` and `search_complete` for a genuine no-match.

All records also carry `ts`, `event`, and `level` (`info`, `warn`, or `error`; an operation record's level follows its `outcome`).

```json
{"ts":"2026-07-21T10:00:00.000Z","event":"crawl4ai_call","operation":"crawl4ai.crawl","outcome":"error","durationMs":31204,"targetUrl":"https://example.com/a/b","requestId":"3f2a…","kind":"operation","level":"error"}
```

#### Correlation

The correlation ID is carried ambiently through `node:async_hooks` `AsyncLocalStorage`, not as a parameter, so no public tool signature exposes it. The API middleware adopts or mints the ID (see [Request correlation identity](#request-correlation-identity)) and runs the rest of the request inside that context.

Context-free callers — the CLI and direct toolkit use — get a context per operation instead: all nine public tool functions route through one `runOperation()` wrapper that joins the ambient context if one exists, mints one otherwise, times the call, and emits the `tool_call` operation record. Concentrating it there is what makes "every operation record carries a `requestId`" true on every path rather than only the HTTP one. The wrapper never alters a tool's return value or its thrown error: a throw is recorded as `outcome: "error"` and rethrown unchanged.

#### Safe values

Redaction is enforced in the writer, applied to every field of every record including nested ones, so no call site can opt out by omission:

- **URL redaction** — any URL-shaped substring in any string field is reduced to scheme, host, and path. Userinfo, query string, and fragment are dropped.
- **Target URLs** — logged as scheme + host + path only (path truncated to 200 characters), alongside a boolean recording whether a query string was present and a `targetUrlCount`. A value that does not parse as a URL is reported as `(unparseable)` rather than echoed. A multi-URL `web_crawl` logs its first target plus the count; per-URL attribution inside one crawl is not provided.
- **Bounds** — string values are truncated to 500 characters with an explicit truncation marker, arrays are capped at 25 items, and recursion into nested values stops at depth 4.
- **Crawl4AI argument shape** — before dispatch, a values-free `crawl4ai_request_shape` record maps each **top-level** argument key to a type token (`string`, `number`, `boolean`, `null`, `object`, or `array[N]`). Nesting is never descended, which is what structurally prevents proxy credentials (nested under `browser_config`) and script bodies from leaking. Emitting it *before* dispatch is deliberate: an upstream that rejects a request without telling us anything can only be diagnosed if our own record already exists.

Never logged: API keys, the `api_key` query value, the `Authorization` header value, proxy credentials, script bodies, request or response bodies, and target-URL query strings. The API request middleware logs `req.path` and never `req.originalUrl`, `req.url`, `req.query`, or `req.headers` wholesale — `originalUrl` can itself carry the `api_key` query parameter.

#### Log volume

Successful calls now log where they previously did not: one record per inbound API request, one `tool_call` per tool operation, and one per SearXNG attempt plus one `search_complete` summary. A Crawl4AI-backed call adds two records at the dispatch layer (`crawl4ai_request_shape` before dispatch and `crawl4ai_dispatch` after), plus a third `crawl4ai_call` record carrying the target-URL context for the five tools that route through the proxy wrapper — `web_archive` reaches Crawl4AI directly and so gets the two dispatch-layer records only. All values are bounded by the truncation rules above. There is no log level filter, sampling, or `LOG_LEVEL` knob.

### Search Failure Classification

The SearXNG client is the implemented reference for [`PRODUCT.md`](./PRODUCT.md) principle 2. `web_search` issues `Config.parallelRequests` parallel attempts, and each attempt resolves to one of three outcomes rather than to a nullable result:

- `ok` — HTTP 2xx, well-formed JSON, at least one result carrying both a title and a URL. Also records whether any result has content.
- `empty` — HTTP 2xx, well-formed JSON, zero usable results, and no total engine failure reported. This is a legitimate no-match.
- `failed` — the attempt did not produce a trustworthy answer. Carries a structured `reason` whose `cause` is one of `http_status` (with the upstream status code), `invalid_response` (unparseable body or unexpected JSON shape), `timeout` (an `AbortSignal.timeout` abort, classified on the `TimeoutError` name rather than message text), `network_error`, or `all_engines_unresponsive`.

Aggregation preserves the pre-existing selection behavior — the first content-bearing `ok` attempt wins and short-circuits, otherwise the first `ok` attempt with any results is used, then dedup-by-URL and `limit` truncation apply. When no attempt is `ok`:

- at least one `empty` attempt means the query genuinely matched nothing, so the tool succeeds with an empty array;
- every attempt `failed` means the search provider is unavailable, so the toolkit throws `SearchProviderError` (exported from the toolkit entry point) carrying an actionable message that names the failed operation and summarizes the distinct causes with counts, plus the per-attempt safe reasons on a structured `reasons` property.

An unexpected promise rejection inside the parallel race maps to a `failed` outcome, never to a non-failure, so a throw can never be counted as an empty success.

#### Engine-level outage detection

SearXNG's JSON response exposes `unresponsive_engines` but carries no field enumerating the full engine roster that ran. Classification therefore differs by request shape:

- an explicit engine list was requested — the attempt is `failed` only when **every** requested engine appears in `unresponsive_engines`; a partial engine failure with zero results stays `empty`;
- no explicit engine list was requested — **any** non-empty `unresponsive_engines` alongside zero results is `failed`.

The second rule is a deliberate trade-off. `SEARXNG_ENGINES` is blank in the default deployment and the `engines` argument is optional, so the "every requested engine" rule would be unreachable in exactly the configuration where outages occur. Zero results means no engine produced positive evidence the search worked, while a non-empty `unresponsive_engines` is concrete evidence something broke, and principle 2 makes a failure disguised as an empty success the more damaging error. The accepted cost is that an ambiguous no-match with one unresponsive engine is reported as a failure. `unresponsive_engines` is parsed defensively; a missing or malformed field is treated as "not reported" and never turns a genuine `empty` into a `failed`.

#### Reporting and observability

Each attempt emits exactly one record under the stable event name `searxng_attempt_outcome`, following the repository-wide contract in [Structured Logging And Request Correlation](#structured-logging-and-request-correlation). It carries `requestId`, a per-invocation `searchId`, the `attempt` number, the `query`, the SearXNG `baseUrl`, the upstream `status` where one exists, `durationMs`, and either the safe failure reason or result counts. The attempt classification is reported in the uniform `outcome` field as `ok`, `empty`, or `error` — the internal `failed` classification above is code, not a log contract, and maps to `error` at emit time. A timeout omits `status` rather than inventing one.

The `searchId` is what makes the parallel fan-out readable. `web_search` issues `Config.parallelRequests` simultaneous identical attempts, so without it three interleaved lines from one search are indistinguishable from three sequential retries, and lines from two concurrent searches interleave with nothing to separate them. Attempts of one search share a `searchId` and carry distinct `attempt` values; attempts of two concurrent searches carry distinct `searchId` values even under one `requestId`.

One `search_complete` record is emitted per `searchSearXNG` call, carrying the outcome the caller actually received, the winning attempt where one exists, `resultCount`, and `failedAttempts` — so an operator reading a failed attempt line can immediately tell whether the caller was still served.

Neither logs nor error messages contain API keys, secrets, or raw upstream response bodies.

A total search failure is recorded in the process-local counters as an errored call, so outages stay visible at `GET /stats` and through `web_usage_stats` instead of being indistinguishable from successful zero-result searches.

Transports surface the thrown error without adding search-specific behavior: MCP returns `isError: true` with the message in its `error` payload, REST returns HTTP 500 with an `error` field, and the CLI prints the error and exits non-zero rather than printing `No results found.`. The success-path shape of `web_search` is unchanged.

## Health And Statistics

Liveness and dependency readiness are two separate endpoints, deliberately. Neither signal can break the other.

### `GET /health` — liveness

`GET /health` is unauthenticated, performs **no network I/O**, and returns HTTP 200 with the body `{"status":"ok"}` whenever the process is alive — including when every dependency is unreachable.

It proves exactly one thing: the API process can accept a connection and answer an HTTP request. It proves **nothing** about Crawl4AI, SearXNG, Redis, target websites, or the Wayback Machine.

**This shallowness is a hard constraint, not an omission.** `/health` is the platform health check path configured on the deployed `Tools` service, used both as a deploy gate and as an ongoing container check. If `/health` ever gained dependency state or network I/O, an upstream outage would return non-2xx from a perfectly healthy container, so the platform would restart-loop healthy containers and would block every deploy for as long as the upstream stayed down — precisely when shipping a fix matters most. `/health` must therefore never acquire a dependency check, and its body must never carry dependency state.

### `GET /ready` — dependency readiness

`GET /ready` is the authenticated dependency probe. It reports per-dependency status plus an aggregate rollup:

```json
{
  "status": "degraded",
  "checked_at": "2026-07-19T12:00:00.000Z",
  "dependencies": {
    "searxng":  { "status": "unhealthy", "latency_ms": 3001, "detail": "timeout" },
    "crawl4ai": { "status": "ok", "latency_ms": 42 }
  }
}
```

- **Always HTTP 200**, even when every dependency is unhealthy. Monitors read dependency state from the body, never from the status code. This keeps degraded state out of status-code space, where a future misconfiguration could wire it to a platform restart trigger.
- **`/ready` must never be configured as a platform health check path.** It is the counterpart of the `/health` constraint above: pointing a platform check at `/ready` would reintroduce, by configuration, the restart loop the split exists to prevent.
- **Probes run concurrently and each is bounded by an explicit short timeout** (`PROBE_TIMEOUT_MS`, 3s). This is deliberately not `Config.requestTimeout` (15s), which is a per-search budget: a health probe must answer far faster than a user query. A timeout is a verdict, not an error — `checkReadiness()` never rejects.
- **Results are cached with a single-flight TTL** (`READINESS_CACHE_TTL_MS`, at most 5s). A burst of concurrent callers triggers one probe round, and upstream request volume is bounded by the TTL rather than by poll rate, so polling `/ready` cannot become a load amplifier against SearXNG or Crawl4AI. A cached response carries the older `checked_at`, which is how a caller sees staleness; there is no separate `cached` flag.
- **Rollup**: all dependencies `ok` → `ok`; some but not all → `degraded`; none → `unhealthy`.
- **`detail` is present only when a dependency is `unhealthy`, and is drawn from a closed set**: `timeout`, `network_error`, `protocol_error`, or `http_status:<code>`. It is never free-form upstream text, a URL, a header, or an exception message, so no configured URL, credential, or token can reach the body.

What each probe proves:

- **SearXNG** — one cheap `GET ${SEARXNG_URL}/healthz`, never a real user query. Any response with `status < 500` counts as reachable, including `404`: this is a *reachability* probe, and a `404` still proves the SearXNG HTTP server accepted a connection and answered. The deployed image tracks a rolling tag, so `/healthz` is not a version-pinned contract and treating `404` as unhealthy would report a false outage on an image change. `status >= 500` is `unhealthy` with `http_status:<code>`.
- **Crawl4AI** — a `tools/list` protocol call over the shared memoised MCP client. This proves MCP connectivity; it does **not** prove that a browser can launch.

So `/ready` proves that SearXNG is reachable and that Crawl4AI answers MCP. It does not prove that a search will return results, that a browser will launch, that a target site is reachable, or that the Wayback Machine is available. Redis is not probed directly — Web Tools has no Redis client, and Redis failure is observable transitively through the SearXNG probe.

Probing a dependency is not free of hazards of its own. See [`issues/eventsource-refused-connection-reconnect-leak.md`](./issues/eventsource-refused-connection-reconnect-leak.md) for the upstream SSE behaviour that makes a *refused* Crawl4AI connection behave completely differently from a clean non-200 response, and why the Crawl4AI probe owns transport teardown rather than merely dereferencing the shared client.

### `GET /stats` — usage counters

`GET /stats` and `web_usage_stats` expose the same process-local counters. They reset on restart and are suitable for lightweight inspection, not durable accounting, billing, or historical monitoring.

### Inbound request records

Every inbound HTTP request emits exactly one `http_request` operation record carrying `requestId`, `method`, `path`, `status`, `durationMs`, and `userAgent` (`null` when the caller sent no `User-Agent`). Unlike the counters above, these records are not process-local state — they are the per-request evidence trail that makes traffic attributable to a source.

The middleware is mounted immediately after JSON parsing and **strictly before** the authentication middleware. Auth rejects a request with 403 by terminating the chain without calling `next()`, so mounting the logger after auth would silently drop every rejected request — exactly the traffic that most needs attributing. Rejected requests are logged with their status, `outcome: "error"`, and their user agent.

This complements rather than duplicates the hosting platform's own HTTP log, which carries no user agent, client IP, or request ID.

## Testing

Tests run on the Node.js 24 built-in `node:test` runner with `node:assert/strict`. No test framework, runner, or assertion library is a dependency; the toolchain remains `typescript` plus `prettier`.

- Tests are TypeScript, written alongside the source they cover as `*.test.ts`.
- Each package carries a `tsconfig.test.json` that compiles source and tests into `dist-test/`, and a `tsconfig.build.json` that excludes `*.test.ts` so test code never reaches the shipped `dist/` or the production image. The root `Dockerfile` copies the build tsconfigs for that reason.
- Each package's `test` script compiles with `tsconfig.test.json` and then runs `node --test` over the compiled output; the root `test` script delegates to the packages.
- Provider behavior is simulated by stubbing `globalThis.fetch` and restoring it in teardown. Production code carries no dependency-injection seam that exists only for tests.
- Transport scenarios exercise the real MCP registration, the REST tool handler, and the CLI command registration in-process rather than by spawning a server or a subprocess.

Run all tests from the repository root with `pnpm test`; see [`../CLAUDE.md`](../CLAUDE.md) for the full validation command set.

## Deployment Model

Local orchestration uses Docker Compose. Production deployment material targets the same four-service topology. Configuration is supplied through environment variables and service URLs; secrets remain outside version control.

The service graph should remain explicit:

- Web Tools depends on reachable Crawl4AI and SearXNG endpoints.
- SearXNG depends on Redis according to its service configuration.
- Archive operations depend on public Wayback Machine endpoints.
- The API listens on the platform-provided `PORT`, defaulting to `3000` locally.

### Service Image Provenance

Three of the four owned services are built from this repository, and both the local Compose stack and the production deployment build from the same sources: Web Tools from the root `Dockerfile`, SearXNG from `services/searxng`, and Crawl4AI from `services/crawl4ai`. Only Redis runs a stock upstream image (`redis:7-alpine`).

Crawl4AI is repository-owned rather than pulled prebuilt because the upstream image is unusable as published: its Playwright headless-shell binary is missing from the path Crawl4AI resolves at runtime, so the server fails to launch a browser. `services/crawl4ai/Dockerfile` pins `unclecode/crawl4ai:0.9.1`, reinstalls the browser binaries, and guards the build on the binary being present. The pin also keeps the Crawl4AI version from drifting. That image is amd64-only, so the Compose service declares `platform: linux/amd64` and arm64 hosts run it under emulation; the first local start builds the image rather than pulling it.

Operator-facing setup for both paths lives outside this document: local stack steps in the root [`README.md`](../README.md), and the per-service Railway configuration in [`RAILWAY.md`](../RAILWAY.md).

## Technology Choices

- **Node.js 24 and TypeScript**: one language and type system across toolkit and adapters.
- **pnpm workspaces**: explicit local package boundaries and deterministic monorepo builds.
- **Zod**: runtime validation aligned with inferred TypeScript types.
- **Express 5**: small HTTP adaptation layer for MCP, REST, health, and statistics.
- **Model Context Protocol SDK**: protocol implementation rather than a custom MCP transport.
- **Commander**: direct command-to-tool mapping for local use.
- **SearXNG, Crawl4AI, Redis, Wayback Machine**: focused upstreams rather than implementing search, browser automation, or archival storage in this repository.

## Change Constraints

- Preserve explicit `.js` suffixes in TypeScript ESM imports.
- Build toolkit before packages that consume it.
- Do not introduce transport-specific tool behavior.
- Do not expose raw provider responses unless the public contract deliberately requires them.
- Do not add durable state to process-local statistics by implication; that requires a separate product and architecture decision.
- Add a new runtime service only when its ownership and operating cost cannot fit an existing boundary.
