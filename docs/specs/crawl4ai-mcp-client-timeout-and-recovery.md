# Bound and recover the shared Crawl4AI MCP client

- **Status**: Draft
- **Task**: crawl4ai-mcp-client-timeout-and-recovery
- **Last Updated**: 2026-07-22
- **Document Scope**: One unit of work: give every Crawl4AI `callTool` an explicit, configurable timeout above the toolkit's own crawl budget, close whatever the shared client discards, stop a rejected `connecting` promise from latching permanently, and add one bounded reconnect-and-retry for the connection-level failure class.

---

## Goal

Production logged two `MCP error -32001: Request timed out` failures against Crawl4AI on 2026-07-18 (deployment `377406fe`). `packages/toolkit/src/crawl4ai.ts`'s shared MCP client has four compounding defects:

1. No explicit per-`callTool` `timeout`, so the SDK's `DEFAULT_REQUEST_TIMEOUT_MSEC` (60s) applies — below the ~135s budget `web_fetch` itself asks Crawl4AI for (`page_timeout: 120000` + `delay_before_return_html: 15s` default).
2. `call()`'s catch discards the shared client (`client = null; connecting = null;`) without ever calling `close()`, so a discarded-but-still-live transport's SSE connection is never released.
3. `getClient()`'s connect-attempt IIFE has no top-level `catch`. When `c.connect(transport)` rejects for a reason that fires neither `onerror` nor `onclose` (an `initialize`-phase failure — a timeout, a protocol error, or an auth rejection with no `authProvider` configured), the module-level `connecting` variable keeps pointing at that now-permanently-rejected promise. Every later `getClient()` call returns the same dead promise until the process restarts.
4. No bounded retry for the connection-level failure class, even though `docs/ARCHITECTURE.md`'s Failure Model permits bounded retries for operations known to be safe.

**Change**: give every `callTool` an explicit `timeout` sourced from a new configurable setting; make `getClient()`'s own connect attempt self-heal on rejection (closing what it built and clearing shared state before the rejection reaches any caller); rework `call()` so a connection-level failure (failing to obtain a connected client) gets one bounded retry with a fresh client, while an operation-level failure (the `callTool` request itself rejecting, including a timeout) is surfaced directly with no retry and no discard.

**Value**: a `web_fetch` that legitimately needs more than 60s (and less than the new configured ceiling) succeeds instead of always failing client-side; the process stops leaking SSE connections/sessions on failure; a single bad `initialize` handshake stops wedging all five Crawl4AI tools for the process lifetime; a cheap, safe connect retry absorbs a transient connection hiccup without ever re-running the tool call itself (so it cannot compound with a future crawl-level retry on the same logical request).

### Non-goals

- Crawl4AI service-side configuration, `packages/toolkit/src/rotation.ts`, SearXNG, or any health-check change (`readiness.ts`, `probeCrawl4AI`'s own contract) — additive use of the existing `resetClient()` helper only, no change to its signature or its callers in `readiness.ts`/`probeCrawl4AI`.
- Per-call correlation logging (request ID, target host, duration, outcome) as its own new format — owned by `request-correlation-logging`. This unit continues to call the already-landed `logEvent`/`logOperation` helpers exactly as `call()` already does; no new log schema.
- Crawl-semantics retries (navigation timeout, HTTP 429, HTTP 503) — owned by `retry-transient-crawl-failures`. This unit's retry is scoped strictly to the *connect* step (`getClient()`), never to the `callTool` operation itself, so the tool call happens at most once per `call()` invocation regardless of how the connect step behaves. This is what keeps the two retry layers from multiplying: a future crawl-level retry composes with "this call attempted a connect twice, the tool once," not "this call ran the tool twice."
- `AbortSignal` plumbing — owned by `request-lifecycle-abort-propagation`. The SDK's `RequestOptions.timeout` this unit adds is a sibling field to `RequestOptions.signal` on the same options object, so a future `signal` can be added alongside it with no shape change.
- Clamping or validating a caller-supplied `web_fetch` `delay` parameter — the 135s reference budget is the toolkit's *own* default recipe (`functions.ts`'s `wait_until/page_timeout/delay_before_return_html`), which is what the card's acceptance criteria measure against. A caller-supplied `delay` can already push the real request past that budget; that is pre-existing behavior and out of scope here.

