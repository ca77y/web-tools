---
type: story
title: Classify crawl failures by real upstream status instead of anti-bot
---

# Classify crawl failures by real upstream status instead of anti-bot

- [ ] Classify crawl failures by real upstream status instead of anti-bot #bug ⏫ 🆔 classify-crawl-upstream-status
    - Phase: Phase 1 - Reliable Core
    - **Problem.** `web_fetch` and `web_crawl` report ordinary HTTP 404 responses as anti-bot blocks. Production Crawl4AI logs (2026-07-18) contain this exact error repeatedly, across unrelated targets:

        ```text
        Blocked by anti-bot protection: Structural: minimal_text on small page (165 bytes, 14 chars visible)
        ```

        Confirmed affected URLs (all returned the identical `165 bytes, 14 chars visible`):

        ```text
        https://raw.githubusercontent.com/instantdb/instant/main/LICENSE
        https://raw.githubusercontent.com/tursodatabase/turso/main/sync/engine/README.md
        https://raw.githubusercontent.com/sqliteai/sqlite-sync/main/LICENSE
        https://raw.githubusercontent.com/tursodatabase/turso/main/packages/sync-react-native/README.md
        ```

        Control case proving these are 404s, not blocks: `https://raw.githubusercontent.com/sqliteai/sqlite-sync/main/LICENSE` failed with the message above at `2026-07-18 21:08:24,524`, while the file that actually exists, `https://raw.githubusercontent.com/sqliteai/sqlite-sync/main/LICENSE.md`, succeeded moments later in 15.27s. Correlation IDs from the incident: `326acd651b93`, `5793b591f4e7`, `4e8001c265a4`.

    - **Root cause (verified against Crawl4AI v0.9.1 source, not inferred).** `raw.githubusercontent.com` serves 404s as the plain-text body `404: Not Found`. Chromium wraps plain text as `<html><head></head><body><pre>404: Not Found</pre></body></html>` — about 165 bytes, with exactly 14 visible characters (`404: Not Found` is 14 chars). In `crawl4ai/antibot_detector.py`, `_structural_integrity_check()` then:
        - flags `minimal_text` because visible text is under 50 chars;
        - does **not** flag `no_content_elements`, because `<pre>` is in `_CONTENT_ELEMENTS_RE`;
        - reaches `signal_count == 1` with `html_len < 5000`, which returns `Structural: {signal} on small page ({html_len} bytes, {visible_len} chars visible)`.

        This reproduces the logged string byte for byte, so the misclassification is proven. `crawl4ai/async_webcrawler.py` then sets `crawl_result.error_message = f"Blocked by anti-bot protection: {_block_reason}"`.

    - **Why we cannot fix this by reading the status code off the response.** Crawl4AI's `is_blocked()` does receive the real `status_code`, but the Docker server discards it on failure. In `deploy/docker/server.py` the `crawl` MCP tool does:

        ```python
        if all(not result["success"] for result in results["results"]):
            raise HTTPException(500, f"Crawl request failed: {results['results'][0]['error_message']}")
        ```

        Only `error_message` survives the 500. Our toolkit therefore receives a string and never sees `status_code: 404`. Any fix must recover the status ourselves.

    - **Second defect: these false positives corrupt IP rotation.** [`packages/toolkit/src/functions.ts`](../../packages/toolkit/src/functions.ts) line 22 defines:

        ```ts
        const BLOCK_RE =
          /HTTP 429|Too Many Requests|Cloudflare JS challenge|anti-bot protection|Just a moment\.\.\.|Unexpected error in _crawl_web|BrowserContext\.new_page|Navigation timeout|Connection closed while reading from the driver/i;
        ```

        `anti-bot protection` matches every structural false positive. `trace()` (same file, lines 31-41) then calls `noteBlocked()`, and [`packages/toolkit/src/rotation.ts`](../../packages/toolkit/src/rotation.ts) lines 40-47 kill the hot Crawl4AI browser after `ROTATE_AFTER_429` (default 3) consecutive hits. So three 404s in a row tear down a perfectly healthy browser and its proxy tunnel. Broken-link crawling silently degrades throughput for every other caller.

    - Scope:
        - Add a direct (non-browser) HTTP verification path in `packages/toolkit`, used when a Crawl4AI failure message matches a structural/ambiguous block reason (`Blocked by anti-bot protection: Structural:`, `HTTP 4xx/5xx with HTML content`, `Near-empty content`).
        - Re-request the URL over plain HTTP (honouring `Config.proxy` from [`packages/toolkit/src/config.ts`](../../packages/toolkit/src/config.ts)) to recover the true status code, then report that status to the caller.
        - Return an actionable, distinguishable error for real HTTP status failures (404, 410, 403, 5xx) rather than the generic anti-bot string.
        - Keep genuine vendor block reasons (`Cloudflare JS challenge`, `Akamai block (Reference #)`, `HTTP 429 Too Many Requests`, `PerimeterX`, `DataDome`) reported as blocks.
        - Exclude verified non-block failures from `noteBlocked()` so they no longer trigger browser rotation.
        - Update [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) so Package Boundaries / Runtime Services record that the toolkit now has a direct-HTTP path alongside Crawl4AI, rather than leaving Crawl4AI documented as the sole retrieval mechanism.
        - Out of scope: retrieving content from genuinely anti-bot-protected sites (see [`docs/issues/third-party-anti-bot-blocks.md`](../issues/third-party-anti-bot-blocks.md)); non-HTML/download handling (owned by [`fetch-non-html-resources-directly`](./fetch-non-html-resources-directly.md)); retry behaviour (owned by [`retry-transient-crawl-failures`](./retry-transient-crawl-failures.md)); rotation *accounting* — how block/success observations are extracted and accumulated — which is owned by [`fix-rotation-block-signal-detection`](./fix-rotation-block-signal-detection.md).
    - **Coordination — other stories edit the same code.** This story lands first. Three cards declare `⛔ classify-crawl-upstream-status`: [`fix-rotation-block-signal-detection`](./fix-rotation-block-signal-detection.md), [`fetch-non-html-resources-directly`](./fetch-non-html-resources-directly.md), and [`retry-transient-crawl-failures`](./retry-transient-crawl-failures.md). The first two also edit the same `trace()` / `BLOCK_RE` region and need the sequencing below; the third depends on this story only for correct transient-versus-permanent classification and does not contend for the same code.
        - [`fix-rotation-block-signal-detection`](./fix-rotation-block-signal-detection.md) (`⛔ classify-crawl-upstream-status`) rewrites `trace()` in the same file and **replaces the hard `consecutive429 = 0` reset with decay or sliding-window accounting**. The acceptance criteria below are therefore written against today's hard-reset semantics; once that story lands, re-verify them against whatever accounting surface it establishes. This story defines *which* messages are blocks; that story defines *how* they are counted.
        - [`fetch-non-html-resources-directly`](./fetch-non-html-resources-directly.md) also depends on this story and edits the same `noteBlocked()` exclusion path. Sequence the two rather than running them in parallel.
    - Acceptance criteria:
        - Crawling `https://raw.githubusercontent.com/sqliteai/sqlite-sync/main/LICENSE` returns an error identifying HTTP 404 / not found, and the message does not claim anti-bot protection.
        - Crawling `https://raw.githubusercontent.com/sqliteai/sqlite-sync/main/LICENSE.md` still succeeds and returns the file contents.
        - A saved HTML response body containing `/cdn-cgi/challenge-platform/…orchestrate` is still classified as an anti-bot block, not as a status error. Where this sample lives (checked-in fixture file versus inline test constant) is decided during implementation, since the repo has no test runner today.
        - Three consecutive 404 crawls do not trigger `rotate()` and leave `getRotationStats().rotations` unchanged. (Under today's hard-reset accounting `consecutive_429` also returns to 0; if [`fix-rotation-block-signal-detection`](./fix-rotation-block-signal-detection.md) has already landed, assert instead that the 404s contribute nothing to whatever counter replaced it.)
        - Three consecutive genuine block signals still trigger exactly one rotation, preserving today's behaviour.
        - The verification request is bounded by an explicit timeout and adds at most one extra HTTP request per failed crawl.
        - `web_fetch` and `web_crawl` behave identically here, and MCP and REST both surface the corrected error.
        - `pnpm build` and `pnpm typecheck` pass.
    - References:
        - [`packages/toolkit/src/functions.ts`](../../packages/toolkit/src/functions.ts) — `BLOCK_RE` (line 22), `trace()` (31-41), `proxyCrawl4AI()` (54-99), `web_fetch` (116-197), `web_crawl` (215-250)
        - [`packages/toolkit/src/rotation.ts`](../../packages/toolkit/src/rotation.ts) — `noteBlocked()` / `rotate()`
        - [`packages/toolkit/src/config.ts`](../../packages/toolkit/src/config.ts) — `Config.proxy`
        - Upstream Crawl4AI v0.9.1: `crawl4ai/antibot_detector.py` (`_structural_integrity_check`, `is_blocked`), `crawl4ai/async_webcrawler.py` (error_message assignment), `deploy/docker/server.py` (`crawl` tool 500 path)
        - [`docs/PRODUCT.md`](../PRODUCT.md) Phase 1: "Crawl and fetch correctly classify upstream status, downloads, binary content, and browser failures."
        - [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) — Failure Model
    - Note: the repository currently has no test runner or test files. Establishing one is part of executing this story.
