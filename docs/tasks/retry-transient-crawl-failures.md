---
type: story
title: Retry transient crawl failures with bounded backoff
---

# Retry transient crawl failures with bounded backoff

- [ ] Retry transient crawl failures with bounded backoff #improvement 🔼 🆔 retry-transient-crawl-failures ⛔ classify-crawl-upstream-status
    - Phase: Phase 1 - Reliable Core
    - **Problem.** A single transient upstream failure is returned to the caller as a hard error. `web_crawl` and `web_fetch` perform no retry anywhere in the toolkit, and Crawl4AI's own retry is disabled by default, so a page that would succeed on a second attempt fails on the first.

        Proven transient case — navigation timeout, 2026-07-18:

        ```text
        2026-07-18 20:57:35,500 - server - ERROR - server error 500 [cid=590376c8547a]: ... Page.goto: Timeout 60000ms exceeded ... waiting until "load"
        ```

        Target: `https://docs.amplify.aws/reference/maintenance-policy/?platform=react-native`. The **same URL succeeded at 20:59:41 in 16.22 seconds**. The later success came from a separate caller-initiated call, not a retry.

        Rate-limit cases that a short backoff would likely absorb — two npm 429s within five seconds:

        ```text
        20:57:30  https://www.npmjs.com/p...tate?activeTab=versions   cid=9c0764c86148
        20:57:35  https://www.npmjs.com/package/@fireproof/core        cid=3cdf797738e0
        ```

        A Wayback 503 in the same window (`cid=4ee94c082088`, `HTTP 503 with HTML content (120 bytes)`) is also a standard back-off-and-retry signal rather than a permanent failure.

    - **Current behaviour, verified at HEAD.**
        - [`packages/toolkit/src/functions.ts`](../../packages/toolkit/src/functions.ts) `proxyCrawl4AI()` (lines 54-99) catches the failure and returns `isError: true` immediately. There is no retry loop.
        - `web_fetch` (lines 155-168) sends `crawler_config.params = { wait_until: 'load', page_timeout: 120000, delay_before_return_html: delay }`. It does **not** set `max_retries`.
        - Upstream Crawl4AI v0.9.1 `crawl4ai/async_configs.py` defines `max_retries: int = 0` on `CrawlerRunConfig`, and `max_retries` is present in the serializable field allowlist, so it can be passed through our existing `crawler_config` payload. `crawl4ai/async_webcrawler.py` implements the loop as `_max_attempts = 1 + getattr(config, "max_retries", 0)`.
        - [`packages/toolkit/src/rotation.ts`](../../packages/toolkit/src/rotation.ts) already kills the hot browser after `ROTATE_AFTER_429` (default 3) consecutive block signals, but **nothing retries the request that triggered the rotation** — the caller still receives the error, and only a later unrelated call benefits from the fresh IP.
        - Contrast with search: [`packages/toolkit/src/searxng.ts`](../../packages/toolkit/src/searxng.ts) already fans out `Config.parallelRequests` (3) attempts with `AbortSignal.timeout`. Crawl has no equivalent.

    - Scope:
        - Add a bounded, explicitly configurable retry for crawl operations classified as transient: navigation/page timeout, HTTP 429, HTTP 503, and browser-level errors such as `BrowserContext.new_page` / `Connection closed while reading from the driver`.
        - Apply backoff between attempts, and honour `Retry-After` where the upstream supplies it.
        - Retry the failed operation once after a rotation completes, so the caller benefits from the fresh proxy IP rather than only later callers.
        - Do **not** retry deterministic failures: HTTP 404/410, and confirmed vendor challenge pages (Cloudflare, Akamai, PerimeterX, DataDome) where a same-IP retry cannot succeed.
        - Decide and document whether the retry is implemented in the toolkit, via Crawl4AI's `max_retries`, or both; per [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) retries must be bounded and limited to operations known to be safe.
        - Keep total worst-case latency bounded and documented, given `page_timeout` is currently 120000 ms.
        - Out of scope: retrying `web_search` (already fans out); unlimited or unbounded retry; defeating anti-bot protection (see [`docs/issues/third-party-anti-bot-blocks.md`](../issues/third-party-anti-bot-blocks.md)); connection-level MCP client retry, owned by [`crawl4ai-mcp-client-timeout-and-recovery`](./crawl4ai-mcp-client-timeout-and-recovery.md).
    - **Which timeout the evidence belongs to.** The `Page.goto: Timeout 60000ms exceeded` message is Playwright's own error text, raised inside Crawl4AI and surfaced through its HTTP 500 — it is *not* the MCP client-side `MCP error -32001: Request timed out` that [`crawl4ai-mcp-client-timeout-and-recovery`](./crawl4ai-mcp-client-timeout-and-recovery.md) addresses. The 60000 ms value rather than the 120000 ms that `web_fetch` requests indicates the failing call came through `web_crawl`, which passes caller `crawler_config` straight through and sets no `page_timeout` of its own (`functions.ts:215-250`), so Crawl4AI's own 60000 ms default applied — consistent with the default documented in [`packages/toolkit/src/schemas.ts`](../../packages/toolkit/src/schemas.ts) line 87. Confirm this during implementation before choosing the retry trigger.
    - **Coordination — overlapping retry layer.** [`crawl4ai-mcp-client-timeout-and-recovery`](./crawl4ai-mcp-client-timeout-and-recovery.md) adds one bounded reconnect-and-retry at the MCP *connection* layer and raises the MCP call timeout above the crawl budget. This story retries at the *crawl semantics* layer. The triggers are distinct but the latency compounds: whichever card lands second must state the combined worst-case latency, and a connection-level retry must not multiply with a crawl-level retry on the same logical request.
    - Acceptance criteria:
        - A crawl whose first navigation exceeds the page timeout and whose second attempt completes returns a successful result to the caller, reproducing the `docs.amplify.aws/reference/maintenance-policy/?platform=react-native` shape.
        - Retry attempts are capped at a configured maximum, and the cap is verifiable by counting upstream calls.
        - An HTTP 404 is returned immediately with no retry.
        - A confirmed Cloudflare JS challenge is not retried on the same browser/IP.
        - An HTTP 429 carrying `Retry-After` waits at least the indicated interval before retrying.
        - Worst-case total latency for a fully exhausted retry sequence is bounded and stated in the tool's documented contract.
        - After a rotation fires, the request that triggered it is retried once and its result is returned to the original caller.
        - Retry counts are visible to operators (logs and/or `web_usage_stats`), and retried calls are not double-counted as separate caller invocations in `/stats`.
        - `pnpm build` and `pnpm typecheck` pass.
    - References:
        - [`packages/toolkit/src/functions.ts`](../../packages/toolkit/src/functions.ts) — `proxyCrawl4AI()` (54-99), `web_fetch` crawler_config (155-168), `trace()` (31-41)
        - [`packages/toolkit/src/rotation.ts`](../../packages/toolkit/src/rotation.ts) — rotation without retry
        - [`packages/toolkit/src/searxng.ts`](../../packages/toolkit/src/searxng.ts) — existing bounded fan-out precedent
        - [`packages/toolkit/src/stats.ts`](../../packages/toolkit/src/stats.ts) — call accounting
        - Upstream Crawl4AI v0.9.1: `crawl4ai/async_configs.py` (`max_retries`, default 0), `crawl4ai/async_webcrawler.py` (retry/proxy loop)
        - [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) — "Retries must be bounded and limited to operations known to be safe."
        - [`docs/PRODUCT.md`](../PRODUCT.md) Phase 1 - Reliable Core
    - Depends on `classify-crawl-upstream-status`: retry decisions require correct transient-versus-permanent classification, otherwise 404s would be retried.
