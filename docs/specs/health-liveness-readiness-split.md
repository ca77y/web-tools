# Split liveness from dependency readiness in health reporting

- **Status**: Draft
- **Task**: health-liveness-readiness-split
- **Last Updated**: 2026-07-21
- **Document Scope**: One unit of work: keep `GET /health` a pure liveness probe and add an authenticated `GET /ready` that reports bounded, cached dependency readiness for SearXNG and Crawl4AI.

---

## Goal

`GET /health` proves only that the Express process can answer an HTTP request. It stayed green throughout a production incident on the `Agentic-Search` Railway project in which every application SearXNG request timed out and multiple Crawl4AI MCP calls failed. Operators have no endpoint that distinguishes a healthy stack from a stack whose upstreams are all failing.

**Change**: leave `GET /health` exactly as deep as it is today (a dependency-free liveness answer) and add a new authenticated `GET /ready` that probes SearXNG and Crawl4AI concurrently, under an explicit per-probe timeout, behind a short result cache, and reports per-dependency status plus an aggregate rollup.

**Value**: an operator (or an external monitor) can tell "process alive" from "dependencies usable" without either signal being able to break the other.

### Critical constraint (non-negotiable)

The Railway service `Tools` (project `Agentic-Search`, environment `production`) has its **platform health check path configured as `/health`**. Railway uses it as both a deploy gate and an ongoing container check.

- `GET /health` MUST perform **no network I/O**.
- `GET /health` MUST return **HTTP 200 whenever the process is alive**, including when both dependencies are unreachable.
- `GET /health` MUST NOT gain any dependency state in its body.
- `/ready` MUST NOT be proposed or configured as a platform health check path.

Any change that makes `/health` depend on an upstream would restart-loop healthy containers and block deploys during an upstream outage. This constraint outranks every other consideration in this spec.

### Non-goals

- **Redis connectivity.** Web Tools has no Redis client or configuration; Redis exists only to support SearXNG. Redis failure is observable transitively through the SearXNG probe.
- **Proxy connectivity / exit-IP health.** See `docs/issues/proxy-exit-ip-health-unverifiable.md`.
- **Crawl4AI browser readiness.** MCP connectivity does not prove a browser launches. The optional `?deep=1` browser probe described on the card is explicitly **not** built here.
- **Changing Crawl4AI's own `/health`,** or changing the Railway health check path.
- **Any live Railway configuration change.** This unit is code and docs only.
- **Restructuring the logging helpers, the API-key middleware, or the memoised Crawl4AI client.** See *Coordination*.
- **A new test framework or test dependency.** The existing `node:test` setup is used as-is.

## Design

### Shape of the change

Three files change in `packages/toolkit`, one in `packages/api`, plus two new test files. No new runtime dependency.

```text
packages/toolkit/src/searxng.ts    (+) export probeSearXNG(timeoutMs)
packages/toolkit/src/crawl4ai.ts   (+) export probeCrawl4AI(timeoutMs)   [additive only]
packages/toolkit/src/readiness.ts  (new) checkReadiness(): concurrency, timeout race, TTL cache, rollup
packages/toolkit/src/index.ts      (+) re-export checkReadiness and its result types
packages/api/src/index.ts          (+) GET /ready route; comment on /health; export app and server
packages/toolkit/src/readiness.test.ts  (new)
packages/api/src/ready.test.ts          (new)
```

### Where each concern lives

Per `packages/CLAUDE.md`, provider protocol details stay inside toolkit provider clients and `packages/api` stays a thin adapter.

