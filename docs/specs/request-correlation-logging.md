# Request Correlation IDs And Structured Operation Logging

- **Status**: Draft
- **Task**: request-correlation-logging
- **Last Updated**: 2026-07-21
- **Document Scope**: One unit of work: replace the repository's unstructured `process.stderr.write` logging with a single shared structured logger in `packages/toolkit`, propagate a per-request correlation ID through the toolkit without changing any public tool signature, and attach operation, outcome, duration, and safe upstream context to every operation log line.

---

## Goal

### Problem

Production logs cannot be tied back to a request, an input, or an outcome. Every log line in the API and toolkit is a bare `process.stderr.write` of a concatenated string with no request ID, no operation name, no duration, and no upstream status. During the 2026-07-17/18 production incident several failures could not be reconstructed at all:

- SearXNG attempt lines identify only an attempt number. `searchSearXNG` fires `Config.parallelRequests` (3) *simultaneous identical* requests labelled 1..3, so three interleaved lines from one search are indistinguishable from three sequential retries, and lines from two concurrent searches interleave with nothing to separate them.
- Crawl4AI failure lines carry only the tool name. Two Tools-to-Crawl4AI timeouts could not be attributed to a target URL.
- Crawl4AI rejected 72 requests with a bare `POST http://127.0.0.1:11235/crawl "HTTP/1.1 400 Bad Request"`. That line comes from the pinned upstream image's own MCP-to-REST bridge and carries no URL, no validation detail, and no correlation ID. Web Tools logged nothing correlatable, so the root cause is permanently unrecoverable (see [`../issues/crawl4ai-400-burst-root-cause-unrecoverable.md`](../issues/crawl4ai-400-burst-root-cause-unrecoverable.md)).
- 52 unexplained `GET /mcp 405` responses cannot be attributed to a source because the API logs no inbound request line and no user agent (see [`../issues/get-mcp-405-probing.md`](../issues/get-mcp-405-probing.md)).

### Change

1. Add one shared structured logger to `packages/toolkit` that emits exactly one line of JSON per record to **stderr**.
2. Carry a request-correlation ID through `node:async_hooks` `AsyncLocalStorage` so toolkit code reads it ambiently — no public tool signature changes.
3. Replace the duplicate ad-hoc `log` helpers and the remaining raw `process.stderr.write` call sites with the shared logger.
4. Attach request ID, operation, outcome, duration, and the safe upstream identifier to every operation line; label the SearXNG fan-out; name the target host on every Crawl4AI failure path; log a values-free shape summary of every outgoing Crawl4AI payload *before* dispatch; log inbound API requests with user agent.

### User value

A production failure becomes attributable: an operator holding a timestamp, a user-reported error string, or a Crawl4AI 400 can locate the originating call, its inputs, its upstream target, and whether the caller ultimately got an answer. This is the Phase 3 exit condition in [`../PRODUCT.md`](../PRODUCT.md) ("Logs identify operation, provider, duration, outcome, and safe error context") and principle 5 ("Operational truth is explicit").

### Non-goals

- Shipping logs to an external aggregator.
- Adding a metrics or tracing backend (OpenTelemetry, Prometheus).
- Changing any `web_*` tool response contract or success-path payload shape.
- Changing the parallel fan-out count or SearXNG retry/timeout configuration (story `searxng-log-volume`).
- Fixing the `res.on('close')` lifecycle bug (story `request-lifecycle-abort-propagation`).
- Changing Crawl4AI `browser_config` / `crawler_config` payload **shapes** (story `normalize-crawl4ai-config-payloads`).
- Changing `/health` behavior or adding readiness probing (story `health-liveness-readiness-split`).
- Adding a log level filter, sampling, or a `LOG_LEVEL` environment knob.

---

## Design

### Where things live

Per [`../ARCHITECTURE.md`](../ARCHITECTURE.md) "Package Boundaries" and [`../../packages/CLAUDE.md`](../../packages/CLAUDE.md), provider-facing behavior stays in `packages/toolkit`; `packages/api` and `packages/cli` are transport adapters. The logger and the correlation-context store therefore live in the toolkit and are re-exported from its entry point. The API owns only the transport-level concerns: minting/adopting the request ID, entering the context, and emitting the inbound HTTP request line.

| File | Change |
| --- | --- |
| `packages/toolkit/src/logging.ts` | **New.** The shared logger, the `AsyncLocalStorage` request context, and the safe-value helpers. |
| `packages/toolkit/src/index.ts` | Re-export the logging surface the API needs. |
| `packages/toolkit/src/searxng.ts` | Replace `logOutcome` internals with the shared logger; add correlation, query, base URL, status, duration; add the per-search summary line. |
| `packages/toolkit/src/functions.ts` | Delete the duplicate `log` helper; carry the target URL into `proxyCrawl4AI`; include the request ID in returned Crawl4AI error text. |
| `packages/toolkit/src/crawl4ai.ts` | Replace the raw `process.stderr.write`; log the pre-dispatch argument-shape summary and the call outcome. |
| `packages/api/src/request-log.ts` | **New.** Exported Express middleware: adopt/mint the request ID, enter the context, emit the inbound request line on response finish. |
| `packages/api/src/index.ts` | Delete the duplicate `log` helper; mount the middleware **immediately after `express.json()` and strictly before the auth middleware**; convert lifecycle lines to the shared logger. |
| `packages/toolkit/src/*.test.ts`, `packages/api/src/*.test.ts`, `packages/cli/src/*.test.ts` | **New/extended.** Scenario tests. |