## Design

### 1. Config: a new, configurable call timeout

`packages/toolkit/src/config.ts` gains one optional env var and one exported constant:

```ts
CRAWL4AI_CALL_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
```

```ts
// Exported so call sites and tests can reference the exact default without
// re-deriving it. Must stay strictly greater than the largest crawl budget
// the toolkit itself requests: functions.ts's web_fetch asks Crawl4AI for
// page_timeout: 120_000 plus the default delay_before_return_html of 15s
// (120_000 + 15_000 = 135_000ms). 150_000ms leaves a comfortable margin
// while still bounding a single call, per ARCHITECTURE.md's Failure Model.
export const DEFAULT_CRAWL4AI_CALL_TIMEOUT_MS = 150_000;
```

`Config.crawl4ai.callTimeoutMs = env.CRAWL4AI_CALL_TIMEOUT_MS ?? DEFAULT_CRAWL4AI_CALL_TIMEOUT_MS;`

A test asserts `Config.crawl4ai.callTimeoutMs > 135_000` (the 120_000 + 15_000 figure transcribed from `functions.ts`, mirroring the existing convention in `crawl4ai.test.ts` that transcribes the forbidden-field lists from `ARCHITECTURE.md` rather than importing them).

### 2. `getClient()`: self-healing connect

Wrap the existing `await c.connect(transport)` call in its own `try`/`catch`. On rejection: `await resetClient(transport); throw err;` before the outer IIFE settles. `resetClient()` (already defined in this file, added by `health-liveness-readiness-split`) is ownership-guarded (`transport === activeTransport`) and idempotent, so:

- The `connecting` variable is guaranteed clear by the time any caller's rejection handler runs — a subsequent `getClient()` call always attempts a fresh connect. This closes root cause 3 directly: the specific failure mode the card names (an `initialize`-phase rejection with no transport-level `onerror`/`onclose`) has no other cleanup path today.
- Whatever the failed attempt built (a possibly-half-open transport) gets `close()`d best-effort, rather than orphaned. This is the only new call to `resetClient()` this unit adds inside `getClient()` itself; `transport.onerror`/`onclose` already call it for the transport-level failure shapes documented in their existing comments, and `probeCrawl4AI` already calls it for its own two failure branches. No existing caller's behavior changes.

This part is intentionally the smallest possible fix: `getClient()`'s own promise now can never settle rejected while leaving shared state dirty, regardless of who is awaiting it (`call()`, `probeCrawl4AI`, or a future caller).

### 3. `call()`: explicit timeout, connect-level retry, no operation-level discard

