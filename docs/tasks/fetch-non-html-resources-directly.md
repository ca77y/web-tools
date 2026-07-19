---
type: story
title: Retrieve non-HTML resources over direct HTTP instead of browser navigation
---

# Retrieve non-HTML resources over direct HTTP instead of browser navigation

- [ ] Retrieve non-HTML resources over direct HTTP instead of browser navigation #improvement ⏫ 🆔 fetch-non-html-resources-directly ⛔ classify-crawl-upstream-status
    - Phase: Phase 1 - Reliable Core
    - **Problem.** Any URL whose response Chromium treats as a download (PDF, `application/octet-stream`, unknown MIME types) fails the crawl outright, because Crawl4AI only navigates pages. Production Crawl4AI logs (2026-07-18) show four such failures.

        Exact targets and outcomes:

        ```text
        https://cse.buffalo.edu/tech-reports/2014-04.pdf              failed twice: 18:59:22 and 19:03:41
        https://martin.kleppmann.com/papers/local-first.pdf           failed once
        https://unpkg.com/@nozbe/watermelondb@0.28.1-0/native/android-jsi/build.gradle   failed once
        ```

        Exact root error message:

        ```text
        Unexpected error in _crawl_web at line 778 in _crawl_web
        Error: Failed on navigating ACS-GOTO:
        Page.goto: Download is starting
        Call log:
          - navigating to "<URL>", waiting until "load"
        ```

        Correlation IDs: `97df4ea73463` and `ac512b79f319` (Buffalo PDF), `49e8514dc9d6` (local-first PDF), `f5df197b01cf` (unpkg `build.gradle`).

    - **Related failure: API/JSON endpoints routed through the browser.** The same page-navigation-only path was used for a Wayback CDX API query, which is a JSON endpoint, not a page:

        ```text
        2026-07-18 20:51:49,254 - server - ERROR - server error 500 [cid=4ee94c082088]: Crawl request failed: Blocked by anti-bot protection: HTTP 503 with HTML content (120 bytes)
        ```

        The retained (Crawl4AI-abbreviated) target was `http://web.archive.org/...*&output=json&limit=200`. Note that [`packages/toolkit/src/wayback.ts`](../../packages/toolkit/src/wayback.ts) `getSnapshots()` already calls the CDX API with a direct `fetch` (line 36), so this call did not originate there — a caller passed a CDX URL to `web_fetch`/`web_crawl`. Driving a JSON API through Chromium is wrong regardless of the 503.

    - **Why the browser path cannot handle this today.** [`packages/toolkit/src/functions.ts`](../../packages/toolkit/src/functions.ts) `web_fetch` (lines 116-197) always builds `browserParams = { headless: true, enable_stealth: true }` and calls Crawl4AI's `crawl` tool with `wait_until: 'load'`. Crawl4AI's `BrowserConfig` defaults `accept_downloads` to `False` (upstream `crawl4ai/async_configs.py`), so Playwright aborts navigation with `Page.goto: Download is starting`. Even setting `accept_downloads: true` would only write the file to the Crawl4AI container's `downloads_path` — the bytes would still never reach the caller. The correct fix is on our side: do not send non-page resources through page navigation at all.

    - **Third defect: these failures spuriously rotate the browser.** `BLOCK_RE` in `functions.ts` line 22 includes `Unexpected error in _crawl_web`, so each download failure calls `noteBlocked()`. Per [`packages/toolkit/src/rotation.ts`](../../packages/toolkit/src/rotation.ts), three of them in a row kill the healthy hot browser and its proxy tunnel. The unpkg `build.gradle` failure was in fact logged immediately after the shared browser reached `active=10`.

    - Scope:
        - Route non-HTML resources through the direct HTTP path introduced by `classify-crawl-upstream-status` rather than Crawl4AI page navigation.
        - Decide the route up front (cheap `HEAD`/ranged `GET` content-type probe, and/or extension heuristics) and additionally recover when Crawl4AI returns `Page.goto: Download is starting`.
        - Return text-like payloads (`text/*`, `application/json`, `application/xml`, source files such as `build.gradle`) as text.
        - Define and document explicit behaviour for binary payloads such as PDFs: at minimum a clear, actionable result stating content type, size, and that the bytes are not inlined. Do not silently return an empty success.
        - Bound the direct fetch with a response-size cap and an explicit timeout.
        - Exclude these failures from `noteBlocked()` so downloads no longer trigger browser rotation.
        - Out of scope: PDF text extraction or OCR (a Phase 4 capability decision, not Phase 1); `web_pdf`, which renders a page to PDF and is unrelated; changing `web_snapshots`; retrieving content from genuinely anti-bot-protected sites (see [`docs/issues/third-party-anti-bot-blocks.md`](../issues/third-party-anti-bot-blocks.md)).
    - **Coordination — other stories edit the same code.**
        - [`fix-rotation-block-signal-detection`](./fix-rotation-block-signal-detection.md) shares this story's only prerequisite and also edits `trace()` and the `noteBlocked()` exclusion path in `functions.ts`. That card explicitly defers download-initiated rotation suppression to this story; do not re-implement it there, and re-run both cards' rotation-counter criteria after whichever lands second.
        - [`normalize-crawl4ai-config-payloads`](./normalize-crawl4ai-config-payloads.md) also rewrites `web_crawl` (`functions.ts:215-250`) and the `browser_config` construction this story touches when deciding the routing path. Sequence rather than parallelise.
    - Acceptance criteria:
        - `web_fetch` on `https://martin.kleppmann.com/papers/local-first.pdf` returns a successful, non-empty result identifying the resource as `application/pdf` with its size, and does not return a `Page.goto: Download is starting` error.
        - `web_fetch` on `https://unpkg.com/@nozbe/watermelondb@0.28.1-0/native/android-jsi/build.gradle` returns the file's text content.
        - `web_fetch` on a Wayback CDX URL such as `https://web.archive.org/cdx/search/cdx?url=example.com&output=json&limit=10` returns the JSON body and does not go through browser navigation.
        - `web_fetch` on an ordinary HTML page still uses the Crawl4AI browser path with stealth and proxy defaults unchanged.
        - A download-triggered failure does not increment the rotation counter; `getRotationStats().consecutive_429` stays 0 across three consecutive PDF fetches.
        - A response exceeding the configured size cap fails with an explicit size error rather than buffering unbounded memory.
        - MCP and REST return the same result for each case above.
        - `pnpm build` and `pnpm typecheck` pass.
    - References:
        - [`packages/toolkit/src/functions.ts`](../../packages/toolkit/src/functions.ts) — `web_fetch` (116-197), `web_crawl` (215-250), `BLOCK_RE` (22)
        - [`packages/toolkit/src/wayback.ts`](../../packages/toolkit/src/wayback.ts) — direct CDX `fetch` precedent (line 36)
        - [`packages/toolkit/src/schemas.ts`](../../packages/toolkit/src/schemas.ts) — `web_fetch` / `web_crawl` input schemas
        - Upstream Crawl4AI v0.9.1: `crawl4ai/async_configs.py` (`accept_downloads` default `False`), `crawl4ai/async_crawler_strategy.py` (download handling), `crawl4ai/browser_manager.py`
        - [`docs/PRODUCT.md`](../PRODUCT.md) Phase 1 exit condition on downloads and binary content; Product Promise "Actionable"
        - [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) — the toolkit owns provider-facing behavior
    - Depends on `classify-crawl-upstream-status`, which introduces the shared direct-HTTP helper and the rotation-counter split this story reuses.