### Record shape

Every record is one `JSON.stringify` of a flat object plus `\n`, written to `process.stderr`. Two record kinds:

**Diagnostic / lifecycle** — process startup, shutdown, transport errors:

```json
{"ts":"2026-07-21T10:00:00.000Z","kind":"event","level":"info","event":"server_listening","port":3000}
```

**Operation** — anything with a measurable outcome:

```json
{"ts":"2026-07-21T10:00:00.000Z","kind":"operation","level":"error","event":"crawl4ai_call","requestId":"3f2a…","operation":"crawl4ai.crawl","outcome":"error","durationMs":31204,"targetUrl":"https://example.com/a/b","cause":"MCP error -32001: Request timed out"}
```

`kind: "operation"` is the discriminator that makes "operation log line" a testable, mechanical property rather than a judgement call. Every operation record carries **`requestId`, `operation`, `outcome`, `durationMs`**. `outcome` is exactly one of `ok`, `empty`, `error`.

**`kind` is reserved for the record type.** The existing `logOutcome` in `packages/toolkit/src/searxng.ts` currently writes a *different* `kind` on the `searxng_attempt_outcome` record, carrying the attempt classification `ok` / `empty` / `failed`. Two meanings on one field name is not acceptable, so the attempt classification moves to the uniform `outcome` field and the `failed` token becomes `error`:

| `searxng_attempt_outcome` before | after |
| --- | --- |
| `kind: "ok" \| "empty" \| "failed"` | `kind: "operation"`, `outcome: "ok" \| "empty" \| "error"` |

The internal TypeScript `FetchOutcome` union in `searxng.ts` keeps its existing `ok` / `empty` / `failed` member names — that is code, not a log contract — and is mapped to the log vocabulary at emit time. The stable *event name* `searxng_attempt_outcome` documented in [`../ARCHITECTURE.md`](../ARCHITECTURE.md) is preserved.

This is a deliberate, breaking change to one log field name, and it is the only one. `packages/toolkit/src/web-search.test.ts` asserts on that field at lines 231, 254, and 259; those three assertions **must** be updated to the new field and vocabulary. Every other assertion in that file, and every assertion in the other four existing test files, stays as it is. No alternative preserves a single uniform `outcome` vocabulary across all operation records, which is what the story card's "each operation log line carries … an outcome" criterion is mechanically checked against.

### Correlation context

`AsyncLocalStorage<{ requestId: string }>` in `logging.ts`.

- The API middleware adopts an inbound `X-Request-Id` header when present, otherwise mints one with `node:crypto` `randomUUID()`, and runs the rest of the request inside the store. It is mounted **before the auth middleware**, so a request the auth middleware rejects with 403 — which terminates the chain without calling `next()` — is still logged. Attributing exactly that traffic is the point of the `GET /mcp` 405 issue this story cites.
- When no store is active (CLI, direct toolkit use, background work), the store is established by **one shared `runOperation()` wrapper in `packages/toolkit/src/functions.ts` that every public tool function routes through** — `web_search`, `web_fetch`, `web_screenshot`, `web_pdf`, `web_execute_js`, `web_crawl`, `web_snapshots`, `web_archive`, `web_usage_stats`. `runOperation()` is the single place that: joins the ambient store or creates one, starts the duration timer, and emits the operation record with `operation`, `outcome`, and `durationMs`. Concentrating it in one wrapper is what makes "every operation record carries a `requestId`" true on *all* paths rather than only the Crawl4AI ones — the CLI `search` path in particular reaches `searchSearXNG` without going anywhere near `proxyCrawl4AI`.
- `runOperation()` must not alter any tool's return value or thrown error. A throw is recorded as `outcome: "error"` and rethrown unchanged, so `SearchProviderError` still reaches the transports with its existing message and `reasons`.
- No public tool signature changes. `AsyncLocalStorage` is a Node built-in (`node:async_hooks`); no dependency is added.

An adopted `X-Request-Id` is untrusted caller input. It is bounded to 200 characters and stripped of everything outside `[A-Za-z0-9._:-]`; if nothing survives, a fresh ID is minted. This keeps a hostile header from injecting a newline (which would forge a log line) or unbounded volume.

### Safe values — what may and may not be logged

[`../ARCHITECTURE.md`](../ARCHITECTURE.md) "Authentication And Trust" forbids logging API keys, full secrets, and sensitive target content.

- **Never logged**: the `Authorization` header value, the `api_key` query parameter value, any request or response body, any proxy username or password, any script body, any Crawl4AI argument *value*.
- **Logged**: the search query (truncated to 256 characters), the sanitized target URL, the SearXNG base URL, upstream HTTP status, durations, user agent (truncated to 200 characters), method, path, response status.

**Target URL sanitization.** The story card asks for the target URL on Crawl4AI lines *and* requires that no target-URL query string appear in any log line. These are reconciled by logging a sanitized URL: scheme + host + pathname, with userinfo, query string, and fragment removed, and a boolean `targetHasQuery` recording whether a query string was present. Path is truncated to 200 characters. A string that does not parse as a URL is reported as `"(unparseable)"` rather than echoed. This satisfies the card's stated diagnostic goal — "the originating tool call and target host are identifiable" — without ever emitting caller-supplied query values, which are the plausible carrier of tokens and credentials.

**Argument-shape summary.** `summarizeArgShape(args)` maps each **top-level** key to a type token only: `"string"`, `"number"`, `"boolean"`, `"null"`, `"object"`, or `"array[N]"` where `N` is the length. Values are never read beyond `typeof` and `Array.isArray`/`.length`. Nesting is never descended, which is what structurally guarantees the proxy credentials (nested at `browser_config.params.proxy_config.params`) and script bodies cannot leak.