- **`searxng.ts` owns the SearXNG probe.** `probeSearXNG(timeoutMs)` issues one cheap HTTP `GET` to `${Config.searxng.url}/healthz` with `AbortSignal.timeout(timeoutMs)`. It does **not** run a user query.
  - **Verdict rule**: any HTTP response with `status < 500` counts as **reachable** (`ok`); `status >= 500` is `unhealthy` with detail `http_status:<code>`; a timeout is `unhealthy` with detail `timeout`; any other fetch rejection is `unhealthy` with detail `network_error`.
  - **Rationale for `< 500`**: this is a *reachability* probe, not a feature probe. `/healthz` exists on current SearXNG builds, but the deployed image tracks the rolling `searxng/searxng:latest` tag (`services/searxng/Dockerfile`), so the endpoint is not a version-pinned contract. A `404` still proves the SearXNG HTTP server accepted a connection and answered, which is exactly what the probe claims. Treating `404` as unhealthy would make the probe report a false outage on an image change. Do not "tighten" this to `res.ok` without replacing the rationale.
- **`crawl4ai.ts` owns the Crawl4AI probe.** `probeCrawl4AI(timeoutMs)` reuses the existing memoised `getClient()` and issues a cheap `tools/list` protocol call, passing `timeoutMs` as the MCP request timeout. It is exported as a purpose-named probe; the raw `Client` is **never** exported (`docs/PRODUCT.md` principle 3, "Provider details stay behind clients").
  - **Failure-state handling**: on a probe *rejection*, reset the module-level `client` and `connecting` to `null` so the next probe reconnects. This follows the intent of `call()`'s existing catch but is deliberately slightly wider: `call()` puts `await getClient()` *outside* its `try`, so a connect-level rejection is not reset there and relies on `transport.onerror`/`onclose` firing. `probeCrawl4AI` wraps both the connect and the `tools/list` call, so it also resets on a connect-level rejection. Do not "align" `call()` with this — that file belongs to a sibling story. On a probe *timeout*, do **not** touch that shared state: a connect that is still pending is left to settle on its own, and the existing `transport.onerror` / `transport.onclose` handlers already clear it on a real transport failure. Clearing shared state under a hung connect would abandon an in-flight SSE connection on every probe interval and leak connections for as long as the upstream hangs.
  - **Discriminating "timeout" from "rejection"** — this is exact, not a judgement call. An MCP request timeout surfaces as a *rejection* too (`client.listTools(..., { timeout })` rejects with an `McpError` whose code is `ErrorCode.RequestTimeout`), so "it rejected" alone is not the test. Classify as `timeout` **only** when either (a) the rejection is `err instanceof McpError && err.code === ErrorCode.RequestTimeout` (both imported from `@modelcontextprotocol/sdk/types.js`), or (b) `readiness.ts`'s own outer `Promise.race` bound fired first. Everything else — a rejected `getClient()` connect, a transport error, an unexpected throw — is a `rejection` and **does** reset `client`/`connecting`. Concretely: the `timeout` branch resets nothing; every other failure branch resets, matching `call()`'s existing precedent.
  - Details map to `timeout`, `network_error`, or `protocol_error`.
- **`readiness.ts` owns aggregation.** `checkReadiness()` runs both probes with `Promise.all`, times each with `performance.now()`, applies its **own** `Promise.race` timeout bound on top of each probe's native timeout (so a client that ignores its timeout argument still cannot hang the endpoint), caches the report, and computes the rollup. `checkReadiness()` never rejects: every probe outcome, including an unexpected throw, is classified.
- **`packages/api/src/index.ts` owns only the route.** The handler awaits `checkReadiness()` and sends the document with HTTP 200. No probing, no classification, no shaping in the API package.

### Amendment (post-integration-review): the probe must be able to close the transport it abandons

The integration review verified two production hazards against the vendored dependency source. Both invalidate the original "never touch `getClient()`" boundary, so this amendment supersedes it for one narrow purpose.

