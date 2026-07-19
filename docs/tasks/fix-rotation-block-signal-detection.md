---
type: story
title: Fix rotation block accounting so failures are observed
---

# Fix rotation block accounting so failures are observed

- [ ] Fix rotation block accounting so failures are observed #bug ⏫ 🆔 rotation-block-signal-detection ⛔ classify-crawl-upstream-status
  - Phase: Phase 1 - Reliable Core
  - **Problem.** Production Railway logs for the Tools service covering a 14-day window contain zero `[rotation]` lines — neither a success (`[rotation] killed N browser(s) ...`) nor any of the failure lines (`[rotation] /monitor/browsers HTTP <status>`, `[rotation] no killable browser found`, `[rotation] failed: <message>`). Over the same window the upstream Crawl4AI service returned 36 HTTP 500 responses including Cloudflare challenges, Akamai blocks, HTTP 403, HTTP 429, and HTTP 503 anti-bot responses. The IP-rotation mechanism in `packages/toolkit/src/rotation.ts` never fired despite abundant anti-bot signals reaching the service.
  - **Scope boundary with `classify-crawl-upstream-status`.** That story owns *classification* — which upstream failure messages count as a genuine block, including recovering real HTTP status via a direct-HTTP verification path and narrowing `BLOCK_RE` so structural 404 false positives stop matching `anti-bot protection`. This story owns *accounting* — how block and success observations are extracted from a `ToolResult` and accumulated into the rotation counter. Land `classify-crawl-upstream-status` first; both stories edit `trace()` in `packages/toolkit/src/functions.ts`, and doing them in parallel would merge-conflict and risk each re-introducing the other's bug. This story must consume whatever classification surface that story establishes rather than defining a competing one.
  - **Accounting defects, all in `trace()` at `packages/toolkit/src/functions.ts:31-41`.** Current code at HEAD:
    - ```ts
      function trace(tool: ToolName, result: ToolResult): ToolResult {
        const text = result.content?.[0]?.text ?? '';
        const blocked = BLOCK_RE.test(text);
        recordCall(tool, text.length, !!result.isError || blocked);
        if (blocked) noteBlocked();
        else if (text) noteSuccess();
        return result;
      }
      ```
    - **Defect 1 - error results are counted as successes.** The `else if (text) noteSuccess()` branch ignores `result.isError`. Every failed call whose message is not classified as a block resets `consecutive429` to `0` at `packages/toolkit/src/rotation.ts:49-51`. Concretely, `proxyCrawl4AI()` at `packages/toolkit/src/functions.ts:73-88` returns `isError: true` with the text `Crawl4AI crawl returned empty content. The page may have no extractable text or the crawl may have timed out.` — a hard upstream failure that actively *cancels* progress toward rotation. This alone is sufficient to explain zero rotations under mixed traffic.
    - **Defect 2 - only the first content item is inspected.** `result.content?.[0]?.text` reads index `0` only. For `web_screenshot` and `web_pdf` the first content item carries binary/image data and any error text can appear in a later item, so the signal is invisible regardless of how well it is classified.
    - **Defect 3 - hard reset defeats the consecutive threshold.** `noteSuccess()` resets to `0`. With concurrent workers sharing one process-global counter and interleaved traffic across many targets, three *consecutive* blocks (`ROTATE_THRESHOLD`, `packages/toolkit/src/rotation.ts:22`, default `3` via `ROTATE_AFTER_429`) is a bar that mixed traffic rarely clears even when a large fraction of calls are blocked.
  - **Unresolved dispositions this story must settle.** `BLOCK_RE` (`packages/toolkit/src/functions.ts:22-23`) treats several browser-internal messages as rotation-worthy without a recorded rationale:
    - ```ts
      const BLOCK_RE =
        /HTTP 429|Too Many Requests|Cloudflare JS challenge|anti-bot protection|Just a moment\.\.\.|Unexpected error in _crawl_web|BrowserContext\.new_page|Navigation timeout|Connection closed while reading from the driver/i;
      ```
    - `Unexpected error in _crawl_web` is Crawl4AI's generic wrapper for a broad range of internal failures, many entirely deterministic. It should not by itself imply that a new egress IP would help.
    - `Navigation timeout` was observed as transient on `https://docs.amplify.aws/reference/maintenance-policy/?platform=react-native`, so counting it as a block is a judgement call, not an obvious truth.
    - `BrowserContext.new_page` and `Connection closed while reading from the driver` indicate a wedged local browser rather than a blocked IP.
    - Shared-region warning: `fetch-non-html-resources-directly` also edits the `noteBlocked()` exclusion path in `trace()` and shares this story's only prerequisite, so the two can be scheduled in parallel by accident. They touch the same functions — sequence them or expect a merge conflict, and re-run both stories' rotation-counter criteria after whichever lands second.
    - Note: the specific case of download-initiated failures (`Page.goto: Download is starting` for PDFs and `build.gradle`) is already owned by the story `fetch-non-html-resources-directly`, which removes those failures from `noteBlocked()` as part of routing non-HTML resources over direct HTTP. Do not re-implement that here; just do not regress it.
  - **Secondary problem - the mechanism is unobservable.** `noteBlocked()` and `noteSuccess()` at `packages/toolkit/src/rotation.ts:40-51` write no log output; only `rotate()` logs (lines 53-95). The absence of `[rotation]` lines in production therefore proves only that *no rotation fired* — it cannot distinguish "no blocks were ever counted" from "blocks were counted but repeatedly reset". This story must make that distinguishable going forward.
  - Scope:
    - Rewrite the observation extraction in `trace()` to scan every item in `result.content`, not just index `0`.
    - Never call `noteSuccess()` for a result with `isError: true`. An error not classified as a block must be neutral — neither block nor success — not a reset.
    - Replace the hard `consecutive429 = 0` reset in `packages/toolkit/src/rotation.ts` with a decay or sliding-window accounting so interleaved successes do not erase a sustained block rate. Keep the counter process-local and keep the `ROTATE_AFTER_429` environment override working.
    - Assign each browser-internal signal listed above an explicit disposition (counts toward rotation, or neutral) and record the rationale in a code comment. Require a corroborating classified block signal before the bare `Unexpected error in _crawl_web` wrapper counts.
    - Add stderr instrumentation to `noteBlocked()` and `noteSuccess()` recording the tool name, the matched signal, and the resulting counter value, so future production logs prove whether blocks are being observed.
    - Expose the block/success accounting through the existing rotation stats surface (`getRotationStats()` at `packages/toolkit/src/rotation.ts:32-38`, consumed at `packages/toolkit/src/stats.ts:108` and surfaced by `web_usage_stats`).
    - Out of scope: defining which upstream messages count as blocks, recovering real HTTP status, and the structural-404 false positive — owned by `classify-crawl-upstream-status`.
    - Out of scope: download/non-HTML routing and its rotation suppression — owned by `fetch-non-html-resources-directly`.
    - Out of scope: timeouts, retries, and latch safety on the Crawl4AI monitor HTTP calls — owned by `rotation-monitor-call-timeouts`.
    - Out of scope: changing the rotation mechanism itself (`kill_browser`), the proxy configuration, or Crawl4AI service configuration.
  - Acceptance criteria:
    - Feeding three consecutive Cloudflare-challenge fixtures through the traced tool path triggers exactly one rotation attempt.
    - Feeding three consecutive `HTTP 429` fixtures triggers exactly one rotation attempt.
    - A result with `isError: true` that is not classified as a block does not reset the block counter.
    - A `Crawl4AI crawl returned empty content...` error result does not reset the block counter.
    - A block signal present only in a non-first item of `result.content` is detected and counts toward rotation.
    - A genuine success (non-error result with extracted content and no block signal) decays or resets the counter per the chosen accounting, and an explicit test documents the semantics.
    - Interleaving successes between blocks at a sustained block rate still reaches the rotation threshold, and a test documents the interleaved reset semantics.
    - A payload containing only the bare `Unexpected error in _crawl_web` wrapper, with no corroborating classified block signal, does not increment the counter.
    - `BrowserContext.new_page`, `Navigation timeout`, and `Connection closed while reading from the driver` each have a disposition asserted by a test and a rationale in a code comment.
    - Download-triggered failures still do not increment the rotation counter, preserving the behaviour established by `fetch-non-html-resources-directly`.
    - Each block observation emits a stderr line naming the tool, the matched signal, and the current counter value.
    - `web_usage_stats` output includes the block/success accounting counters alongside the existing rotation stats.
    - `pnpm build` and `pnpm typecheck` pass.
  - References:
    - `packages/toolkit/src/functions.ts` — `BLOCK_RE` (lines 22-23), `trace()` (lines 31-41), `proxyCrawl4AI()` (lines 54-99).
    - `packages/toolkit/src/rotation.ts` — module header explaining the `kill_browser` rotation theory (lines 1-18), `ROTATE_THRESHOLD` (line 22), `getRotationStats()` (lines 32-38), `noteBlocked()` / `noteSuccess()` (lines 40-51), `rotate()` (lines 53-95).
    - `packages/toolkit/src/stats.ts` — `recordCall()`, and `getStats()` surfacing `rotation: getRotationStats()` at line 108.
    - Prerequisite story: [`classify-crawl-upstream-status.md`](./classify-crawl-upstream-status.md) — owns the classification surface this story consumes.
    - Related stories: [`fetch-non-html-resources-directly.md`](./fetch-non-html-resources-directly.md), [`bound-rotation-monitor-calls.md`](./bound-rotation-monitor-calls.md).
    - Open question on whether rotation works at all: [`../issues/rotation-egress-ip-change-unverifiable.md`](../issues/rotation-egress-ip-change-unverifiable.md).
    - [`../PRODUCT.md`](../PRODUCT.md) — Principle 2 "Failures are data, not empty arrays"; Principle 5 "Operational truth is explicit"; Phase 1 exit condition "Crawl and fetch correctly classify upstream status, downloads, binary content, and browser failures".
    - [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — Package Boundaries (toolkit owns implementations), Failure Model.
  - Note: the repository currently has no test runner or test files. If `classify-crawl-upstream-status` has not already established one, doing so is part of executing this story.
