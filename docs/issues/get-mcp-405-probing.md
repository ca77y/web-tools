# Unexplained repeated `GET /mcp` 405 responses

**Status:** open, no solution identified on our side
**First recorded:** 2026-07-12 · **Last recorded:** 2026-07-18
**Component:** `packages/api` (`GET /mcp` handler)

## Problem

The hosting platform's HTTP logs retained 52 responses of this shape between 2026-07-12 and 2026-07-18:

```text
GET /mcp 405 1ms
```

Examples with timestamps:

```text
[2026-07-12T07:04:09.634700255Z] GET /mcp 405 9ms
[2026-07-18T23:45:24.211636569Z] GET /mcp 405 3ms
```

The 52 count is a lower bound: the log query was capped at 1,000 retained records, so earlier or additional occurrences may not have been retained.

These requests do no damage — they are rejected in single-digit milliseconds — but they inflate the service's HTTP error-rate metric, which makes that metric unusable as a health signal. An operator watching error rate cannot tell this steady background 405 traffic from a real client regression.

## Current behavior is intentional

The 405 is deliberate, not a bug. `packages/api/src/index.ts:76-84` (verified at HEAD):

```ts
app.get('/mcp', async (_req: Request, res: Response) => {
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    }),
  );
});
```

A matching `DELETE /mcp` handler at `:86-94` returns the same response.

This is correct for the transport we run. The API mounts `StreamableHTTPServerTransport` with `sessionIdGenerator: undefined` (`packages/api/src/index.ts:53-55`), i.e. **stateless** Streamable HTTP. In stateless mode there is no session to attach a server-initiated event stream to, so the `GET` (SSE stream) and `DELETE` (session teardown) verbs of the Streamable HTTP spec have nothing to operate on. Rejecting them with 405 is the specified behavior. [`../ARCHITECTURE.md`](../ARCHITECTURE.md) documents the endpoint as "Stateless Streamable HTTP MCP handling at `POST /mcp`".

## What was investigated

1. **Verified the handler at HEAD.** The `GET /mcp` route exists exactly as described and returns 405 unconditionally. No code path returns 405 for `POST /mcp`, so the recorded lines are genuinely `GET` requests.
2. **Checked whether our own components issue `GET /mcp`.** They do not. `packages/cli` calls the toolkit in-process and never issues HTTP requests to the API (`packages/cli/src/commands/*.ts`, and see [`../ARCHITECTURE.md`](../ARCHITECTURE.md) "packages/cli"). The toolkit's only outbound MCP client is the Crawl4AI client, which connects to Crawl4AI's `/mcp/sse` endpoint (`packages/toolkit/src/crawl4ai.ts:13`), not to our own `/mcp`. No internal caller accounts for this traffic.
3. **Checked the auth ordering.** The auth middleware runs before the route (`packages/api/src/index.ts:30-46`) and skips only `/health`. An unauthenticated probe would receive 403, not 405. The recorded responses are 405, which means **these requests carried a valid API key**. That is the single most significant finding here, and it argues against anonymous internet background scanning.
4. **Considered the plausible sources.** Two remain, and the evidence does not separate them:
    - A legitimate MCP client that opens with a `GET` to negotiate an SSE stream before falling back to `POST`. Several MCP client implementations probe this way, and the behavior would be harmless and expected.
    - A monitoring, uptime, or security-scanning integration configured with the API key.

## Why no solution could be identified

The blocker is evidential, not technical. **The application logs no request metadata**, so the requests cannot be attributed to a source. `packages/api/src/index.ts` has no request-logging middleware at all; the only startup and error lines come from the bare `log` helper at `:17-21`. The platform's HTTP log line (`GET /mcp 405 1ms`) carries no user agent, no client IP, and no request ID.

Without a user agent or source identity there is no way to decide between the two remaining hypotheses — and the correct fix differs completely depending on which is true:

- If it is a legitimate MCP client negotiating a transport, the right response is to leave the 405 in place and exclude it from the error-rate metric, or to document it as expected.
- If it is a misconfigured monitor or scanner, the right response is to fix that caller's configuration.
- Changing the handler itself is **not** an option in either case. The 405 is protocol-correct for stateless Streamable HTTP, and returning anything else to satisfy a metric would misreport the transport's actual capability, contrary to [`../PRODUCT.md`](../PRODUCT.md) Principle 5 ("Operational truth is explicit").

Guessing between the hypotheses and acting on the guess would risk either suppressing a real signal or breaking a working client.

## Unexplored avenue - check the platform's raw logs first

Before treating an application change as the only path forward, one cheaper avenue has **not** been exhausted: this investigation read the platform's summarized HTTP log lines, but did not query the platform's raw request logs or HTTP observability tooling for a user-agent or client-IP field that the summary view omits. Some hosting platforms retain those fields even when the default log view does not show them. If they are retained, the disposition below can be settled immediately with no code change at all. That check should be the first step, and it may make the rest of this note moot.

## What would unblock this

If the platform retains no source fields, story [`../tasks/request-correlation-logging.md`](../tasks/request-correlation-logging.md) adds per-request logging that includes the user agent. Once that ships, re-examine the retained `GET /mcp` 405 traffic:

1. Confirm the requests are still occurring.
2. Read the user agent and request source from the new structured request logs.
3. Decide the disposition — expected client behavior to document and exclude from the error-rate metric, or a misconfigured caller to correct.

This note should be closed or replaced with an implementation story at that point.

## References

- `packages/api/src/index.ts` (`GET /mcp` handler at `:76-84`, `DELETE /mcp` at `:86-94`, auth middleware at `:30-46`, transport construction at `:53-55`)
- `packages/toolkit/src/crawl4ai.ts` (the only outbound MCP client we own)
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — Package Boundaries, Request Flows (MCP), Authentication And Trust
- [`../PRODUCT.md`](../PRODUCT.md) — Principle 5, Phase 3 (Operable Service)
- [`../tasks/request-correlation-logging.md`](../tasks/request-correlation-logging.md) — the story that would supply the missing evidence