1. **Orphaned reconnect loops.** In `eventsource@3.0.7`, a *rejected* fetch (a refused connection — a stopped container, a dead Railway private-network host, a DNS failure) schedules an internal reconnect every ~3 s **forever**. `SSEClientTransport`'s error path never closes the EventSource. So resetting `client`/`connecting` on a probe rejection orphans a still-retrying loop, and the next probe round builds another. Under a sustained outage with a monitor polling `/ready`, orphans accumulate without bound and drive far more upstream traffic than the TTL cache exists to permit — routing around the very load bound the card requires. Note a *non-200 status* takes a different, terminal, leak-free path, which is why a 503 fixture cannot expose this.
2. **A wedged connect.** With no timeout on the connect itself and nothing to abort it, a hung upstream (the card's manual step 5) leaves `connecting` pending forever. `call()` awaits that same promise with no timeout of its own, so every Crawl4AI-backed tool hangs indefinitely and stays hung after the upstream recovers. Restart-only recovery.

**Authorized change** — the smallest one that fixes both, and nothing more:

- Keep a module-scope reference to the transport `getClient()` constructs.
- Add an internal `resetClient()` that best-effort closes that transport (swallowing any close error) and then nulls `client`, `connecting`, and the transport reference.
  - **Correction (verified against `eventsource@3.0.7`, supersedes an earlier claim in this section).** Closing stops the retry loop, which fixes hazard 1. It does **not** settle a wedged in-flight connect: `_onFetchError` skips both the reconnect and the `error` event when the error is an `AbortError`, and `close()` sets `readyState` to `CLOSED` so the reconnect returns early — and `SSEClientTransport` settles its connect only via that error event or the `endpoint` event. So a hung connect's promise stays pending forever. Hazard 2 is fixed by **nulling the shared state**, which is what unblocks every later caller of `call()`; a caller already awaiting the old promise at reset time still hangs. Do not restate the disproven claim.
- `probeCrawl4AI` calls `resetClient()` **only for a connect-step failure** (including a connect-level `timeout`), or when a mid-request failure is not an `McpError` and therefore means the transport itself broke. A `tools/list` `timeout` or `protocol_error` against an already-connected client must **not** reset: that client is live and shared, and tearing it down would abort concurrent `web_crawl` / `web_screenshot` / `web_pdf` / `web_execute_js` calls — letting the readiness signal break the thing it reports on. Leave the `timeout` / `protocol_error` / `network_error` classification itself unchanged.
- Guard every abandoned promise so a settled-after-abandonment connect cannot raise an unhandled rejection.

**Second amendment — transport ownership.** The re-review found that a single module-global transport reference is not enough, because a reset can act on a transport that is no longer the one it was called for:

- Give each connect attempt an **ownership token** (a generation counter or the transport reference itself) captured when the probe starts. `resetClient()` must close and null **only** if the captured transport is still the current one. Without this, a straggler probe abandoned by `readiness.ts`'s outer deadline can return up to ~3 s later and close the *next* round's healthy transport, and a late `onerror`/`onclose` from a superseded transport can null shared state belonging to its replacement.
- Route the existing `transport.onerror` / `transport.onclose` handlers through the same ownership-guarded close path. Today they null `client`/`connecting` **without closing the transport**, so an established connection that later drops (a Crawl4AI restart or crash) leaves `eventsource` retrying forever in the background, independent of any probe — the same hazard 1 leak by another route. `/ready` polling makes a long-lived client the steady state, so this now fires on every Crawl4AI restart, and on recovery leaves a ghost SSE stream holding an upstream slot for the process lifetime.

**Still out of bounds**: `call()`'s own control flow, the `callXTool` exports, the transport construction details, and any reformatting of pre-existing lines. `call()` remains unbounded when nothing polls `/ready`; that is pre-existing behaviour and a follow-up, not this unit's work.

**Test consequence**: because `resetClient()` now stops the retry loop, the leak that forced tests to simulate "Crawl4AI down" as a clean HTTP 503 is gone. At least one scenario per failure mode must exercise a genuinely **refused** connect (the production path) and the suite must still exit cleanly. A 503 fixture alone leaves both hazards untestable by construction.

#### Scenario: a straggler probe never resets a newer client

- **WHEN** a probe is abandoned by the readiness deadline, a later round connects successfully, and the abandoned probe then fails and attempts its reset
- **THEN** the newer round's transport is left open and usable, because the straggler's captured transport is no longer the current one

#### Scenario: a dropped established connection leaves no retrying loop

- **WHEN** an already-connected Crawl4AI SSE stream is dropped by the server (a restart or crash) with no probe in flight
- **THEN** the transport is closed rather than merely dereferenced, no background reconnect loop survives, and a later probe establishes exactly one new connection

#### Scenario: an outage does not accumulate reconnect loops

- **WHEN** Crawl4AI's port refuses connections and `checkReadiness()` runs repeatedly across several expired TTL windows
- **THEN** each round reports `crawl4ai` `unhealthy`, no abandoned transport remains open, the test process exits without a lingering handle, and connection attempts stay bounded by the TTL rather than growing per round

#### Scenario: a hung connect does not wedge the shared client

- **WHEN** a probe times out against an upstream that accepts the connection and then never responds, and the upstream subsequently recovers
- **THEN** the shared client state has been cleared rather than left pending, and a later probe reports `ok` without a process restart

### Constants

```ts
export const PROBE_TIMEOUT_MS = 3000;         // explicit, short; NOT Config.requestTimeout (15s)
export const READINESS_CACHE_TTL_MS = 5000;   // the card's stated maximum
```

`Config.requestTimeout` (15 s) is a per-search budget and is deliberately not reused: a health probe must answer far faster than a user query.

### Response contracts

`GET /health` — **body unchanged**, no new fields:

```json
{"status":"ok"}
```

Keeping the body byte-identical is deliberate: the smallest correct change, zero risk to the platform check, and no new surface in the file the `request-correlation-logging` story also edits. The route gains a comment recording the Railway constraint so a future reader does not "improve" it into a deep check.

`GET /ready` — always **HTTP 200**, authenticated:

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

- `dependencies.<name>.status` is `ok` or `unhealthy`. `detail` is present **only** when `unhealthy`.
- `detail` is drawn from a closed set: `timeout`, `network_error`, `protocol_error`, or `http_status:<code>`. It is **never** free-form upstream text, a URL, a header, or an exception message, so no configured URL, credential, or token can reach the body.
- `latency_ms` is a non-negative integer: the wall time that probe took, including a timed-out one.
- `checked_at` is the ISO-8601 timestamp of when the probes actually ran. A cached response therefore carries the older timestamp, which is how a caller sees staleness. No separate `cached` flag.
- Rollup: **all** dependencies `ok` → `ok`; **some but not all** `ok` → `degraded`; **none** `ok` → `unhealthy`.

**HTTP 200 even when unhealthy** is a deliberate contract from the card: monitors read dependency state from the body, never the status code. This keeps degraded state out of status-code space where a future misconfiguration could wire it to a platform restart trigger.

### Authentication

`/ready` requires the API key. The existing middleware in `packages/api/src/index.ts` already authenticates everything except the literal `/health` bypass, so `/ready` is authenticated **by doing nothing**: the bypass list is not touched, and neither is `keyMatches` or the middleware body. `/ready` exposes internal topology and dependency failure detail, so it follows `/stats`, not `/health`.

### Caching and concurrency

`checkReadiness()` keeps a module-level `{ report, cachedAt }` plus an in-flight promise.

- If `Date.now() - cachedAt < READINESS_CACHE_TTL_MS`, return the cached report without issuing any upstream request.
- If a probe run is already in flight, return that same promise (single-flight), so a burst of concurrent requests produces one upstream round of probes, not one per request.
- Otherwise run the probes, store the report with the current timestamp, and return it.

This makes upstream request volume bounded by the TTL, not by poll rate — the endpoint cannot become a load amplifier against SearXNG or Crawl4AI.

### Testability seam

`packages/api/src/index.ts` today cannot be imported by a test: it binds `PORT` and registers a SIGINT handler at module load. Two additive lines fix that without any test-only injection seam:

- `export const server = app.listen(PORT, ...)` (the existing call, bound to a name and exported).
- `export { app };`

A test sets `PORT=0` before a dynamic `import()`, reads the ephemeral port from `server.address()`, and closes the server in teardown. This is a plain module export, not dependency injection: production wiring is exercised exactly as it ships. This is what makes the auth, liveness, and end-to-end readiness scenarios below runnable against the **real** application rather than a re-declared stand-in.

### Boundary

**May change**: the seven files listed under *Shape of the change*, plus `docs/ARCHITECTURE.md` and `README.md` (docs, handled by the docs pass, not by the implementing coder).

**Must not change**: `packages/api/src/handler.ts`, `packages/api/src/mcp.ts`, the `log` helper or any logging call site, the API-key middleware body or its `/health` bypass, `keyMatches`, `call()` / the existing `callXTool` exports in `crawl4ai.ts` (additions only, no restructuring), and `getClient()` **except** for the narrow transport-reference and `resetClient()` change authorized by the amendment above, `searchSearXNG` and its helpers in `searxng.ts` (additions only), `Config` and its schema, `packages/cli`, every `tsconfig*`, `package.json`, the `Dockerfile`, and `docker-compose.yml`.

**Test scope**: new `*.test.ts` files may be added in `packages/toolkit/src/` and `packages/api/src/`; existing test files are not modified. Both packages already own a `test` script and a `tsconfig.test.json`, so every scenario below runs inside this boundary with no test-infrastructure change. In-test fake upstreams (a local Express SearXNG stand-in and a local MCP SSE server built from the already-installed `@modelcontextprotocol/sdk`) live inside the test files only — no production source gains a hook for them.

### Risks

- **Fake Crawl4AI MCP server in tests.** The "both dependencies reachable" scenario needs a real MCP SSE peer. `@modelcontextprotocol/sdk/server/sse.js` (`SSEServerTransport`) provides one, but the message POST route must not be pre-parsed by `express.json()` before `handlePostMessage` sees it, and the client resolves the message endpoint the server advertises. This is the fiddliest part of the unit. If it proves unworkable, report it as a finding — do **not** silently drop the scenario or replace it with an assertion that does not exercise a healthy Crawl4AI.
- **Test wall time.** Cache-expiry scenarios must wait `READINESS_CACHE_TTL_MS + a small margin`. Two such waits (~10 s total) are expected and acceptable; do not shorten them by weakening the TTL below what the card allows, and do not add a production knob to speed up tests.
- **Config is read at module load.** `Config` freezes `process.env` when the toolkit is first imported. Tests that need `SEARXNG_URL` / `CRAWL4AI_URL` pointed at fakes must set them **before** the first `import()` of anything that pulls in the toolkit, using a dynamic import. `node --test` runs each test file in its own process, so this is safe per file.

### Coordination

Three sibling stories are in flight and two touch files this unit touches. Keep every edit here strictly additive and scoped to health/readiness.

- **`request-correlation-logging`** edits `packages/api/src/index.ts` (the `log` helper at lines 17-21 and the auth middleware at 33-35), and will introduce a **single shared structured-logging helper in `packages/toolkit`** replacing the three duplicate `log` definitions. Therefore: this unit **adds no log lines at all** — the readiness signal is the response body, not stderr. Do not touch, move, or reuse `log`. If that story lands first, do not retrofit its helper here; that is its work, not this unit's.
- **`normalize-crawl4ai-config-payloads`** adds a payload-normalization helper inside `packages/toolkit/src/crawl4ai.ts` and reroutes `callCrawlTool`. Therefore: append `probeCrawl4AI` to that file without reordering, rewrapping, or reformatting `call()` or the existing tool exports, so both diffs merge cleanly. The amendment above authorizes a small, additive change *inside* `getClient()` (a transport reference plus `resetClient()`); keep it to added lines so the sibling diff still applies, and accept a resolvable conflict there rather than shipping the two verified hazards — correctness outranks merge convenience, and this is flagged on the PR.
- **`align-compose-stack-with-deployed-images`** touches `docker-compose.yml`, which this unit does not.

### Documentation (owned, not dropped)

The card carries a documentation acceptance criterion: *"`docs/ARCHITECTURE.md` and `README.md` describe both endpoints and what each does and does not prove."* It is **not** the implementing coder's task and is deliberately absent from the Tasks checklist below, because this repository closes docs through a single story-level documentation pass run by the `writer` agent after the code is integrated and validated — the same pass that folds this spec into permanent docs and deletes it from `docs/specs/`. That pass is a required step of the story and is gated by its own audit; the story does not ship without it.

For that pass, the durable content this unit produces is:

- `docs/ARCHITECTURE.md` → **"Health And Statistics"**: replace the current sentence about `GET /health` with a statement of the split — `/health` proves only that the process can answer an HTTP request and deliberately performs no dependency I/O because it is Railway's configured platform health check path; `/ready` is the authenticated dependency probe, always answers HTTP 200 with the verdict in the body, bounds each probe by an explicit short timeout, caches for at most 5 s, and must never be configured as a platform health check path. State plainly what each does **not** prove (`/health` proves nothing about SearXNG, Crawl4AI, Redis, target sites, or Wayback; `/ready` proves MCP connectivity and SearXNG reachability, not that a browser can launch or that a search will return results).
- `docs/ARCHITECTURE.md` → the **`packages/api` bullet list**, which today reads only "Unauthenticated liveness response at `GET /health`": add the authenticated readiness bullet.
- `docs/ARCHITECTURE.md` → **"Authentication And Trust"**, which enumerates what requires authentication: add `/ready` alongside `/stats`.
- `README.md` → document both endpoints beside the existing `/stats` material, including that `/health` is unauthenticated and `/ready` requires the API key.

### Validation

- `pnpm build`, `pnpm typecheck`, and `pnpm test` at the repository root must pass, with the new tests in the suite.
- No `docker build` scenario is required: this unit changes no `build` script, no `tsconfig*`, and no file the `Dockerfile` or `docker-compose.yml` copies or names. `tsconfig.build.json` already excludes `**/*.test.ts`, so the new test files and their in-test fake servers cannot reach `dist/` or the production image. If the implementation finds it needs to change any of those files, that assumption is void — stop and report it, because the root scripts alone would not catch the breakage.
- The card's manual reproduction steps run against a local Docker Compose stack and are the operator-level confirmation, not automated tests. **Owner: the story lead**, executed after integration and before the PR is opened, as part of story acceptance — not the implementing coder's task and not a Tasks entry below. Steps 1-3 and 5-7 have automated in-process analogues in the scenarios above; step 4 (the platform never restarts the container) is inherently platform-level. If the environment cannot run the compose stack, the lead must report that criterion as unmet rather than assume it, and carry it as an explicit risk on the PR.

## Requirements

### Requirement: `/health` stays a pure liveness probe

#### Scenario: liveness answers while both dependencies are unreachable

- **WHEN** the real application is running with `SEARXNG_URL` and `CRAWL4AI_URL` pointed at addresses that refuse connections, and `GET /health` is requested with no API key
- **THEN** the response is HTTP 200 with body exactly `{"status":"ok"}`

#### Scenario: liveness performs no network I/O

- **WHEN** `globalThis.fetch` is replaced with a recording stub that fails any call, and `GET /health` is requested
- **THEN** the response is HTTP 200 **and** the stub recorded zero calls

#### Scenario: liveness carries no dependency state

- **WHEN** `GET /health` is requested while `GET /ready` reports at least one dependency `unhealthy`
- **THEN** the `/health` body still has exactly the key `status` with value `ok`, and no key naming a dependency

### Requirement: `/ready` reports per-dependency status and an aggregate rollup

#### Scenario: both dependencies reachable

- **WHEN** a local SearXNG stand-in answers `GET /healthz` with HTTP 200 and a local MCP SSE server answers `tools/list`, and `GET /ready` is requested with a valid API key
- **THEN** the response is HTTP 200, `status` is `ok`, `dependencies.searxng.status` and `dependencies.crawl4ai.status` are both `ok`, each has an integer `latency_ms >= 0`, neither has a `detail`, and `checked_at` parses as a valid ISO-8601 date

#### Scenario: SearXNG unreachable, Crawl4AI reachable

- **WHEN** the SearXNG stand-in is stopped so its port refuses connections, the MCP SSE server still answers, the cache TTL has elapsed, and `GET /ready` is requested with a valid API key
- **THEN** the response is HTTP 200, `dependencies.searxng.status` is `unhealthy` with `detail` `network_error`, `dependencies.crawl4ai.status` is `ok`, and the aggregate `status` is `degraded`

#### Scenario: SearXNG returns a server error

- **WHEN** the SearXNG probe's request returns HTTP 503
- **THEN** `dependencies.searxng.status` is `unhealthy` with `detail` `http_status:503`

#### Scenario: SearXNG answers a non-`/healthz` build

- **WHEN** the SearXNG probe's request returns HTTP 404
- **THEN** `dependencies.searxng.status` is `ok`, because the HTTP server answered

#### Scenario: Crawl4AI MCP unreachable

- **WHEN** the MCP SSE server is stopped so its port refuses connections, the cache TTL has elapsed, and `GET /ready` is requested with a valid API key
- **THEN** the response is HTTP 200, `dependencies.crawl4ai.status` is `unhealthy` with a `detail` from the closed set, and the aggregate `status` is `degraded` or `unhealthy` according to the SearXNG verdict

#### Scenario: no dependency reachable

- **WHEN** both probes fail
- **THEN** the aggregate `status` is `unhealthy` and the response is still HTTP 200

### Requirement: every probe is bounded by an explicit short timeout

#### Scenario: a hung dependency does not hang the response

- **WHEN** `globalThis.fetch` is stubbed with a promise that never settles and never honours its abort signal, and `checkReadiness()` is called
- **THEN** it resolves within `PROBE_TIMEOUT_MS` plus a small margin, with the affected dependency `unhealthy` and `detail` `timeout`

#### Scenario: a timeout is a verdict, not an error

- **WHEN** a probe times out
- **THEN** `checkReadiness()` resolves (never rejects) and the `/ready` response is HTTP 200 carrying the `unhealthy` verdict

#### Scenario: the probe budget is not the search budget

- **WHEN** `PROBE_TIMEOUT_MS` is read
- **THEN** it is at most 5000 and strictly less than `Config.requestTimeout * 1000`

### Requirement: probe results are cached with a bounded TTL

#### Scenario: repeated polling inside the TTL issues no upstream requests

- **WHEN** `checkReadiness()` has run once and is called five more times within `READINESS_CACHE_TTL_MS`
- **THEN** the recording fetch stub's call count is unchanged from after the first run, and every call returns a report with the same `checked_at`

#### Scenario: concurrent callers share one probe run

- **WHEN** six `checkReadiness()` calls are started simultaneously from a cold cache
- **THEN** exactly one round of upstream probe requests is issued and all six resolve to the same report

#### Scenario: the cache expires

- **WHEN** `checkReadiness()` is called again after `READINESS_CACHE_TTL_MS` has elapsed
- **THEN** a new round of upstream probe requests is issued and `checked_at` advances

#### Scenario: the TTL is within the card's bound

- **WHEN** `READINESS_CACHE_TTL_MS` is read
- **THEN** it is greater than zero and at most 5000

### Requirement: `/ready` requires authentication

#### Scenario: request without an API key

- **WHEN** `GET /ready` is requested against the real application with no `Authorization` header and no `api_key` query parameter
- **THEN** the response is HTTP 403 with an `error` of `forbidden`, and the body contains no dependency information

#### Scenario: request with a wrong API key

- **WHEN** `GET /ready` is requested with a bearer token that is not the configured key
- **THEN** the response is HTTP 403

#### Scenario: request with a valid API key

- **WHEN** `GET /ready` is requested with the configured key as a bearer token
- **THEN** the response is HTTP 200 with the readiness document

#### Scenario: the `/health` bypass is not widened

- **WHEN** the auth middleware's bypass is exercised
- **THEN** `GET /health` succeeds without a key while `GET /ready` does not

### Requirement: the readiness response leaks no secret

#### Scenario: no credential appears in the body

- **WHEN** `GET /ready` is requested with a valid API key while every probe is failing
- **THEN** the serialized response body contains neither the configured API key, nor the Crawl4AI API token, nor the substring `Bearer`, nor any proxy credential

#### Scenario: details stay in the closed set

- **WHEN** any dependency is reported `unhealthy`
- **THEN** its `detail` matches `^(timeout|network_error|protocol_error|http_status:\d{3})$`, so no upstream URL, header, or exception message can reach the caller

### Requirement: the probes do not disturb the existing provider clients

#### Scenario: existing search behaviour is unchanged

- **WHEN** `pnpm test` runs the pre-existing toolkit and API suites
- **THEN** every pre-existing test passes unmodified

#### Scenario: the raw MCP client stays private

- **WHEN** the toolkit's public exports are inspected
- **THEN** `getClient` and the `Client` instance are not among them, and only `probeCrawl4AI` / `checkReadiness` expose readiness

## Tasks

- [ ] Add `probeSearXNG(timeoutMs)` to `packages/toolkit/src/searxng.ts`: one `GET ${Config.searxng.url}/healthz` with `AbortSignal.timeout`, classified per the verdict rule, returning a safe outcome with no free-form upstream text.
- [ ] Append `probeCrawl4AI(timeoutMs)` to `packages/toolkit/src/crawl4ai.ts`: reuse `getClient()`, issue `tools/list` with the MCP request timeout, reset `client`/`connecting` on rejection only (not on timeout), and return a safe outcome. Do not reorder or reformat existing code in that file.
- [ ] Add `packages/toolkit/src/readiness.ts` with `PROBE_TIMEOUT_MS`, `READINESS_CACHE_TTL_MS`, the report types, and `checkReadiness()`: concurrent probes, per-probe `Promise.race` timeout bound, `latency_ms` timing, single-flight TTL cache, and the rollup. It must never reject.
- [ ] Re-export `checkReadiness`, the constants, and the report types from `packages/toolkit/src/index.ts`.
- [ ] Wire `app.get('/ready', ...)` in `packages/api/src/index.ts` returning HTTP 200 with the report; add the Railway-constraint comment above the unchanged `/health` route; name and export `server`, and export `app`. Change nothing else in that file.
- [ ] Add `packages/toolkit/src/readiness.test.ts` covering the timeout bound, the cache TTL and single-flight behaviour, the SearXNG verdict rule (200 / 404 / 503 / network error / timeout), the rollup values, and the closed detail set.
- [ ] Add `packages/api/src/ready.test.ts` that imports the real `index.ts` with `PORT=0` against local fake upstreams and covers `/health` liveness and no-I/O, `/ready` auth (missing, wrong, valid), the both-reachable aggregate, each dependency-down transition after TTL expiry, and the no-secret assertion.
- [ ] Run `pnpm build`, `pnpm typecheck`, and `pnpm test` at the repository root and confirm all pass.
- [ ] (**Not the coder's task** — story-level docs pass, see *Documentation* above) Update `docs/ARCHITECTURE.md` and `README.md` to describe both endpoints and what each does and does not prove, then fold this spec into permanent docs and remove it from `docs/specs/`.
