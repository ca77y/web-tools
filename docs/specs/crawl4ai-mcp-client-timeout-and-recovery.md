# Bound and recover the shared Crawl4AI MCP client

- **Status**: Draft
- **Task**: crawl4ai-mcp-client-timeout-and-recovery
- **Last Updated**: 2026-07-23
- **Document Scope**: The lifecycle correctness of the shared Crawl4AI MCP client in `packages/toolkit/src/crawl4ai.ts` — an explicit, configurable per-call timeout; close-on-discard; a guarded connect promise; and one bounded reconnect-and-retry for connection-level failures. Additive/corrective to `getClient()`/`call()` only; the config-normalization and ownership-token/`resetClient()`/`probeCrawl4AI()` machinery already in the file is preserved untouched.

---

## Goal

### Problem

Production Web Tools logged two call-level MCP timeouts against Crawl4AI on 2026-07-18 (`MCP error -32001: Request timed out`). The shared MCP client in `packages/toolkit/src/crawl4ai.ts` has four defects, all in `getClient()` and `call()`:

1. **Timeout budget inversion.** `call()` invokes `c.callTool({ name, arguments })` with no `RequestOptions`, so the SDK applies its 60 s `DEFAULT_REQUEST_TIMEOUT_MSEC`. But `web_fetch` (`functions.ts`) asks Crawl4AI for `page_timeout: 120000` plus `delay_before_return_html: 15` (s) — a worst case of ~135 s. Any target that legitimately needs more than 60 s fails client-side even when Crawl4AI would have succeeded.
2. **Client discarded without close (SSE/session leak).** `call()`'s catch runs the bare `client = null; connecting = null; throw err;`. It never closes the transport, so the underlying `SSEClientTransport` EventSource stays open to Crawl4AI and the server-side MCP session is never released. Every failure that reaches this path leaks one SSE connection for the life of the process.
3. **Rejected `connecting` promise can latch permanently.** `getClient()`'s IIFE has no `catch` around `await c.connect(transport)`. For an `initialize`-phase failure (transport connects, but the handshake times out / errors / rejects, firing no `onerror`/`onclose` because it is not an SSE-level failure), the IIFE rejects and nothing clears `connecting`. `getClient()` then returns that same rejected promise to every future caller, wedging all five Crawl4AI tools until the process restarts.
4. **No bounded retry of the failed operation.** After clearing state, `call()` rethrows. `docs/ARCHITECTURE.md` (Failure Model) permits bounded retries for safe operations, but the connection-level failure class is never retried.

### Proposed change

Rework the `getClient()`/`call()` lifecycle so that:

- Every `callTool` passes an explicit, configurable `timeout` via SDK `RequestOptions`, defaulting to a value that strictly exceeds the toolkit's largest crawl budget.
- A discarded client is closed through the existing ownership-guarded `resetClient(transport)` path, not dereferenced.
- `getClient()`'s connect step can never latch a rejected `connecting` promise.
- A **connection-level** failure is retried at most once against a freshly (re)established client, while an **operation-level** timeout/protocol error is surfaced without retry and without tearing down a live shared connection.

### User value

The Crawl4AI-backed tools (`web_fetch`, `web_crawl`, `web_screenshot`, `web_pdf`, `web_execute_js`, and `web_archive` via `callMdTool`) stop failing on legitimately slow targets, stop leaking SSE sessions on failure, self-heal after an `initialize`-phase failure instead of wedging until restart, and transparently survive a single connection-level blip.

### Non-goals

- No change to `normalizeCrawl4AIArgs` / config wrapping, the ownership-token / `resetClient()` machinery, `withConnectTimeout`, or `probeCrawl4AI` (health-check probe) — all preserved as-is.
- No health-check / readiness changes (`readiness.ts`, `probeCrawl4AI`).
- No change to `rotation.ts`, SearXNG, or Redis.
- No new logging format. This story keeps using the existing `logEvent`/`logOperation` helpers with their current call shape (per-call correlation logging is already merged and owned by `request-correlation-logging`).
- No crawl-semantics retries (navigation timeout, HTTP 429/503) — owned by `retry-transient-crawl-failures`.
- No `AbortSignal` plumbing — owned by `request-lifecycle-abort-propagation`; this story only ensures the timeout mechanism it adds is forward-compatible with a later `signal`.