The path-truncation and query-stripping rules also bound log volume, which matters because the `api_key` query parameter means `req.originalUrl` may itself carry the key. The middleware logs `req.path` and never `req.originalUrl`, `req.url`, `req.query`, or `req.headers` wholesale.

### SearXNG fan-out labelling

`searchSearXNG` assigns each invocation a `searchId` (a short random token). Each of the `Config.parallelRequests` attempts logs with `{ requestId, searchId, attempt }`, so:

- attempts of one search are individually distinguishable (distinct `attempt` under one `searchId`);
- attempts of two concurrent searches are separable (distinct `searchId`), even when both run under the same `requestId`.

The existing stable event name `searxng_attempt_outcome` (documented in `ARCHITECTURE.md` "Reporting and observability") is preserved and extended, not renamed. A new `search_complete` record is emitted once per `searchSearXNG` call carrying the outcome the caller actually received, the winning attempt, the result count, and the per-cause failure counts — so an operator reading a failed attempt line can immediately tell whether the caller was still served.

### Crawl4AI attribution

`proxyCrawl4AI` gains a context parameter carrying the operation name and the raw target URL; it is an internal function, so no public signature changes. All three failure paths (error response, empty content, thrown) log the sanitized target URL, and all three return the request ID in the caller-visible error text so a user-reported string can be grepped.

`WebCrawlInput.urls` is an array, so `web_crawl` may target several URLs in one call. The rule is: log the **first** entry as `targetUrl` (sanitized) plus a numeric `targetUrlCount`. Per-URL attribution inside a single multi-URL crawl is out of scope for this story; `targetUrlCount > 1` is the signal that the logged target is one of several. `web_fetch`, `web_screenshot`, `web_pdf`, and `web_execute_js` take a single `url`, so their `targetUrlCount` is `1`. A call with no derivable URL logs `targetUrl: null` and `targetUrlCount: 0` rather than omitting the fields.

The argument-shape summary is emitted in `crawl4ai.ts` `call()` **before** `getClient()` and `callTool` are attempted. Emitting pre-dispatch is what makes a future upstream 400 attributable: the upstream bridge rejects the request without telling us anything, so our line must already exist by then. A second record after the call carries the outcome and duration.

### Risks

- **Log volume.** Successful calls now log where they previously did not. Bounded by: one line per API request, one per tool operation, one per SearXNG attempt (already the case today), two per Crawl4AI call. All values are truncated. Story `searxng-log-volume` owns any further reduction.
- **Concurrent-story conflict.** Three sibling stories touch overlapping files. See *Coordination* below.
- **Context loss.** `AsyncLocalStorage` propagates across `await` and promise chains but not across a manual `setTimeout` re-entry from outside the store. No such pattern exists on these paths; the fallback is a locally-minted ID, never a crash or a missing field.

### Alternatives rejected

- **Thread a `requestId` parameter through every tool.** Rejected by the card: it would change nine public signatures and both transports.
- **Add a logging library (pino/winston).** Rejected: [`../ARCHITECTURE.md`](../ARCHITECTURE.md) "Testing" and [`../../packages/CLAUDE.md`](../../packages/CLAUDE.md) keep the toolchain at `typescript` + `prettier`. A 40-line JSON writer is sufficient.
- **Log the full target URL.** Rejected: it conflicts with the card's own acceptance criterion forbidding target-URL query strings in logs.

### Test fixture: a local Crawl4AI MCP stand-in

Six of the nine public tools reach Crawl4AI over MCP/SSE, not over `fetch`: `web_fetch`, `web_screenshot`, `web_pdf`, `web_execute_js`, `web_crawl`, and — less obviously — `web_archive`, whose `getArchivedPage` calls `callMdTool` (`packages/toolkit/src/wayback.ts:71`). Only `web_search` and `web_snapshots` are driven by `globalThis.fetch`; `web_usage_stats` touches no upstream at all.

Pointing `CRAWL4AI_URL` at a closed port produces a connection failure and nothing else. That covers exactly one of `proxyCrawl4AI`'s three failure paths — the thrown one. The card requires all three named (`functions.ts:66` error response, `:78` empty content, `:93` thrown), and the empty-payload and `isError` paths are only reachable from a *responding* upstream. A stand-in is therefore mandatory, not a convenience.

The stand-in is a real MCP server, not a stub of our own code, so no dependency-injection seam is introduced (forbidden by [`../../packages/CLAUDE.md`](../../packages/CLAUDE.md)) and no dependency is added — `@modelcontextprotocol/sdk` is already a `packages/toolkit` dependency:

- A `node:http` server bound to an ephemeral port on `127.0.0.1`, serving `GET /mcp/sse` through `SSEServerTransport` from `@modelcontextprotocol/sdk/server/sse.js` and its POST message endpoint, connected to an `McpServer` registering the five upstream tool names `crawl`, `md`, `screenshot`, `pdf`, `execute_js`.
- Each handler's reply is settable per test: canned success content, `isError: true` with a message, or content that is empty/whitespace — which is what makes all three `proxyCrawl4AI` paths reachable.
- Because `Config` is parsed at module load (`packages/toolkit/src/config.ts`), the fixture starts first, sets `process.env.CRAWL4AI_URL` to its own base URL, and the test then reaches the toolkit through a **dynamic `await import()`**. `node --test` gives each test file its own process, so this does not leak between files.
- The closed-port technique remains the right tool for the connection-failure and pre-dispatch-shape-logging scenarios; the fixture covers everything that needs a live upstream.
- Close the SSE connection and the `node:http` server in test teardown. `crawl4ai.ts` caches one module-level client, so all Crawl4AI-backed calls in a file share one connection; the fixture's per-test replies are mutable state the registered handlers read, which is sufficient — no per-connection session tracking is needed.

