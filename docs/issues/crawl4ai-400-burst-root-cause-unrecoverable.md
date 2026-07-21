# Crawl4AI HTTP 400 burst of 2026-07-18: root cause not recoverable

Status: investigated, no fix identified for the historical incident, which remains unrecoverable. The observability gap that made it unrecoverable is closed for future occurrences — see [The forward-looking gap is now closed](#the-forward-looking-gap-is-now-closed). Remaining forward-looking work is tracked by the story cards linked at the bottom.

## The problem

The Crawl4AI service on Railway (project `Agentic-Search`, environment `production`) emitted 72 retained log lines of exactly this form during 2026-07-12 and 2026-07-18 UTC:

```text
HTTP Request: POST http://127.0.0.1:11235/crawl "HTTP/1.1 400 Bad Request"
```

Distribution:

- 1 occurrence at `2026-07-12 11:48:40,553`
- 51 occurrences between `2026-07-18 18:56:01,062` and `19:05:06,280`
- 19 occurrences between `2026-07-18 20:48:37,369` and `21:13:37,025`

The densest part of the burst put multiple rejections inside a single second:

```text
2026-07-18 18:58:04,384 ... 400 Bad Request
2026-07-18 18:58:04,416 ... 400 Bad Request
2026-07-18 18:58:04,921 ... 400 Bad Request
2026-07-18 18:58:04,927 ... 400 Bad Request
```

## What was investigated

**The address is loopback.** `127.0.0.1:11235` is Crawl4AI's own listen port. These lines are emitted **inside the Crawl4AI container** by its own MCP-to-REST bridge, not by Web Tools. Web Tools reaches Crawl4AI over MCP/SSE — `packages/toolkit/src/crawl4ai.ts:13` builds `new URL('/mcp/sse', Config.crawl4ai.url)` — so a 400 means the bridge translated our MCP `crawl` tool arguments into a REST body that its own request model rejected. The bridge is third-party code from the pinned `unclecode/crawl4ai:0.9.1` image (`services/crawl4ai/Dockerfile`).

**Neither side recorded anything correlatable.**

- Crawl4AI's line carries no target URL, no validation error, no response body, no request schema, and no correlation id. That format is fixed by upstream code we do not author.
- Web Tools logged nothing that could be matched to it. `packages/toolkit/src/functions.ts:46-50` is an unstructured `process.stderr.write` with no timestamp or request id. `proxyCrawl4AI` at `packages/toolkit/src/functions.ts:54-71` logs only on the failure branch and records only the tool name and returned text — successful calls log nothing, so there is no baseline. `packages/toolkit/src/crawl4ai.ts:46-55` wraps `c.callTool(...)` and rethrows without logging the tool, arguments, or elapsed time. No request id is generated anywhere in `packages/api` or `packages/toolkit`.

**Two plausible mechanisms were identified in our own code**, both of which can produce a request Crawl4AI rejects before browser allocation:

1. *Config envelope mismatch.* `web_fetch` sends the wrapped `{ type: 'CrawlerRunConfig', params: {...} }` form (`packages/toolkit/src/functions.ts:158-167`), while the CLI builds a flat, unwrapped `crawler_config` (`packages/cli/src/commands/crawl.ts:27-38`) and `web_crawl` forwards it verbatim (`packages/toolkit/src/functions.ts:247`). The published schema `WebCrawlInput.crawler_config` (`packages/toolkit/src/schemas.ts:70-144`) documents the flat form, so any schema-obeying caller produces a payload `web_fetch` would never send.
2. *Missing required fields.* REST passes the raw body to the toolkit with no validation (`packages/api/src/handler.ts:12`), and `web_screenshot`, `web_pdf`, and `web_execute_js` add no guards (`packages/toolkit/src/functions.ts:199-213`). A REST call with an empty body reaches Crawl4AI with no `url`.

Both are real defects and both are now tracked. **Neither can be confirmed as the cause of the 2026-07-18 burst.**

## Why no solution could be identified for the incident itself

Attribution would require at least one of the following, and none exists:

- A target URL or host on the Crawl4AI 400 line. Upstream does not log one, and the logs are already written.
- A validation error body from Crawl4AI's request model. Not logged, and not retained.
- A correlation id shared between the Web Tools call and the Crawl4AI rejection. Never generated.
- A Web Tools log line at a matching timestamp. None was emitted for these calls.

Timestamp-only correlation also fails: multiple 400s landed within the same second, so even if Web Tools had logged bare timestamps, the mapping from call to rejection would be ambiguous.

The retained logs are the only evidence, the incident window has passed, and the observability needed to explain it did not exist while it was happening. The specific requests that caused these 72 rejections are therefore **not recoverable**. This note exists so the gap is not mistaken for an unexamined problem.

## The forward-looking gap is now closed

`request-correlation-logging` has shipped. The historical incident stays unrecoverable — nothing about it is retroactively diagnosable — but a recurrence now is. Web Tools emits, for every Crawl4AI call:

- a `crawl4ai_request_shape` record **before** dispatch, mapping the outgoing argument's top-level keys to type tokens, so a request the upstream bridge rejects without explanation still has a Web Tools record of what was sent;
- a `crawl4ai_dispatch` record with outcome and duration, and — for the five tools that route through `proxyCrawl4AI` — a `crawl4ai_call` record naming the sanitized target URL and `targetUrlCount`;
- a `requestId` shared by every record from the originating call, plus the inbound `http_request` record naming method, path, status, and user agent.

That answers, for any future burst, three of the five questions listed under *What remains unknown*: which tool produced the requests, which interface originated them, and which target hosts were involved. Timestamp ambiguity within a single second is no longer a blocker, because correlation is by ID rather than by clock. See [`../ARCHITECTURE.md`](../ARCHITECTURE.md) "Structured Logging And Request Correlation".

Two caveats, stated so the coverage is not overclaimed. The upstream `POST http://127.0.0.1:11235/crawl "HTTP/1.1 400 Bad Request"` line still carries no correlation ID of its own — the match to a Web Tools record is by timestamp plus target host plus argument shape, not by a shared identifier, because that log format is fixed by third-party code we do not author. And a multi-URL `web_crawl` logs only its first target plus a count, so a rejection inside such a call narrows to the call, not to the individual URL.

## What remains unknown

- Which tool (`crawl`, `md`, `screenshot`, `pdf`, or `execute_js`) produced the rejected requests.
- Which interface (MCP, REST, or CLI) originated them.
- Which target URLs were involved.
- Whether the 2026-07-12 single occurrence shares a cause with the 2026-07-18 bursts.
- Why the burst clustered into two windows roughly 100 minutes apart rather than spreading evenly.

## Tracked follow-up

- [`../tasks/normalize-crawl4ai-config-payloads.md`](../tasks/normalize-crawl4ai-config-payloads.md) - fixes mechanism 1.
- [`../tasks/validate-tool-inputs-at-transport-boundary.md`](../tasks/validate-tool-inputs-at-transport-boundary.md) - fixes mechanism 2.
- `request-correlation-logging` - **shipped.** Added request IDs, structured logs, and the outgoing Crawl4AI argument-shape summary that makes any recurrence attributable; see the section above.
