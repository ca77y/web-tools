---
type: story
title: Fix MCP request close handling and propagate client disconnect as an abort signal
---

# Fix MCP request close handling and propagate client disconnect as an abort signal

- [ ] Fix MCP request close handling and propagate client disconnect as an abort signal #bug 🔼 🆔 request-lifecycle-abort-propagation ⛔ request-correlation-logging
    - Phase: Phase 3 - Operable Service
    - Dependency note: the `⛔ request-correlation-logging` blocker applies only to the two acceptance criteria covering the structured request-completion log line, which reuse that story's shared logger and request ID. The close-listener ordering fix, the idempotent cleanup, and the abort-signal plumbing are all independent of it. If the logging story is delayed, the lead may land the leak fix first and follow up with the log line rather than holding a real resource leak behind a larger story.
    - Problem: the `POST /mcp` handler registers its close listener *after* awaiting the transport, emits an unactionable bare `Request closed` line, and never turns a client disconnect into cancellation of the in-flight SearXNG or Crawl4AI work. Production logs contain many identical, contextless `Request closed` lines that cannot be attributed to a request or an outcome.
    - Evidence - observed production log line, repeated verbatim many times with nothing to distinguish occurrences:

      ```text
      Request closed
      ```

    - Evidence - the current handler at `packages/api/src/index.ts:50-74` (verified at HEAD):

      ```ts
      app.post('/mcp', async (req: Request, res: Response) => {
        const server = createServer();
        try {
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
          });
          await server.connect(transport);
          await transport.handleRequest(req, res, req.body);

          res.on('close', () => {
            log('Request closed');
            transport.close();
            server.close();
          });
        } catch (error) {
          log('Error handling MCP request:', error);
          if (!res.headersSent) {
            res.status(500).json({
              jsonrpc: '2.0',
              error: { code: -32603, message: 'Internal server error' },
              id: null,
            });
          }
        }
      });
      ```

    - Three distinct defects in that block:
        - **Late listener registration.** `res.on('close', ...)` is registered only after `await transport.handleRequest(...)` resolves. `handleRequest` does not resolve until the response is finished or the request fails, so for any request where the client disconnects mid-flight the close event can fire before the listener is attached. When that happens `transport.close()` and `server.close()` never run, leaking the per-request MCP server and transport. The handler creates a fresh `createServer()` and `StreamableHTTPServerTransport` per request (`:51-55`), so the leak is per-request.
        - **Unactionable log line.** `log('Request closed')` carries no request ID, method, tool name, duration, completion state, or whether the close was a normal completion or a client cancellation. Normal successful completions and client aborts produce byte-identical lines, so the line cannot be counted, filtered, or alerted on.
        - **No abort propagation.** Nothing derived from the client disconnect reaches the toolkit. `searchSearXNG` builds its own timeout-only signal - `signal: AbortSignal.timeout(options.timeout * 1000)` at `packages/toolkit/src/searxng.ts:35` - with no caller-supplied signal, and `call()` in `packages/toolkit/src/crawl4ai.ts:46-55` passes no signal or timeout to `c.callTool(...)` at all. A client that disconnects during a long search or crawl leaves the full upstream fan-out running: one `web_search` starts `Config.parallelRequests` (default `3`, `packages/toolkit/src/config.ts:36`) simultaneous SearXNG requests, each of which fans out across many engines.
    - Reproduction:
        1. Start the stack and issue an authenticated `POST /mcp` JSON-RPC `tools/call` for `web_search` against a query slow enough to take several seconds.
        2. Kill the client connection before the response arrives (for example `curl --max-time 1`).
        3. Observe on stderr whether a `Request closed` line is emitted at all, and whether the SearXNG request logs continue after the client is gone.
        4. Repeat for `web_crawl` against a slow target to exercise the Crawl4AI path.
    - Expected behavior after the fix: the close listener is always attached before any work begins; the emitted line identifies the request, its method/tool, its duration, and whether it completed or was cancelled; and a client disconnect aborts the in-flight SearXNG and Crawl4AI work rather than letting it run to completion unobserved.
    - Scope:
        - Register the `res.on('close', ...)` listener before `await server.connect(transport)` and before `await transport.handleRequest(...)`, and make the cleanup idempotent so a normal completion followed by close does not double-close.
        - Replace the bare `Request closed` line with a structured request-completion line that distinguishes normal completion from client cancellation, reusing the shared structured logger and request ID delivered by story `request-correlation-logging`.
        - Thread an `AbortSignal` derived from the client connection from the API through the toolkit to the SearXNG and Crawl4AI clients: combine it with the existing `AbortSignal.timeout` in `packages/toolkit/src/searxng.ts:35`, and pass it to `c.callTool(...)` in `packages/toolkit/src/crawl4ai.ts:49`.
        - Provision a test runner if none exists yet. The repository currently has **no test framework**: there is no `test` script in the root `package.json` or any package `package.json`, no `*.test.ts` files anywhere under `packages/`, and no `vitest`/`jest` dependency. Several acceptance criteria below require tests, so adding a runner and a `test` script is part of this story unless a sibling story has already landed one.
        - Out of scope: adding an explicit call timeout or retry to the Crawl4AI client (owned by [`crawl4ai-mcp-client-timeout-and-recovery`](./crawl4ai-mcp-client-timeout-and-recovery.md)); changing the parallel-request fan-out count or cancelling losing SearXNG requests (owned by [`search-client-fanout-and-timeout-budget`](./search-client-fanout-and-timeout-budget.md)); health-check semantics; the REST `POST /api/v0/{tool}` path may be included only if the same signal plumbing covers it without extra contract change.
        - Coordination with sibling stories that touch the same two functions:
            - [`crawl4ai-mcp-client-timeout-and-recovery`](./crawl4ai-mcp-client-timeout-and-recovery.md) adds an explicit per-call timeout and bounded reconnect to the same `call()` function in `packages/toolkit/src/crawl4ai.ts:46-55`. The `AbortSignal` parameter added here must compose with that timeout, not replace it. Whichever story lands second adapts to the other's `call()` signature.
            - [`search-client-fanout-and-timeout-budget`](./search-client-fanout-and-timeout-budget.md) threads an `AbortController` through `fetchSearXNG` to cancel losing parallel requests, composing with the existing `AbortSignal.timeout` at `packages/toolkit/src/searxng.ts:35`. That is a *different signal source* from the caller-disconnect signal added here. Once both stories land, `packages/toolkit/src/searxng.ts:35` must compose **three** sources: the existing `AbortSignal.timeout` request-timeout, the caller-disconnect signal added here, and that story's hedge-cancellation signal. Build the composition so it accepts an arbitrary set of signals (for example `AbortSignal.any([...])`) rather than hard-coding a two-way merge; any one firing must abort the request, none may clobber another, and the existing timeout must survive whichever story lands last.
    - Constraints:
        - [`../ARCHITECTURE.md`](../ARCHITECTURE.md) "Failure Model" states cancellation and timeout signals should propagate through the toolkit to provider clients where supported - this story implements that stated rule.
        - Provider-facing signal handling belongs in `packages/toolkit`; `packages/api` only supplies the signal. The CLI calls the toolkit directly and must keep working when no signal is supplied, so the signal parameter must be optional.
        - `packages/api/src/index.ts` also serves `GET /mcp` and `DELETE /mcp` as 405 responses (`:76-94`); leave those handlers unchanged.
    - Acceptance criteria:
        - The `res.on('close', ...)` listener in the `POST /mcp` handler is registered before the transport handles the request.
        - A client that disconnects mid-request still triggers `transport.close()` and `server.close()` exactly once, verified by a test that aborts the request in flight.
        - A normally completing request triggers transport and server cleanup exactly once, with no double-close error.
        - The bare `Request closed` string no longer appears in the codebase.
        - The request-completion log line carries the request ID, the HTTP method and path, the duration in milliseconds, and the invoked MCP method or tool name where known.
        - The request-completion log line distinguishes a normal completion from a client cancellation.
        - `searchSearXNG` accepts an optional caller `AbortSignal` and aborts its in-flight `fetch` calls when that signal fires, while still honouring the existing `Config.requestTimeout` timeout.
        - The Crawl4AI `call()` wrapper accepts an optional `AbortSignal` and passes it to `c.callTool(...)`.
        - A test asserts that a client disconnect during a `web_search` stops further SearXNG upstream requests rather than letting all parallel copies run to completion.
        - The CLI continues to work when no `AbortSignal` is supplied.
        - A test runner and a `test` script exist and run green (added by this story if no sibling story has already landed one).
        - The caller-disconnect signal composes with, rather than replaces, the existing `AbortSignal.timeout` in `packages/toolkit/src/searxng.ts:35`; a timeout still fires correctly when no caller signal is supplied.
        - `pnpm build` and `pnpm typecheck` pass.
    - References: [`../ARCHITECTURE.md`](../ARCHITECTURE.md) (Failure Model, Request Flows - MCP, Package Boundaries), [`../PRODUCT.md`](../PRODUCT.md) (Phase 1 "distinguish legitimate empty results from provider, proxy, timeout, cancellation ... failures"; Phase 3), `packages/api/src/index.ts`, `packages/toolkit/src/searxng.ts`, `packages/toolkit/src/crawl4ai.ts`, `packages/toolkit/src/config.ts`