One asymmetry to expect rather than "fix": `getArchivedPage` (`packages/toolkit/src/wayback.ts:72-75`) never inspects `result.isError`, so an `isError: true` reply from the stand-in still yields extractable content and `web_archive` returns normally with `outcome: "ok"`. That is current behavior, it is correct for the wrapping scenario's purpose, and `wayback.ts` is out of this unit's Boundary — do not change it to make the stub "fail".

### Durable documentation impact — for the docs pass, not this unit

This unit must not edit `docs/ARCHITECTURE.md`; the story's single docs pass owns it. Recording here what will go stale so the docs pass has the list:

- "Reporting and observability" describes the `searxng_attempt_outcome` record's old field set. It needs the renamed classification field (`kind` → `outcome`, `failed` → `error`), plus `requestId`, `searchId`, `query`, `baseUrl`, `status`, `durationMs`, and the new `search_complete` summary record.
- "Failure Model" and "Authentication And Trust" need the repository-wide logging contract: one JSON object per stderr line, the `event` / `operation` record kinds, the four mandatory operation fields, the request-ID adoption/minting rule, target-URL sanitization, the values-free Crawl4AI argument-shape summary, and the explicit redaction list.
- "Health And Statistics" / the API section needs the `http_request` inbound record and the fact that auth rejections are logged.
- The `X-Request-Id` request header contract belongs in the API-facing docs.

### Coordination

- **Test runner — already provisioned; reuse, do not re-add.** The card's scope says "Provision a test runner if none exists yet". One now exists: sibling story `distinguish-search-failure-from-empty-results` landed `node:test` on Node 24, a `tsconfig.test.json` per package, package `test` scripts, a root `test` script, and five `*.test.ts` files. **Detect and reuse it. Do not add a test framework, runner, or assertion dependency** — [`../../packages/CLAUDE.md`](../../packages/CLAUDE.md) forbids it explicitly.
- **`normalize-crawl4ai-config-payloads`** (in flight) rewrites the `browser_config` / `crawler_config` construction in `packages/toolkit/src/functions.ts` and the call surface in `crawl4ai.ts`. This unit **reads** those payloads to derive a target URL and a shape summary and must not alter their construction, key names, wrapping, or defaults.
- **`health-liveness-readiness-split`** (in flight) rewrites the `/health` route and the auth middleware's health bypass in `packages/api/src/index.ts`. This unit must not change `/health` behavior, the auth middleware, or `keyMatches`; it inserts request-logging middleware and replaces the `log` helper only.
- **`align-compose-stack-with-deployed-images`** (in flight) owns `docker-compose.yml`, `RAILWAY.md`, and `services/`. This unit touches none of them.

---

## Requirements

### Requirement: A single shared structured logger

#### Scenario: One helper replaces the duplicates

- **WHEN** the repository is searched after this unit lands
- **THEN** `packages/toolkit/src/logging.ts` exists and exports the logging surface
- **AND** no `const log = (...args: unknown[]) =>` helper remains in `packages/api/src/index.ts`, `packages/toolkit/src/searxng.ts`, or `packages/toolkit/src/functions.ts`
- **AND** no `process.stderr.write` call remains in `packages/api/src/**` or `packages/toolkit/src/**` outside `logging.ts`

#### Scenario: Every emitted line is valid single-line JSON

- **WHEN** a test drives a `web_search` that fails, a `web_search` that returns results, a `web_crawl` against an unreachable Crawl4AI, and an inbound API request, capturing everything written to `process.stderr`
- **THEN** every captured non-empty line parses with `JSON.parse` without throwing
- **AND** each parsed value is a non-array object carrying a `ts`, a `kind`, and an `event`

#### Scenario: Operation lines carry the four required fields

- **WHEN** the captured stderr from the scenario above is filtered to records with `kind === "operation"`
- **THEN** at least one such record exists for each of the API request, the search, and the crawl
- **AND** every one of them has a non-empty string `requestId`, a non-empty string `operation`, an `outcome` in `["ok","empty","error"]`, and a `durationMs` that is a finite non-negative number

#### Scenario: The outcome vocabulary is uniform

- **WHEN** every `kind === "operation"` record from the capture above is collected
- **THEN** no record carries the token `failed` in its `outcome`
- **AND** no record carries a top-level `kind` value other than `"operation"` or `"event"`

#### Scenario: Logs go to stderr only

- **WHEN** any of the above is driven with `process.stdout.write` captured
- **THEN** no log record appears on stdout

### Requirement: Request correlation identity

#### Scenario: An inbound X-Request-Id is adopted

- **WHEN** an HTTP request carrying `X-Request-Id: abc-123` is served by an Express app mounting the exported request-logging middleware
- **THEN** the inbound request record's `requestId` equals `abc-123`

#### Scenario: A missing X-Request-Id is minted

- **WHEN** an HTTP request without an `X-Request-Id` header is served
- **THEN** the inbound request record carries a non-empty `requestId`
- **AND** a second such request produces a different `requestId`

#### Scenario: A hostile X-Request-Id cannot forge a log line