## Design

### Boundary (files this spec may change)

- `packages/toolkit/src/crawl4ai.ts` — `getClient()` and `call()` only; everything else in the file is preserved.
- `packages/toolkit/src/config.ts` — add one env-backed field.
- Test files under `packages/toolkit/src/*.test.ts` — new or extended, exercising the two files above.

Every acceptance scenario below runs inside this Boundary: all behavior lives in `packages/toolkit/src/crawl4ai.ts` / `config.ts`, and all scenarios are exercised from `packages/toolkit/src/*.test.ts` against an in-process fake MCP SSE server (the pattern already established by `crawl4ai-probe.test.ts` and `crawl4ai-attribution.test.ts`) and via `process.env` + a cache-busting dynamic `import()` (the pattern already established for `Config`).

### Config field

Add a millisecond timeout, env-configurable through the zod `envSchema` exactly as `CRAWL4AI_URL` / `CRAWL4AI_API_TOKEN` are:

- **Env var**: `CRAWL4AI_CALL_TIMEOUT_MS`
- **zod**: `z.coerce.number().int().positive().default(150000)`
- **Exposed as**: `Config.crawl4ai.callTimeoutMs` (grouped with the existing `crawl4ai.url` / `crawl4ai.apiToken`, all Crawl4AI-specific; the card's "alongside `requestTimeout`" is honored by both living in the same `Config` object graph in `config.ts`).
- **Default value**: `150000` (150 s). The toolkit's largest crawl budget is `page_timeout: 120000` + `delay_before_return_html: 15` s = **135000 ms**; `150000` exceeds it by 15 s of headroom for SSE round-trip and extraction overhead.

**Do not reuse `Config.requestTimeout`.** That field is SearXNG-specific, is `15` (seconds, not ms), and is unrelated; conflating the two is a defect the auditor should reject.

### `call()` failure classification (the core of the design)

`call()` splits the attempt into two awaits, mirroring the two-branch precedent already proven in `probeCrawl4AI` (connect step vs `tools/list` step):

1. `const c = await getClient();`
2. `const result = await c.callTool({ name, arguments: normalizedArgs }, undefined, { timeout: Config.crawl4ai.callTimeoutMs });`

**SDK signature (must be exact).** The v1.26.0 `Client.callTool` signature is `callTool(params, resultSchema?, options?)` — **three** positional arguments, with `RequestOptions` in the **third** slot. The `timeout` therefore goes in the third argument, with `undefined` passed for the unused `resultSchema` second slot: `c.callTool({ name, arguments: normalizedArgs }, undefined, { timeout: Config.crawl4ai.callTimeoutMs })`. Passing the options object as the second argument would land it in the `resultSchema` slot and leave the real `options` `undefined` — reintroducing root cause 1 (the SDK's 60 s default) or failing `pnpm typecheck` on a type mismatch. Do **not** copy `probeCrawl4AI`'s `c.listTools(undefined, { timeout })` shape onto `callTool`: `listTools` has a different two-arg signature (`listTools(params?, options?)`), so its options sit in the second slot — that shape is wrong for `callTool`.

A thrown failure is classified **connection-level** vs **operation-level**:

- **Connection-level (reset + eligible for one retry):**
  - `getClient()` / `c.connect()` rejects (a connect failure, or an `initialize`-phase failure). The client was never established, so nothing else can be relying on it.
  - A failure of `callTool` that is **not** an `McpError` — a network/transport-level error, including an `SseError` (which extends `Error`, not `McpError`). The MCP protocol layer did not answer, so the transport itself is presumed broken. This is exactly `probeCrawl4AI`'s "not an `McpError` → the transport broke mid-request → reset" rule.
- **Operation-level (rethrow, no reset, no retry):**
  - A failure of `callTool` that **is** an `McpError`. This covers both `ErrorCode.RequestTimeout` (the operation was slow — a full-timeout answer the card explicitly forbids retrying, since a re-run is not a safe repeat) **and** any other protocol-code `McpError` (the server answered at the protocol layer, so the connection is live). Tearing down a live, shared connection over one bad exchange is the same blast-radius hazard `probeCrawl4AI`'s `tools/list` branch is careful to avoid; the shared `client` is left intact and reusable.

This classification resolves defect 2 (leak) and the "don't wrongly discard a live client" concern together: the connection-level branch closes the abandoned transport through the ownership-guarded `resetClient(transport)` (capturing `activeTransport` synchronously right after `getClient()` is invoked, exactly as `probeCrawl4AI` does), while the operation-level branch touches no shared state. The bare `client = null; connecting = null;` is removed.

Local validation failures (`Crawl4AIConfigError` from `normalizeCrawl4AIArgs`) are thrown **before** the try/attempt block, so they are outside the retry/reset scope entirely — unchanged from today.

### Bounded retry

On a **connection-level** failure only, `call()` re-establishes the client via `getClient()` and re-runs the **same** operation exactly once. The retry count is bounded to one: a second connection-level failure on the retry surfaces the retry's error to the caller (no third attempt). An **operation-level** failure is never retried. The retry re-runs the whole `getClient()` + `callTool` cycle so it always executes against a freshly reconnected client.

### `getClient()` connect guard

`getClient()`'s IIFE gains a guard around `await c.connect(transport)` so that a connect/`initialize`-phase rejection routes through the ownership-guarded `resetClient(transport)` (clearing `client`/`connecting`/`activeTransport` and closing the transport) before the rejection propagates. Because `activeTransport === transport` at that point (set synchronously before connect), the reset acts. Consequently `connecting` is never left holding a rejected promise, and the next `getClient()` — finding `client` and `connecting` both null — starts a genuinely fresh attempt. `resetClient`'s existing no-op-catch on the abandoned promise keeps the abandoned rejection from surfacing as an unhandled rejection.

### Concurrency

The shared single-flight `getClient()` and the ownership-token `resetClient()` already handle concurrent callers; this story does not serialize them. Two distinct concurrency guarantees matter for acceptance scenario 8, and they are genuinely different cases:

1. **Operation-level failure of one call (no shared-state change).** An `McpError` failure of one call leaves the shared `client` untouched (it is never reset), so a concurrent call on the same live transport is trivially unaffected and resolves normally with no retry.
2. **Connection-level failure of one call (shared client is cleared).** This is the card's literal wording — "one of them fails **and clears the shared client**". Because the toolkit deliberately shares **one** MCP session/transport across all concurrent callers (per-caller sessions are out of scope), a connection-level break that triggers `resetClient(transport)` inherently disrupts every in-flight request riding that transport — the sibling's own in-flight `callTool` will also fail at the connection level. What this story guarantees is that the disruption is **bounded and self-healing**, not that the sibling's in-flight request is immune to the shared transport closing:
   - The ownership token makes the second caller's `resetClient(oldTransport)` a **no-op** once a fresh connect has replaced the transport, so a stale reset can never close the retry's healthy transport.
   - Single-flight `getClient()` makes both callers' retries **converge on one** re-established connection rather than racing two.
   - Each caller's own bounded one-shot retry then re-runs its operation against that healthy connection, so **both callers ultimately resolve** — the connection-level failure of one does not corrupt shared state or wedge the sibling.

A failed/refused `send()` (the outgoing `POST /messages` for a tool request) throws a plain `Error` (not an `McpError`) and so is classified connection-level under the rule above — a network-level send failure gets the same reset-and-one-retry treatment. This is distinct from a JSON-RPC **error response** to a tool request, which the SDK surfaces as an `McpError` (operation-level, case 1).

### Forward-compatibility (AbortSignal)

SDK `RequestOptions` (the third `callTool` argument) already accepts both `timeout` and `signal`. Passing `{ timeout: Config.crawl4ai.callTimeoutMs }` today leaves the shape open for `request-lifecycle-abort-propagation` to later thread `{ timeout, signal }` through that same third argument with no rework — the timeout mechanism does not need to be ripped out when an abort signal is added.

### Combined worst-case latency (coordination with `retry-transient-crawl-failures`)

This story's retry fires **only** on a connection-level failure, and re-runs the operation **at most once**. A crawl-semantics failure (navigation timeout, HTTP 429/503) surfaces from Crawl4AI either as an `isError: true` result (which resolves, not throws) or as an `McpError` — neither is connection-level — so this story's retry does **not** stack multiplicatively with the future crawl-layer retry. Worst case for a single logical request once both stories ship: `(crawl-layer attempts × per-attempt crawl budget)` **plus at most one** additional connection re-establishment + operation cycle bounded by `Config.crawl4ai.callTimeoutMs` (default 150 s) — an additive term, never a multiplicative one. With today's single-attempt crawl layer, this story's own worst case is one failed connection-level attempt plus one full retry bounded by the configured call timeout.

### Coordination — shared `config.ts` edits

`config.ts`'s `envSchema` / `Config` object is edited by more than one in-flight story (any story adding its own env-backed knob). Add the new field by merging into the existing schema and object; if a sibling lands first and has already added fields, extend rather than replace them. The new `CRAWL4AI_CALL_TIMEOUT_MS` key does not collide with any sibling's knob (`retry-transient-crawl-failures` adds crawl-retry config; `request-lifecycle-abort-propagation` adds abort plumbing).

### Risks and alternatives

- **Retrying a non-idempotent operation.** All Crawl4AI tool operations are read-style fetches/renders; a connection-level retry re-runs one against a fresh connection, which is safe. A slow (`RequestTimeout`) operation is deliberately **not** retried, per the card, because a re-run after a full-timeout answer is not a safe repeat.
- **Alternative — reset the shared client on every `callTool` failure (including `McpError`).** Rejected: it would let one slow/protocol-erroring call tear down a connection other concurrent callers are using, breaking scenario 8 and contradicting `probeCrawl4AI`'s established "don't reset on an `McpError`" rule.

## Requirements

### Requirement: Explicit, configurable, budget-exceeding per-call timeout

Every `callTool` in `crawl4ai.ts` passes an explicit `timeout` via SDK `RequestOptions`, sourced from a configurable env var whose default strictly exceeds the toolkit's largest crawl budget.

#### Scenario: Every callTool passes the configured timeout

- **WHEN** `call()` dispatches any of the operations (`crawl`, `md`, `screenshot`, `pdf`, `execute_js`) to a fake MCP server that records the `RequestOptions` it receives
- **THEN** the `callTool` invocation passes the options in the third positional slot (`callTool(params, undefined, options)`) carrying a `timeout` equal to `Config.crawl4ai.callTimeoutMs`, and no `callTool` relies on the SDK's 60 s default

#### Scenario: The default call timeout exceeds the largest crawl budget

- **WHEN** `Config` is loaded with no `CRAWL4AI_CALL_TIMEOUT_MS` set in the environment
- **THEN** `Config.crawl4ai.callTimeoutMs` is `150000`, which is strictly greater than the toolkit's largest crawl budget of `120000` (`page_timeout`) + `15000` (`delay_before_return_html`) = `135000` ms

#### Scenario: The call timeout is overridable via the environment

- **WHEN** `CRAWL4AI_CALL_TIMEOUT_MS` is set to a specific value before `Config` is loaded
- **THEN** `Config.crawl4ai.callTimeoutMs` reflects that value (coerced to a positive integer) and that value is the `timeout` passed to `callTool`

#### Scenario: A slow operation under the configured timeout is governed by the configured value, not the 60 s default

- **WHEN** `CRAWL4AI_CALL_TIMEOUT_MS` is set to a small test value `T`, and a fake `crawl` tool answers after a delay that is comfortably under `T`
- **THEN** the call succeeds (resolves the tool result) rather than returning `MCP error -32001`, proving the operative bound is the configured value and not a hard-coded 60 s default
- **AND** the card's literal ">60 s but under the configured timeout" case is otherwise covered by inspection (see Deviations), because a unit test cannot wait 60 s

### Requirement: A discarded client is closed, never leaked

When a call fails at the connection level and the shared client is discarded, the transport is closed through `resetClient(transport)` so no SSE connection or Crawl4AI session leaks.

#### Scenario: A connection-level call failure closes the discarded transport

- **WHEN** a `call()` fails at the connection level (a `callTool` failure that is not an `McpError`, i.e. the transport broke) against a fake server, and the transport's `close()` is observable
- **THEN** `close()` is invoked on the discarded client's transport, and the shared `client`/`connecting`/`activeTransport` state is cleared

### Requirement: A rejected connect never latches the connecting promise

An `initialize`-phase connect failure that fires no transport callback does not leave a rejected promise in `connecting`; the next `getClient()` attempts a fresh connection.

#### Scenario: A subsequent getClient() after an initialize-phase failure reconnects and can succeed

- **WHEN** the first `getClient()` connect rejects after `transport.start()` succeeds (an `initialize`-phase failure) with no `onerror`/`onclose` firing, and then the upstream is made healthy
- **THEN** a subsequent `getClient()` (or `call()`) makes a genuinely new connection attempt and succeeds, rather than re-returning the earlier rejected promise

### Requirement: One bounded reconnect-and-retry for connection-level failures

A connection-level failure is retried at most once against a freshly re-established client before the error surfaces; an operation-level timeout is not retried.

#### Scenario: A connection-level failure is retried exactly once and then succeeds

- **WHEN** a fake server fails the first attempt at the connection level (transport broken / connect failure) and serves normally thereafter
- **THEN** `call()` re-establishes the client and re-runs the same operation exactly once, the operation ultimately resolves, and the number of underlying attempts is exactly two (one failure + one retry)

#### Scenario: A second connection-level failure on the retry surfaces without a third attempt

- **WHEN** a fake server fails both the first attempt and the retry at the connection level
- **THEN** `call()` surfaces the retry's error to the caller and makes no third attempt (the retry is bounded to exactly one)

#### Scenario: An operation RequestTimeout is not retried

- **WHEN** a fake `crawl` tool never answers so `callTool` rejects with an `McpError` whose code is `ErrorCode.RequestTimeout` (with `CRAWL4AI_CALL_TIMEOUT_MS` set low so the test is fast)
- **THEN** `call()` surfaces that error with exactly one `callTool` attempt (no retry), and the shared `client` is not reset (a live connection is not torn down by a slow operation)

### Requirement: Concurrent calls are not cross-contaminated by one failure

A failure of one concurrent call does not corrupt shared state or wedge another concurrent call; both callers reach a caller-visible resolution.

#### Scenario: An operation-level failure of one concurrent call leaves the other untouched

- **WHEN** two Crawl4AI calls run concurrently against one shared live client, one tool is answered with a JSON-RPC error (an operation-level `McpError`) and the other is answered normally
- **THEN** the failing call rejects (no retry, per the operation-level rule) while the other call resolves normally with no retry, and the shared client is not reset by the failure

#### Scenario: A connection-level failure affecting concurrent callers is bounded and self-healing — both resolve

- **WHEN** two Crawl4AI calls are concurrently in-flight on one shared transport, that shared transport is made to fail their in-flight requests at the connection level once (a network/transport-level error, e.g. a refused `send()`), and the upstream then serves normally
- **THEN** each caller's ownership-guarded `resetClient` acts or no-ops correctly (no stale reset closes a fresh transport), both callers' single-flight retries converge on one re-established connection, and **both calls ultimately resolve** — proving the shared-client clearing corrupts no state and wedges neither caller
- **AND** _(see Deviations: because one MCP session is shared across concurrent callers by design, "unaffected" is delivered as bounded self-healing recovery, not as immunity of an in-flight request to the shared transport closing)_

### Requirement: Validation passes

#### Scenario: Build and type-check succeed

- **WHEN** `pnpm build` and `pnpm typecheck` run at the repository root
- **THEN** both succeed

## Deviations from the card

- **AC "a `web_fetch` whose upstream takes longer than 60 s but less than the configured timeout now succeeds".** A unit test cannot wait 60 s, and a scaled test cannot reproduce "old code fails at 60 s, new code succeeds" without that wait. This criterion's intent is therefore satisfied by two coordinated scenarios rather than a real-time 60 s wait: (1) the inspection scenario proving every `callTool` passes an explicit `timeout === Config.crawl4ai.callTimeoutMs` in the third options slot and that the default (`150000`) strictly exceeds the 135 000 ms crawl budget — so the 60 s default is provably no longer the bound; and (2) the scaled boundary scenario proving a delayed answer is governed by the configured value, not a hard-coded 60 s. This is called out explicitly so the acceptance gate reads the criterion as represented, not silently narrowed.

- **AC "concurrent Crawl4AI calls are unaffected when one of them fails and clears the shared client".** The card's phrase "clears the shared client" describes a **connection-level** failure — the case where `resetClient(transport)` closes the shared transport. Because the toolkit shares **one** MCP session/transport across all concurrent callers (per-caller sessions are out of scope for this story), it is not literally true that a sibling's in-flight request is untouched when that shared transport is closed: the sibling's in-flight `callTool` is also disrupted. What is proven instead (the "connection-level" concurrency scenario above) is the honest and stronger-mattering guarantee: the disruption is **bounded and self-healing** — the ownership token prevents a stale reset from closing the retry's fresh transport, single-flight `getClient()` converges both retries on one re-established connection, and each caller's bounded one-shot retry lets **both callers ultimately resolve**, with no state corruption and no wedge. The purely "untouched, no retry" case is additionally covered for an **operation-level** failure (the companion scenario), where nothing shared changes. This substitution is flagged here so the acceptance gate reads AC #8 as represented — bounded recovery of both callers — rather than as an unstated narrowing.

## Residual risk (out of scope, acknowledged)

- **No toolkit-side ceiling on caller-supplied crawl budget.** The "`150000` exceeds the largest crawl budget" guarantee holds for **default / unoverridden** calls. `web_fetch`'s `delay` (`schemas.ts` ~lines 30-33) and `web_crawl`'s caller-supplied `crawler_config.page_timeout` / `delay_before_return_html` (`schemas.ts` ~lines 79, 83) have no toolkit-imposed upper bound, so a caller could request a crawl budget that exceeds `Config.crawl4ai.callTimeoutMs` and reproduce root cause 1 for that specific over-budget call. Clamping caller-supplied crawl parameters against the configured call timeout is **out of scope** for this story (it changes tool-input validation, not the client lifecycle) and is recorded here so the limitation is explicit rather than implied. A follow-up could clamp those inputs or raise the call timeout to bound them; either belongs to a separate card.

## Validation note (production consumer)

The root `Dockerfile` builds the toolkit by copying `packages/toolkit/src/` as a whole directory and running the package's own `build` script (`tsc -p tsconfig.build.json`) — the same compilation `pnpm build` performs. This story adds no new source file referenced by name in the `Dockerfile`, and changes no `build` script or `tsconfig*`. Therefore `pnpm build` / `pnpm typecheck` fully cover the production image's compilation of these changes; no separate `docker build` step is required for this task. (Recorded so the reasoning is explicit, not assumed.)

## Tasks

- [ ] Add `CRAWL4AI_CALL_TIMEOUT_MS` to `config.ts`'s zod `envSchema` (`z.coerce.number().int().positive().default(150000)`) and expose it as `Config.crawl4ai.callTimeoutMs`, merging into the existing schema/object rather than replacing sibling additions.
- [ ] In `call()`, pass `{ timeout: Config.crawl4ai.callTimeoutMs }` as the **third** positional `RequestOptions` argument on every `callTool` (`callTool(params, undefined, options)` — not the second slot, which is `resultSchema`).
- [ ] Rework `call()`'s catch into the connection-level vs operation-level classification: connection-level → `resetClient(transport)` (ownership token captured after `getClient()`) + one bounded retry of the same operation; operation-level (`McpError`, incl. `RequestTimeout`) → rethrow, no reset, no retry. Remove the bare `client = null; connecting = null;`.
- [ ] Guard `getClient()`'s IIFE connect step so a connect/`initialize`-phase rejection routes through `resetClient(transport)` before propagating, so `connecting` is never left latched.
- [ ] Add/extend tests in `packages/toolkit/src/*.test.ts` covering every scenario above, following the existing fake-MCP-SSE-server + cache-busting dynamic-`import()` patterns from `crawl4ai-probe.test.ts` / `crawl4ai-attribution.test.ts`. Ensure each test tears down its client (e.g. via `closeCrawl4AIClient()`) so the `node --test` process does not hang on the EventSource reconnect loop.
- [ ] Run `pnpm build` and `pnpm typecheck` at the repository root; both pass.