Split the current single `try { getClient(); calTool(); } catch { discard; }` into two phases with different failure semantics, mirroring the distinction `probeCrawl4AI` already draws between its connect step and its `tools/list` step (documented at length in that function's own docstring):

```ts
const MAX_CONNECT_ATTEMPTS = 2; // one attempt, one bounded retry

async function getClientWithRetry(): Promise<Client> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= MAX_CONNECT_ATTEMPTS; attempt++) {
    try {
      return await getClient();
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}
```

`call()`:

1. Unchanged: emit `crawl4ai_request_shape`, then `normalizeCrawl4AIArgs(args)` outside any try (a local validation rejection is not a dispatch failure — existing comment already explains this).
2. `const c = await getClientWithRetry()`. A rejection here is the **connection-level failure class**: `getClient()` retried once against a fresh attempt (guaranteed fresh by part 2 above) and still failed. Log the existing `crawl4ai_dispatch` error record and rethrow — no discard call is needed here because `getClient()`'s own cleanup (part 2) already closed and cleared whatever the failed attempt(s) built.
3. `const result = await c.callTool({ name, arguments: normalizedArgs }, undefined, { timeout: Config.crawl4ai.callTimeoutMs })`. A rejection here is the **operation-level failure class** — this closes acceptance criterion 1 (explicit timeout on every `callTool`). Log the existing `crawl4ai_dispatch` error record and rethrow, **without touching `client`/`connecting`/`activeTransport`**.

### Why operation-level failures must not discard the shared client

This is the one departure from "keep looking like the old code" worth spelling out, because it is also what fixes the leak (root cause 2) without reintroducing the concurrency hazard the card's own acceptance criteria call out.

- `Client._onclose()` (the MCP SDK, confirmed by reading `dist/esm/shared/protocol.js`) rejects **every** in-flight request on that client when the transport closes. So closing the shared transport for one call's operation failure would abort every other concurrent `call()` sharing it — the exact blast radius `transport.onerror`'s existing `SseError`-only gate (in this same file) already goes out of its way to avoid for a failed tool-call POST.
- Conversely, `getClient()` only ever creates a *new* transport when `client` is falsy (`if (client) return client;`). So the only way to leak a connection on an operation-level failure is to null `client` while the transport itself is still healthy — forcing a needless reconnect next time, and leaving the just-abandoned (but still-open) transport with nothing to close it. That reconnect-without-close is exactly root cause 2's leak.
- Therefore: **not discarding on an operation-level failure is the fix**, not "discard, but close first." An operation-level failure (an `McpError`, including `RequestTimeout`, or a `send()`-level plain `Error`) does not, by itself, prove the shared connection is unusable for other concurrent callers — the same reasoning already documented for `transport.onerror`'s gate and for `probeCrawl4AI`'s `tools/list`-failure branch. If the transport genuinely died, `transport.onerror`/`onclose` (SseError case) or a future caller's own connect failure will discover and clean it up; this unit does not need a second, redundant path for that.
- A timeout of the upstream operation is a strict subset of "operation-level failure" — it gets no special-cased retry logic beyond "don't discard, don't retry," which is what the loop above already does uniformly for every `callTool` rejection.

### Coordination with `retry-transient-crawl-failures`

`callTool` is invoked **at most once** per `call()` invocation, regardless of how many times `getClientWithRetry()` had to retry the connect step. A future crawl-level retry (owned by the sibling card) that wraps `call()` itself would therefore see, in the worst case, **(1 + `retry-transient-crawl-failures`'s own retry count) × (1 connect attempt on average, up to 2 on a connection hiccup)** — the two retry counts add, they do not multiply, because this unit's retry never re-invokes the tool. Whichever of the two cards lands second must restate this combined bound in its own spec once both are known; this spec only establishes this unit's own contribution to it (at most one extra connect attempt, zero extra tool invocations).

### Consequence for existing tests: two `crawl4ai-probe.test.ts` scenarios become unconstructable

`crawl4ai-probe.test.ts` (added by `health-liveness-readiness-split`) has two tests — "a probe abandoned mid-request does not reset a newer round's transport once a fresh connect has already replaced it" and "a superseded transport's late onclose does not clear the shared state its replacement owns" — whose own comments already flag that they rely on `call()`'s *pre-fix* behavior ("`call()`'s own catch ... nulls the shared `client`/`connecting` on any rejection without closing ... — tracked as a known gap") as their **setup mechanism**: they use a `callCrawlTool` operation-level failure to silently move the module's `client` pointer off a still-fully-open, still-answerable transport, so they can then prove a *stale* reference to it doesn't corrupt whatever replaced it.

Once `call()` no longer discards on an operation-level failure, that setup step no longer moves the pointer at all — `client` stays cached on the healthy transport, so no replacement is ever created, so there is nothing "stale" to test. This is not a coincidental casualty; it is the direct, intended consequence of eliminating the "silently discarded but still-open" state those two tests were exploiting. The *general* ownership-guard defense they were layered on top of (`resetClient()`'s `transport === activeTransport` check) remains fully covered by two sibling tests in the same file that construct the race through means unrelated to `call()`'s bug: "two probes racing the same failing connect share one connect attempt" (a genuine concurrent-connect race) and "an established connection dropped by the server is closed, not merely dereferenced" (a genuine server-side drop). Those two are unmodified by this unit.

This unit removes the two now-unconstructable tests, replacing them with a short comment recording why (linking back to this spec) rather than leaving them silently rewritten to assert something they no longer exercise. A third existing test in the same file, "onerror does not close the transport for a failed tool-call POST", has its final assertion updated: it currently expects the *next* probe to reconnect ("`call()`'s catch nulled `client`/`connecting`, independent of this fix"); after this fix that reconnect no longer happens (the fix this unit makes), so the updated assertion is that the next probe *reuses* the existing connection. The rest of that test (a failed tool-call POST must not close the shared transport) is unchanged and still passes unmodified.

### New tests (this unit)

A new `packages/toolkit/src/crawl4ai-call.test.ts`, following the existing fake-MCP-server pattern in `crawl4ai-probe.test.ts` (a minimal `node:http` + `SSEServerTransport` stand-in, `mode`-driven), covering:

1. **Timeout budget**: a `crawl` tool that answers after ~700ms (a stand-in for "longer than the SDK's 60s default, shorter than the configured ceiling") with a short configured `CRAWL4AI_CALL_TIMEOUT_MS` succeeds — proving the explicit `timeout` argument actually reaches the SDK request, not just that a 150_000ms default exists. (Waiting out a literal 60s in a unit test is not proposed; the scenario proves the *mechanism* — an explicit, configurable, sub-default timeout that is actually honored — which is what the reproduction step is checking for.)
2. **Latched connection, corrected**: a fake that accepts `GET /mcp/sse` but never answers `initialize` (so neither `onerror` nor `onclose` fires) causes the first `call()` to fail; a second `call()` immediately after makes a genuinely fresh connect attempt (counted at the fake), and once the fake starts answering, that second attempt (or a subsequent one) succeeds.
3. **Close-on-discard**: the same latched-connection fake, instrumented to detect whether the client-side transport's `close()` was invoked (patching `SSEClientTransport.prototype.close`, the same technique `crawl4ai-probe.test.ts`'s close-error test already uses) — asserts it was called after the connection-level failure.
4. **Bounded retry, exactly once**: a fake whose `GET /mcp/sse` always fails the same way — asserts the server sees exactly 2 connect attempts (1 + 1 retry) for one `call()` invocation, and the call still ultimately rejects (not an infinite retry).
5. **No retry on an upstream `RequestTimeout`**: a fake that connects successfully but never answers `tools/call` — asserts exactly one `tools/call` was sent (or that the SDK's own `RequestTimeout` surfaces and no second connect/call attempt follows).
6. **Concurrency unaffected**: two concurrent `callCrawlTool`/`callMdTool` calls sharing one connection; one is made to fail at the `tools/call` level (a JSON-RPC error reply) while the other is still pending; asserts the second still resolves normally.
7. **No leak across N operation-level failures**: N sequential calls that each fail at the `tools/call` level; asserts the fake sees exactly one `GET /mcp/sse` connect for all N (the leak reproduction step, satisfied because there is no reconnect at all for this failure class, not merely because whatever reconnects get properly closed).

## Boundary

**May change**: `packages/toolkit/src/crawl4ai.ts`, `packages/toolkit/src/config.ts`, `packages/toolkit/src/crawl4ai-probe.test.ts` (the two removals and one assertion fix described above, only), a new `packages/toolkit/src/crawl4ai-call.test.ts`, plus `docs/ARCHITECTURE.md` (docs pass, not the implementing coder).

**Must not change**: `packages/toolkit/src/functions.ts`, `packages/toolkit/src/rotation.ts`, `packages/toolkit/src/readiness.ts`, `probeCrawl4AI`'s signature or contract, `resetClient()`'s signature, any other existing `*.test.ts` file, `packages/api`, `packages/cli`, any `tsconfig*`, `package.json`.

## Requirements

### Requirement: Every `callTool` carries an explicit, configurable timeout

#### Scenario: A call exceeding the SDK's 60s default but under the configured ceiling succeeds

- **WHEN** the upstream Crawl4AI `crawl` tool takes longer than 60 seconds but less than `Config.crawl4ai.callTimeoutMs`
- **THEN** `callCrawlTool` resolves normally instead of rejecting with `MCP error -32001: Request timed out`

#### Scenario: The default ceiling exceeds the toolkit's own crawl budget

- **WHEN** `Config` is loaded with no `CRAWL4AI_CALL_TIMEOUT_MS` set
- **THEN** `Config.crawl4ai.callTimeoutMs` is greater than 135,000 (the `web_fetch` default budget: 120,000ms `page_timeout` + 15,000ms default `delay_before_return_html`)

#### Scenario: The ceiling is configurable

- **WHEN** `CRAWL4AI_CALL_TIMEOUT_MS` is set in the environment
- **THEN** `Config.crawl4ai.callTimeoutMs` reflects that value

### Requirement: A discarded client is always closed

#### Scenario: A connection-level failure closes what it built

- **WHEN** `getClient()`'s connect attempt fails (the `c.connect(transport)` call rejects)
- **THEN** the transport it constructed has `close()` invoked on it before the failure reaches any caller

### Requirement: A rejected `connecting` promise never latches

#### Scenario: A stalled `initialize` handshake does not wedge later calls

- **WHEN** a peer accepts the SSE connection but never answers `initialize` (no transport-level `onerror`/`onclose` fires), and a first call fails against it
- **THEN** a subsequent call attempts a genuinely fresh connection rather than reusing the same rejected promise

### Requirement: One bounded retry for a connection-level failure, never for an operation-level one

#### Scenario: A connection-level failure is retried exactly once

- **WHEN** the connect step fails
- **THEN** exactly one additional connect attempt is made (two total) before the error surfaces to the caller

#### Scenario: An upstream operation timeout is not retried

- **WHEN** `callTool` itself rejects with `ErrorCode.RequestTimeout`
- **THEN** no additional connect attempt or tool-call attempt follows; the error surfaces directly

### Requirement: Concurrent calls are unaffected by one call's failure

#### Scenario: One call's operation-level failure does not disturb a concurrent call

- **WHEN** two calls are in flight on the shared client and one fails at the `tools/call` level
- **THEN** the other still resolves normally

### Requirement: Repeated operation-level failures do not leak connections

#### Scenario: N failing calls open at most one connection

- **WHEN** a `crawl` tool call fails at the `tools/call` level N times in a row
- **THEN** the number of SSE connections opened to the stub stays at one, not N

## Tasks

- [ ] Add `CRAWL4AI_CALL_TIMEOUT_MS` and `DEFAULT_CRAWL4AI_CALL_TIMEOUT_MS` to `packages/toolkit/src/config.ts`
- [ ] Wrap `getClient()`'s `c.connect(transport)` in a `try`/`catch` that routes through `resetClient()` before rethrowing
- [ ] Rework `call()`: `getClientWithRetry()` (bounded to `MAX_CONNECT_ATTEMPTS`), explicit `timeout` on `callTool`, no discard on an operation-level failure
- [ ] Update the stale comment in `crawl4ai.ts` attributing the "known gap" to the wrong sibling story
- [ ] Remove the two now-unconstructable `crawl4ai-probe.test.ts` scenarios; fix the third's reconnect assertion
- [ ] Add `packages/toolkit/src/crawl4ai-call.test.ts` covering the seven scenarios above
- [ ] `pnpm build`, `pnpm typecheck`, `pnpm test` all pass
- [ ] Fold durable design content into `docs/ARCHITECTURE.md`; remove this spec