- **WHEN** an HTTP request carrying an `X-Request-Id` containing a newline, a quote, and 5000 characters is served
- **THEN** the number of captured stderr lines is unchanged versus the same request without the header
- **AND** every captured line still parses as JSON
- **AND** the recorded `requestId` is at most 200 characters and contains no newline

#### Scenario: All lines from one request share its ID

- **WHEN** a single API request invokes `web_search` and its SearXNG attempts fail
- **THEN** the inbound request record, every `searxng_attempt_outcome` record, the `search_complete` record, and the tool operation record all carry the same `requestId`

#### Scenario: Every one of the nine public tools is wrapped, and none has its payload altered

This is a **table-driven scenario over the complete export list of `packages/toolkit/src/functions.ts`** — `web_search`, `web_fetch`, `web_screenshot`, `web_pdf`, `web_execute_js`, `web_crawl`, `web_snapshots`, `web_archive`, `web_usage_stats`. It must be written so that adding a tenth tool without wrapping it, or skipping any one of the nine, fails. Do not write it as nine hand-picked cases that happen to cover the list today; drive it from `functionMap` so the coverage is structural.

The upstream each tool actually talks to is *not* uniform, and the stubbing must match it — see *Test fixture: a local Crawl4AI MCP stand-in* above:

| Tool | Upstream | Driven by |
| --- | --- | --- |
| `web_search` | SearXNG over HTTP | `globalThis.fetch` stub |
| `web_snapshots` | Wayback CDX API over HTTP | `globalThis.fetch` stub |
| `web_fetch`, `web_screenshot`, `web_pdf`, `web_execute_js`, `web_crawl` | Crawl4AI over MCP/SSE | the MCP stand-in |
| `web_archive` | Crawl4AI over MCP/SSE (`getArchivedPage` → `callMdTool`) — **not** `fetch` | the MCP stand-in |
| `web_usage_stats` | none | nothing to stub |

The two `fetch`-driven tools hit different upstream contracts, so a single `globalThis.fetch` stub must branch on the request URL to serve the SearXNG JSON shape and the CDX array shape respectively.

- **WHEN** each of the nine tools is invoked in turn with a minimal valid argument set, driven to a deterministic **failure** — the `fetch` stub answering non-2xx for the two HTTP tools, the MCP stand-in replying `isError: true` for the six Crawl4AI-backed tools — with stderr captured per invocation
- **THEN** each invocation emits **exactly one** `kind === "operation"` record whose `operation` equals that tool's name, carrying a non-empty `requestId`, an `outcome` in `["ok","empty","error"]`, and a finite non-negative `durationMs`
- **AND** every other record emitted during that invocation carries the same `requestId`
- **AND** two sequential invocations of the same tool carry different `requestId` values

- **WHEN** each of the nine tools is invoked driven to a deterministic **success** — the `fetch` stub returning a well-formed body for the two HTTP tools, the MCP stand-in returning canned text content for the six Crawl4AI-backed tools, and `web_usage_stats` called directly
- **THEN** each returns exactly the value it returns today, with no wrapper, no added field, and no removed field: the five Crawl4AI-backed tool functions return a `ToolResult` carrying `content`; `web_search` returns the bare `SearchResult[]`; `web_snapshots` returns its snapshot list; `web_archive` returns `{ waybackUrl, contentLength, content }`; `web_usage_stats` returns the `getStats()` object
- **AND** each emits an operation record with `outcome === "ok"`

- **WHEN** a tool that throws today is driven to throw — `web_search` on a total SearXNG outage, `web_snapshots` on a rejected `fetch`, `web_archive` with `CRAWL4AI_URL` at a closed port
- **THEN** the same error propagates to the caller unchanged, with its original `name`, `message`, and — for `SearchProviderError` — its `reasons`
- **AND** the emitted operation record carries `outcome === "error"`

This scenario is load-bearing: `web_fetch`, `web_screenshot`, `web_pdf`, `web_execute_js`, `web_snapshots`, `web_archive`, and `web_usage_stats` have **no** existing test coverage of any kind, so without it a forgotten `runOperation()` wrap — or one that alters a return value — would pass the entire suite.

#### Scenario: A context-free search still correlates

- **WHEN** `web_search` is called directly from the toolkit with no HTTP request in flight, against a stub that fails every attempt
- **THEN** every emitted record for that call — each `searxng_attempt_outcome`, the `search_complete` record, and the `web_search` operation record — carries the same non-empty `requestId`
- **AND** a second, sequential `web_search` call carries a different `requestId`

#### Scenario: Concurrent context-free calls get distinct IDs

- **WHEN** three `web_crawl` calls for three distinct URLs are started concurrently from the toolkit with no HTTP request in flight
- **THEN** the operation records for the three calls carry three distinct `requestId` values
- **AND** every Crawl4AI record in the capture matches the `requestId` of exactly one of the three originating calls
- **AND** each of the three sanitized target hosts appears under exactly one `requestId`

### Requirement: Secrets never reach the logs

#### Scenario: The API key appears in no log line

- **WHEN** an HTTP request is issued carrying the configured API key both as `Authorization: Bearer <key>` and as an `?api_key=<key>` query parameter, against an Express app mounting the exported request-logging middleware and the real `toolHandler`, with stderr captured
- **THEN** an inbound request record is emitted
- **AND** the configured key string appears in no captured line
- **AND** no captured line contains the substring `api_key`
- **AND** no captured line contains an `authorization` field

#### Scenario: The Crawl4AI argument-shape summary carries no values

