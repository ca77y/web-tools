# MCP tool errors stay invisible to HTTP-status monitoring

## Status

No solution identified on our side. This is a constraint of the Model Context Protocol, not a defect in Web Tools.

## Problem

One operational consequence of search failures being hidden from callers is that "HTTP monitoring can remain green because the tool request itself completes successfully". Making `web_search` surface upstream failure as an error (tracked by [`../tasks/distinguish-search-failure-from-empty-results.md`](../tasks/distinguish-search-failure-from-empty-results.md)) fixes the *caller-visible* half of this: an agent or REST client can then tell an outage from a genuine no-match.

It does not fix the *monitoring* half for the MCP transport. A failing tool call over `POST /mcp` still returns HTTP 200. Any monitor that watches HTTP status codes on `/mcp` stays green during a total upstream search outage.

## Investigation

### The REST transport is fixable

`packages/api/src/handler.ts:11-18` maps a thrown toolkit error to an HTTP 500:

```ts
try {
  const result = await handler(req.body);
  res.json(result);
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  res.status(500).json({ error: message });
}
```

So once the toolkit throws instead of returning an empty array, `POST /api/v0/web_search` returns a 500 that status-based monitoring detects. No further work is needed there.

### The MCP transport is not

`packages/api/src/mcp.ts:39-45` handles the same thrown error differently:

```ts
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify({ error: message }) }],
    isError: true,
  };
}
```

This is correct and deliberate. The Model Context Protocol specifies that *tool execution* errors are reported inside the tool result with `isError: true`, rather than as JSON-RPC protocol errors, so that the calling model can see the failure and react to it. Protocol-level JSON-RPC errors are reserved for problems with the request itself (unknown method, malformed request, unknown tool). A successful JSON-RPC exchange — including one whose payload reports a failed tool call — is an HTTP 200.

Changing this would mean either:

1. Returning a JSON-RPC protocol error for tool failures. This violates the MCP specification and hides the failure from the model, which is the exact information loss this work set out to remove.
2. Returning a non-200 HTTP status for a well-formed JSON-RPC response. This breaks Streamable HTTP transport semantics and would cause conforming MCP clients to treat the response as a transport failure rather than parse the result.

Both trade a genuine correctness property for a monitoring convenience. Neither is acceptable.

### Why the obvious workarounds do not apply

- Inspecting the response body in a monitor is possible in principle, but the API creates a stateless MCP server and transport per request ([`../ARCHITECTURE.md`](../ARCHITECTURE.md)), and the response is a JSON-RPC envelope whose tool payload is a JSON string nested inside `content[].text`. This is a fragile thing to assert on and couples an external monitor to an internal serialization detail.
- Neither `GET /health` nor `GET /ready` can cover this. `/health` proves only that the API process can answer an HTTP request and returns `{"status":"ok"}` without checking SearXNG, Crawl4AI, Redis, or proxy connectivity — deliberately and permanently so, since it is the platform health check path. `GET /ready` now exists and does probe SearXNG and Crawl4AI, but it reports *dependency* health, not the outcome of a specific tool call: a `web_search` that fails on one target while both dependencies are reachable leaves `/ready` reporting `ok`. See [`../ARCHITECTURE.md`](../ARCHITECTURE.md), "Health And Statistics".

## Evidence

- `packages/api/src/mcp.ts:39-45` - tool errors returned in-band with `isError: true`
- `packages/api/src/handler.ts:11-18` - REST maps the same error to HTTP 500
- `packages/api/src/index.ts:122-124` - `res.json({ status: 'ok' })`, the unconditional health response
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md), "Health And Statistics" - "`GET /health` ... proves exactly one thing: the API process can accept a connection and answer an HTTP request. It proves **nothing** about Crawl4AI, SearXNG, Redis, target websites, or the Wayback Machine."
- Railway `Agentic-Search` production, 2026-07-17 to 2026-07-18 UTC: search providers were broadly blocked while the Tools service reported healthy throughout.

## Conclusion

Correct MCP behavior and HTTP-status-based failure monitoring are not reconcilable on the `/mcp` route. Operators who need to detect tool-level failure should not rely on `/mcp` HTTP status. The supported paths are:

- Structured application logs carrying operation, outcome, and duration — **available.** `request-correlation-logging` has shipped, so every tool call emits a `tool_call` operation record with `operation`, `outcome`, `durationMs`, and a `requestId` shared with the inbound `http_request` record. A monitor that reads stderr can detect tool-level failure on the `/mcp` route without parsing the JSON-RPC envelope. Note that `tool_call`'s `outcome` is `ok` or `error` only — it is derived from whether the result carries `isError`. A monitor that needs to separate a genuine empty result from a failure must read the records that do report `empty`: `search_complete` and `searxng_attempt_outcome` for `web_search`, and `crawl4ai_call` for the Crawl4AI-backed tools. See [`../ARCHITECTURE.md`](../ARCHITECTURE.md) "Structured Logging And Request Correlation". None of this makes the HTTP *status* carry the outcome — the constraint this note describes is unchanged; it supplies a different signal alongside it.
- A dependency-aware health or readiness endpoint — **available.** `health-liveness-readiness-split` has shipped as `GET /ready` ([`../ARCHITECTURE.md`](../ARCHITECTURE.md), "Health And Statistics"). It narrows the blind spot to tool-level failures with healthy dependencies; it does not close it, which is the point of this note.
- Monitoring the REST route, where status codes do carry the outcome once [`../tasks/distinguish-search-failure-from-empty-results.md`](../tasks/distinguish-search-failure-from-empty-results.md) lands.

The last of these belongs to Phase 3 of [`../PRODUCT.md`](../PRODUCT.md); the first two have landed.

Revisit if a future MCP specification revision defines a transport-level signal for tool failure.
</content>
