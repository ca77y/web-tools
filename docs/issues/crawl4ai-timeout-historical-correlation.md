# Historical Crawl4AI timeout correlation is unrecoverable

**Status:** no solution identified on our side (for the historical data, which stays unrecoverable). The forward-looking mitigation has shipped — see [Disposition](#disposition).

## Problem

Two Tools-to-Crawl4AI MCP call timeouts were recorded in production on 2026-07-18:

```text
[2026-07-18T20:55:14.272879053Z] Crawl4AI crawl threw: MCP error -32001: Request timed out
[2026-07-18T20:57:35.945134082Z] Crawl4AI crawl threw: MCP error -32001: Request timed out
```

The second timestamp is close to a Crawl4AI-side AWS Amplify 60-second navigation failure recorded at `20:57:35` in the same incident window. The open question was whether these two log lines describe the same request — that is, whether the Tools-side timeout was caused by that specific navigation failure, or by an unrelated request that happened to fail in the same second.

**This question cannot be answered from the retained evidence, and no change we make now can answer it retroactively.**

## What was investigated

1. **Tools-side logs.** The complete record of each failure is the single line quoted above. The emitting code is `packages/toolkit/src/functions.ts:91-98`, whose catch block logs only the tool name and the error message:

   ```ts
   const msg = error instanceof Error ? error.message : String(error);
   log(`Crawl4AI ${toolName} threw:`, msg);
   ```

   The target URL is not visible at that point: `proxyCrawl4AI(toolName, fn)` (`functions.ts:54-57`) receives an opaque thunk, and the URL lives inside the closure (`functions.ts:155-168`) or inside the caller's `params`. No request ID is generated anywhere in the toolkit, and no correlation identifier is sent to Crawl4AI.

2. **Crawl4AI-side logs.** Crawl4AI abbreviates long URLs in its `[ERROR]` lines, and its records carry no identifier shared with the Tools process.

3. **Timestamp matching.** Both services log to Railway with sub-second precision, but the Tools timestamp marks when the *error surfaced* after the client-side deadline elapsed, while the Crawl4AI timestamp marks when *its* navigation failed. Correlating on time alone would require knowing the request start time on the Tools side, which was never logged. Multiple crawls were in flight during the window, so a same-second coincidence is not proof.

4. **Railway platform layer.** Railway's edge/proxy layer retains no per-request correlator that spans the Tools and Crawl4AI services. The two services communicate over the private network (`crawl4ai.railway.internal`), which is not proxied through the edge at all, so there is no platform-side record of the call to correlate against even in principle.

5. **Retained log volume.** Railway retention for this project capped several queries at 1,000 records, and the SearXNG service exceeded Railway's per-replica logging rate during the window (372 messages reported dropped). The Tools log lines above are the full set of Tools-side evidence that survived; there is no deeper record to recover.

## Why no solution could be identified

Correlation requires an identifier that existed **at the time the requests were made** and was written to both services' logs. No such identifier was ever generated or transmitted. The information needed to link the two events was not merely lost in retention — it was never produced. No code change, log re-query, or analysis of the retained data can reconstruct it after the fact.

Attempting a probabilistic match on timestamps alone would produce an unverifiable claim, which conflicts with the "Operational truth is explicit" principle in [`../PRODUCT.md`](../PRODUCT.md) and with treating production logs as evidence rather than inference.

## Disposition

- The specific historical question ("were these the same request?") is closed as **unanswerable**.
- The underlying *capability* gap is fixed on the Tools side. `request-correlation-logging` has shipped: a Tools-to-Crawl4AI call by any of the five tools routed through `proxyCrawl4AI` — including the `crawl` tool this incident involved — now emits a `crawl4ai_call` record carrying a `requestId`, the sanitized target URL, the outcome, and a duration. (`web_archive` reaches Crawl4AI directly and gets the lower-level `crawl4ai_dispatch` record with outcome and duration, but no target URL.) In all cases every record produced while serving one request shares that ID (see [`../ARCHITECTURE.md`](../ARCHITECTURE.md) "Structured Logging And Request Correlation"). An equivalent future timeout is therefore attributable to a specific call, target host, and originating request.
- **The identifier is still not shared with Crawl4AI.** The request ID is not transmitted in the MCP call, so it does not appear in Crawl4AI's own logs; matching a Tools record to a Crawl4AI-side line remains a timestamp-plus-target-host-plus-duration join, not an exact one. That is a narrower gap than the one described above — the Tools side now has an identifier and a target where it previously had neither — but it is not the same thing as end-to-end correlation across both services.
- The timeout behavior itself — a 60s SDK default deadline sitting under a 120s+ crawl budget — is a separate, fixable defect tracked by `docs/tasks/crawl4ai-mcp-client-timeout-and-recovery.md`.