- **WHEN** the toolkit is loaded with `PROXY_SERVER`, `PROXY_USERNAME`, and `PROXY_PASSWORD` configured and `CRAWL4AI_URL` pointing at a closed local port, and `web_fetch` is called for `https://example.com/p?token=SUPERSECRET&q=x`, and `web_execute_js` is called with a script body `SCRIPT_BODY_MARKER`, with stderr captured
- **THEN** a record with `event === "crawl4ai_request_shape"` is emitted for each call
- **AND** its `argShape` maps only top-level key names to the type tokens `string`, `number`, `boolean`, `null`, `object`, or `array[N]`
- **AND** no captured line contains `SUPERSECRET`, `token=`, `SCRIPT_BODY_MARKER`, the configured proxy username, or the configured proxy password

#### Scenario: The shape summary is emitted before dispatch

- **WHEN** `web_fetch` is called with `CRAWL4AI_URL` pointing at a closed local port, so the upstream connection fails
- **THEN** a `crawl4ai_request_shape` record is still emitted
- **AND** it appears in the capture before the corresponding failure record

### Requirement: SearXNG operations are attributable

#### Scenario: A failing attempt names query, base URL, and status

- **WHEN** `globalThis.fetch` is stubbed to answer every SearXNG attempt with HTTP 503 and `web_search` is called with the query `spec-probe-query`
- **THEN** every `searxng_attempt_outcome` record carries `query === "spec-probe-query"`, a `baseUrl` equal to the configured SearXNG URL, `outcome === "error"`, a numeric `durationMs`, and `status === 503`

#### Scenario: A timeout omits the status rather than inventing one

- **WHEN** `globalThis.fetch` is stubbed to reject with a `TimeoutError` `DOMException`
- **THEN** the attempt records carry `outcome === "error"` and a `cause` of `timeout`
- **AND** they carry no `status` field

#### Scenario: Parallel copies of one search are distinguishable

- **WHEN** a single `web_search` runs against a stub that fails every attempt
- **THEN** exactly `Config.parallelRequests` `searxng_attempt_outcome` records are emitted
- **AND** they share one `searchId` and carry pairwise distinct `attempt` values

#### Scenario: Two concurrent searches are separable

- **WHEN** two `web_search` calls with different queries run concurrently against a stub that fails every attempt
- **THEN** the emitted `searxng_attempt_outcome` records partition into exactly two distinct `searchId` groups
- **AND** each group has `Config.parallelRequests` records and one distinct query

#### Scenario: One summary line per search states what the caller received

- **WHEN** a `web_search` runs where one attempt succeeds with results and the others fail
- **THEN** exactly one `search_complete` record is emitted for that search
- **AND** it carries the search's `searchId`, `outcome === "ok"`, a `resultCount` greater than zero, the winning `attempt`, and a `durationMs`
- **AND** it carries a count of the failed attempts

#### Scenario: A genuine empty search is not reported as a failure

- **WHEN** a `web_search` runs where every attempt returns HTTP 200 with zero results and no unresponsive engines
- **THEN** the single `search_complete` record carries `outcome === "empty"` and `resultCount === 0`

#### Scenario: A total search outage is summarized as an error

- **WHEN** a `web_search` runs where every attempt fails
- **THEN** the single `search_complete` record carries `outcome === "error"`
- **AND** `searchSearXNG` still throws `SearchProviderError` with its existing message and `reasons`, unchanged

### Requirement: Crawl4AI failures name their target

#### Scenario: The error-response path names the target

- **WHEN** the MCP stand-in replies with `isError: true` to a `web_crawl` call — the `packages/toolkit/src/functions.ts:66` path
- **THEN** the emitted operation record carries `outcome === "error"`, the sanitized target URL, and a `durationMs`

#### Scenario: The empty-content path names the target

- **WHEN** the MCP stand-in replies with content that has no usable text to a `web_crawl` call — the `packages/toolkit/src/functions.ts:78` path
- **THEN** the emitted operation record carries `outcome === "empty"` and the sanitized target URL

#### Scenario: The thrown path names the target

- **WHEN** a Crawl4AI call throws — driven by pointing `CRAWL4AI_URL` at a closed local port so the transport cannot connect — the `packages/toolkit/src/functions.ts:93` path
- **THEN** the emitted operation record carries `outcome === "error"`, the sanitized target URL, and the thrown message as a `cause`

#### Scenario: A multi-URL crawl records its first target and the count

- **WHEN** `web_crawl` is called with three URLs on three distinct hosts and the upstream call fails
- **THEN** the operation record's `targetUrl` is the sanitized first URL
- **AND** `targetUrlCount === 3`

#### Scenario: The target URL is sanitized

- **WHEN** any of the three paths above runs for `https://user:pw@example.com/a/b?token=SUPERSECRET#frag`
- **THEN** the record's target URL is `https://example.com/a/b`
- **AND** it carries `targetHasQuery === true`
- **AND** no captured line contains `SUPERSECRET`, `token=`, or `pw`

#### Scenario: The request ID reaches the caller's error text

- **WHEN** each of the three failure paths returns its `ToolResult` to the caller
- **THEN** `result.isError` is `true`
- **AND** `result.content[0].text` contains the same `requestId` value that appears in the corresponding log record

### Requirement: The API logs each inbound request

#### Scenario: The inbound request line carries method, path, status, duration, and user agent

- **WHEN** a request is issued with `User-Agent: spec-probe-agent/1.0` to an Express app mounting the exported request-logging middleware
- **THEN** exactly one record with `event === "http_request"` is emitted for it
- **AND** it carries `method`, a `path`, a numeric `status`, a numeric `durationMs`, and `userAgent === "spec-probe-agent/1.0"`

