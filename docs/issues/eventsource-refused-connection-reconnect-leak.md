# A refused SSE connection retries forever, and `SSEClientTransport` never closes it

**Status:** open, no fix available on our side — worked around in our own code; the upstream behaviour remains
**First recorded:** 2026-07-21
**Component:** `packages/toolkit/src/crawl4ai.ts` (the shared MCP client and `probeCrawl4AI`), via `@modelcontextprotocol/sdk` → `eventsource@3.0.7`

## Problem

Web Tools reaches Crawl4AI over MCP on an SSE transport — `packages/toolkit/src/crawl4ai.ts:23` builds `new URL('/mcp/sse', Config.crawl4ai.url)` and `:29-32` constructs the `SSEClientTransport`. Underneath the SDK, `eventsource@3.0.7` handles the stream (`pnpm-lock.yaml:464`, `:924`, pulled in by `@modelcontextprotocol/sdk`). Two failure shapes that look equivalent from our side take completely different code paths inside that library:

- **A refused connection** (a stopped container, a dead private-network host, a DNS failure) makes the fetch *reject*. `eventsource` treats that as retryable and schedules an internal reconnect roughly **every 3 seconds, forever**. `SSEClientTransport`'s error path surfaces the error but **never closes the EventSource**, so the retry loop survives the transport being dereferenced.
- **A non-200 HTTP status** (for example a clean `503`) takes a **terminal** path instead: no reconnect is scheduled, and nothing leaks.

The consequence is a trap for anyone probing this dependency. Merely nulling the shared `client` / `connecting` state on a probe failure — the obvious "reset and retry next time" reflex, and what this repository's `transport.onerror` / `onclose` handlers did before readiness probing existed — orphans a still-retrying EventSource. The next probe round builds another. With a monitor polling `GET /ready` through a sustained Crawl4AI outage, orphaned loops accumulate without bound and drive far more upstream traffic than the readiness TTL cache exists to permit, routing around the very load bound the endpoint was designed to respect.

## Why this is easy to miss, and how it was actually missed here

**Simulating "dependency down" as a clean HTTP 503 exercises a branch production essentially never takes.** A container that is down refuses connections; it does not politely answer `503`. During this story, tests that modelled Crawl4AI being unavailable with a 503 fixture were green while both of the following leaks were live and untested:

1. the orphaned reconnect-forever loop described above;
2. a wedged connect — with no timeout on the connect itself and nothing to abort it, a hung upstream leaves `connecting` pending forever, and every Crawl4AI-backed tool that awaits that same promise hangs indefinitely and stays hung even after the upstream recovers. Restart-only recovery.

A 503 fixture cannot expose either one, by construction. **Any test asserting behaviour under "dependency down" must include at least one scenario against a genuinely refused connection, and the test process must still exit cleanly** — a lingering handle at exit is the symptom.

## A disproven corollary, recorded so it is not re-derived

It is tempting to conclude that closing the transport fixes everything. It does not, and the difference matters:

- Closing the transport **does** stop the retry loop. That fixes leak 1.
- Closing the transport does **not** settle a wedged in-flight connect. `eventsource`'s `_onFetchError` skips both the reconnect *and* the `error` event when the error is an `AbortError`, and `close()` sets `readyState` to `CLOSED` so the reconnect returns early. `SSEClientTransport` settles its connect promise only via that `error` event or the `endpoint` event — so a hung connect's promise stays **pending forever**.

Leak 2 is therefore fixed by **clearing the shared client state**, not by the close: nulling `client` / `connecting` is what unblocks every later caller. A caller already awaiting the old promise at reset time still hangs. Do not restate the disproven "the close settles the connect" claim.

## What we do about it

`packages/toolkit/src/crawl4ai.ts:136-137` carries an ownership-guarded `resetClient(transport)` that best-effort closes the transport it was called for **and** clears `client` / `connecting` / `activeTransport` (`:7-16`) — but only when the passed transport is still the current one (the `transport !== activeTransport` guard at `:137`), so a straggler probe abandoned by the readiness deadline cannot close a newer round's healthy transport. `transport.onerror` at `:84-89` (gated on `err instanceof SseError` at `:86`, since the SDK funnels unrelated failures through the same callback) and `transport.onclose` at `:91-93` route through the same path, so an established stream that drops on a Crawl4AI restart is closed rather than merely dereferenced.