#### Scenario: A rejected request is logged too

- **WHEN** a request that the route answers with a 4xx status is issued
- **THEN** an `http_request` record is emitted carrying that status and `outcome === "error"`

#### Scenario: An auth-rejected request is logged

- **WHEN** the exported request-logging middleware is mounted ahead of a terminating middleware that answers with 403 without calling `next()` — the shape of the production auth middleware — and an unauthenticated request is issued
- **THEN** an `http_request` record is still emitted carrying `status === 403` and `outcome === "error"`
- **AND** the record carries the request's user agent, so background probe traffic is attributable to a source

#### Scenario: A missing user agent is recorded explicitly

- **WHEN** a request without a `User-Agent` header is issued
- **THEN** the `http_request` record still parses as JSON and its `userAgent` is `null`

### Requirement: CLI stdout stays machine-parseable

#### Scenario: No log record appears on CLI stdout

- **WHEN** the CLI `search` command is driven in-process against a stub that fails every SearXNG attempt, and again against a stub returning results, with `process.stdout.write` and `console.log` captured
- **THEN** no captured stdout line parses as a JSON object carrying a `kind` of `event` or `operation`
- **AND** the existing CLI behavior — non-zero exit and an `Error:` line on total failure, `No results found.` on a genuine empty — is unchanged

### Requirement: The existing contracts are unchanged

#### Scenario: Tool responses are untouched

- **WHEN** the full test suite runs
- **THEN** the pre-existing tests in `packages/toolkit/src/searxng.test.ts`, `packages/api/src/handler.test.ts`, `packages/api/src/mcp.test.ts`, and `packages/cli/src/search.test.ts` pass **unmodified**
- **AND** `packages/toolkit/src/web-search.test.ts` passes with **only** its three assertions on the `searxng_attempt_outcome` classification field (lines 231, 254, 259) updated from `kind` / `failed` to `outcome` / `error`, every other assertion in the file unchanged

#### Scenario: Crawl payload shapes are untouched

- **WHEN** `git diff main...HEAD -- packages/toolkit/src/functions.ts packages/toolkit/src/crawl4ai.ts` is inspected
- **THEN** no change alters the construction, key names, wrapping, or defaults of `browser_config` or `crawler_config`, or the arguments passed to `callCrawlTool`, `callMdTool`, `callScreenshotTool`, `callPdfTool`, or `callExecuteJsTool`

#### Scenario: The middleware is actually mounted before auth

- **WHEN** `packages/api/src/index.ts` is inspected
- **THEN** the `app.use(...)` line mounting the request-logging middleware appears after `app.use(express.json())` and **before** the `app.use((req, res, next) => { ... keyMatches ... })` auth middleware
- **AND** no other `app.use` is inserted between `express.json()` and the request-logging middleware

This is a diff-inspection gate, not a runtime test: `index.ts` binds the real port at module load and so is never imported by a test. Mounting the logger after auth would silently drop every 403 — exactly the traffic the `GET /mcp` 405 issue needs attributed — and no runnable scenario can catch it.

#### Scenario: Health behavior is untouched

- **WHEN** `git diff main...HEAD -- packages/api/src/index.ts` is inspected
- **THEN** the `/health` route handler's status and response body are unchanged
- **AND** the auth middleware's health bypass and `keyMatches` are unchanged

### Requirement: Validation

#### Scenario: Root validation passes

- **WHEN** `pnpm build`, `pnpm typecheck`, and `pnpm test` are run from the repository root
- **THEN** each exits zero
- **AND** `pnpm test` reports zero failing tests

#### Scenario: Formatting is clean

- **WHEN** `pnpm format` is run
- **THEN** it leaves no further changes to the files this unit touched

#### Scenario: The production image still builds when build inputs change

- **WHEN** this unit adds or modifies any `tsconfig*.json`, any package `build` script, or any file the root `Dockerfile` copies by name
- **THEN** `docker build .` at the repository root must succeed before the unit is reported complete
- **AND** when the unit only adds or edits files under `packages/toolkit/src/` and `packages/api/src/` — which the existing `COPY packages/toolkit/src/` and `COPY packages/api/src/` lines already carry into the image — the root scripts above are sufficient and this scenario is satisfied by inspection of the diff

---

## Boundary

**May create or edit**

- `packages/toolkit/src/logging.ts` (new)
- `packages/toolkit/src/index.ts` (export additions only)
- `packages/toolkit/src/searxng.ts`
- `packages/toolkit/src/functions.ts`
- `packages/toolkit/src/crawl4ai.ts`
- `packages/api/src/request-log.ts` (new)
- `packages/api/src/index.ts`
- Test files `*.test.ts` in `packages/toolkit/src/`, `packages/api/src/`, and `packages/cli/src/`, including the three permitted assertion updates in `packages/toolkit/src/web-search.test.ts` named above and nothing else in that file

All three packages already carry a `tsconfig.test.json` and a `test` script, so every scenario above is runnable in the package that owns the behavior it asserts. The API scenarios import the new `request-log.ts` directly rather than `index.ts`, which has unguarded module-level side effects (it binds the real port); this mirrors the existing `handler.test.ts` convention.

**Must not touch**

- `docs/tasks/**` — the board card is owned by the lead and must not appear on this branch.
- `docs/ARCHITECTURE.md`, `docs/PRODUCT.md`, `docs/issues/**`, `README.md` — owned by the story's single docs pass, which runs after this unit. See *Durable documentation impact* above for what it will need.
- `docker-compose.yml`, `RAILWAY.md`, `services/**`, `Dockerfile` — sibling story `align-compose-stack-with-deployed-images`.
- `packages/toolkit/src/schemas.ts`, `tools.ts`, `stats.ts`, `rotation.ts`, `wayback.ts`, `config.ts`, `types.ts`.
- `packages/cli/src/index.ts` and `packages/cli/src/commands/**` — the CLI needs no change; logger output already goes to stderr. Only CLI *tests* are in scope.
- `packages/api/src/handler.ts`, `packages/api/src/mcp.ts`.
- Any `package.json`, `pnpm-lock.yaml`, or `tsconfig*.json`. **No dependency may be added** — use `node:async_hooks`, `node:crypto`, and `node:test` only.

**Coverage limits stated plainly**

- The production auth middleware stays in `packages/api/src/index.ts` (untouched, to avoid conflicting with the concurrent health story). It emits no log lines; that it cannot leak the API key is therefore established by inspection of the diff, while the redaction scenario above proves the property for the request logger, which is the component that reads the `Authorization` header and the `api_key` query parameter.
- `packages/api/src/index.ts` itself is not imported by any test (unguarded side effects). Its correctness is covered by the exported middleware's tests plus `pnpm build` and `pnpm typecheck`.

---

## Tasks

- [ ] Confirm the test runner already exists (`node:test`, per-package `tsconfig.test.json`, package and root `test` scripts) and reuse it; add no dependency.
- [ ] Add `packages/toolkit/src/logging.ts`: the JSON stderr writer, `kind: "event"` / `kind: "operation"` records, the `AsyncLocalStorage` request context with adopt/mint/sanitize, an operation timer helper, `safeUrl()`, `summarizeArgShape()`, and the query/user-agent truncation helpers.
- [ ] Re-export the logging surface from `packages/toolkit/src/index.ts`.
- [ ] Add `packages/api/src/request-log.ts`: the exported Express middleware that adopts or mints the request ID, enters the context, and emits the `http_request` record on response finish (method, `req.path`, status, duration, user agent) — never `originalUrl`, `query`, or headers wholesale.
- [ ] Rewrite `packages/api/src/index.ts` logging: delete the local `log` helper, mount the middleware immediately after `express.json()` and strictly before the auth middleware so auth rejections are logged, convert the startup / shutdown / MCP-error / request-closed lines to the shared logger. Do not touch auth, `keyMatches`, or `/health`.
- [ ] Rework `packages/toolkit/src/searxng.ts`: per-invocation `searchId`, per-attempt `requestId`/`searchId`/`attempt`/`query`/`baseUrl`/`status`/`durationMs` on the preserved `searxng_attempt_outcome` event with the classification moved from `kind` to `outcome` (`failed` → `error`), and the new `search_complete` summary record. Preserve `SearchProviderError`, its message, and its `reasons` exactly, and keep the internal `FetchOutcome` union member names as they are.
- [ ] Rework `packages/toolkit/src/functions.ts`: delete the local `log` helper; add the single `runOperation()` wrapper and route **all nine** public tool functions through it so every path establishes a request context, times itself, and emits one operation record while returning and throwing exactly what it does today. Give `proxyCrawl4AI` an operation/target context; log all three failure paths and the success path with the sanitized target URL, `targetUrlCount`, and duration; include the request ID in the returned error text. Do not alter payload construction.
- [ ] Update the three `searxng_attempt_outcome` classification assertions in `packages/toolkit/src/web-search.test.ts` (lines 231, 254, 259) and nothing else in that file.
- [ ] Rework `packages/toolkit/src/crawl4ai.ts`: emit `crawl4ai_request_shape` before dispatch, emit the call outcome with duration afterwards, and replace the raw transport-error `process.stderr.write`.
- [ ] Build the local Crawl4AI MCP stand-in test helper described in *Test fixture* (a `node:http` server on an ephemeral port serving `SSEServerTransport` with per-test settable replies for `crawl`, `md`, `screenshot`, `pdf`, `execute_js`), reached through a dynamic `await import()` of the toolkit after `CRAWL4AI_URL` is set. No dependency, no DI seam.
- [ ] Add the toolkit scenario tests: JSON validity, the uniform outcome vocabulary, operation fields, the **table-driven all-nine-tools wrapping-and-unchanged-payload scenario driven from `functionMap`**, SearXNG attribution and fan-out labelling, `search_complete` outcomes, the context-free correlation scenario, Crawl4AI target-URL sanitization on all three paths, multi-URL `targetUrlCount`, request ID in error text, concurrent-call attribution, and the argument-shape redaction test (setting `PROXY_*` and a closed-port `CRAWL4AI_URL` at the top of the test file, before importing the toolkit, so each `node --test` file process gets its own `Config`).
- [ ] Add the API scenario tests: request-ID adoption/minting/sanitization, the `http_request` record's fields, the auth-rejected-request-is-logged scenario, and the API-key redaction test.
- [ ] Confirm by diff inspection that the request-logging middleware is mounted after `express.json()` and before the auth middleware in `packages/api/src/index.ts`, and that `/health`, the auth middleware, `keyMatches`, and the Crawl4AI payload construction are unchanged.
- [ ] Add the CLI scenario test: no log record on stdout, existing behavior unchanged.
- [ ] Run `pnpm build`, `pnpm typecheck`, `pnpm test`, and `pnpm format`; confirm the Dockerfile scenario by inspection of the diff (or run `docker build .` if a build input changed).