`probeCrawl4AI` (`:271`) splits its connect step and its `tools/list` request into two separate `catch` blocks (`:282` and `:298`) precisely so `resetClient()` runs only for a connect-step failure (`:290`) or a mid-request failure that is not an `McpError` (`:308`) — a `tools/list` timeout against an already-connected client must not tear down a transport shared with concurrent crawl, screenshot, PDF, and JavaScript-execution calls. The connect step itself is bounded by `withConnectTimeout` (`:189`, applied at `:281`), which is what stops a hung upstream from wedging `connecting`.

The gap this note originally flagged on `call()`'s own path — its catch nulled `client` / `connecting` directly, without closing anything or clearing `activeTransport`, on *every* failure including a merely operation-level one — is now closed by [`../tasks/crawl4ai-mcp-client-timeout-and-recovery.md`](../tasks/crawl4ai-mcp-client-timeout-and-recovery.md) (not `normalize-crawl4ai-config-payloads`, which this note previously misattributed it to; that story is unrelated config-payload work). `call()` now only discards shared state for a connection-level failure — routed through `getClient()`'s own self-healing `catch` around `c.connect()`, which always closes what it built before rethrowing — and never for an operation-level one, where the shared client may still be healthy and serving concurrent callers. See [`../ARCHITECTURE.md`](../ARCHITECTURE.md#crawl4ai-mcp-client-lifecycle) for the current contract.

That is a workaround in our code, not a fix. The upstream behaviour is unchanged and will re-bite any new code path that constructs an SSE transport, or that resets shared MCP state without closing what it abandons.

## Why no fix could be identified on our side

The behaviour lives in third-party code we do not own and do not want to fork:

- `eventsource@3.0.7`'s retry-forever-on-fetch-rejection policy is that library's documented reconnection model, not a bug we can report as one.
- `SSEClientTransport`'s omission of a `close()` on its error path is inside `@modelcontextprotocol/sdk`. Changing it means an upstream SDK change; pinning or patching the dependency would trade this hazard for a maintenance burden across every SDK upgrade.

Nothing in this repository can make a refused connection take the terminal path a non-200 status takes. The only durable protections are the ones we already apply — own the teardown, guard it by transport ownership, and test against refused connections rather than synthetic 503s.

## What would close this note

An upstream `@modelcontextprotocol/sdk` release whose SSE transport closes its EventSource on the error path, or an `eventsource` release that bounds its reconnect attempts. At that point re-check whether our ownership-guarded teardown is still load-bearing, and either simplify it or record why it stays.

## References

- `packages/toolkit/src/crawl4ai.ts` — shared state, `getClient()` (with its own self-healing `catch` around `c.connect()`), the transport handlers, `resetClient()`, `getClientWithRetry()`, `call()`, `withConnectTimeout()`, and `probeCrawl4AI()` with its two reset branches — line numbers omitted here since they shift with every story that touches this file; see the file itself and [`../ARCHITECTURE.md`](../ARCHITECTURE.md#crawl4ai-mcp-client-lifecycle) for the current contract
- `packages/toolkit/src/readiness.ts` — `withDeadline()` at `:60`, the outer bound that can abandon a probe, which is why teardown needs an ownership token
- `packages/toolkit/src/crawl4ai-probe.test.ts:74-76`, `:98`, `:228-229` — the `refused` fixture mode that destroys the socket on `GET /mcp/sse`, exercising the production path a 503 fixture cannot reach
- `pnpm-lock.yaml:464`, `:924` — the pinned `eventsource@3.0.7` and the SDK dependency that pulls it in
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — Health And Statistics (`GET /ready`)
- [`crawl4ai-mcp-unreachable-in-compose.md`](./crawl4ai-mcp-unreachable-in-compose.md) — why the local stack cannot currently exercise this against a real Crawl4AI
