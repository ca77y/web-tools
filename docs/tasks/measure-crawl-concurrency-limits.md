---
type: story
title: Measure Crawl4AI concurrency and memory limits under load
---

# Measure Crawl4AI concurrency and memory limits under load

- [ ] Measure Crawl4AI concurrency and memory limits under load #research 🔽 🆔 measure-crawl-concurrency-limits
    - Phase: Phase 3 - Operable Service
    - **Why this is research, not implementation.** Production evidence shows a memory and concurrency *risk signal*, but no proven failure. Nothing in the retained logs justifies picking a concurrency cap or a memory limit yet. This story exists to produce that evidence; it must be refined into a `#feature`/`#improvement`/`#bug` story before any limit is implemented.
    - **Observed evidence (Crawl4AI service, Railway, 2026-07-18 incident window).**
        - The shared hot browser reached `active=10` at `21:01:01` and again at `21:01:04`.
        - The unpkg download failure (`https://unpkg.com/@nozbe/watermelondb@0.28.1-0/native/android-jsi/build.gradle`, cid `f5df197b01cf`) was logged immediately after the second `active=10` observation.
        - Successful requests continued immediately after failures, so the shared browser did not appear to crash or wedge.
        - Per-request Python memory logs peaked around **404.8 MB** during the analyzed segment.
        - Railway container metrics over 24 hours: Crawl4AI memory averaged **0.805 GB** and peaked at **3.671 GB**; CPU peaked at **2.1404**. The gap between container RSS and per-request Python RSS is most likely Chromium subprocesses.
        - **No OOM, process kill, allocation failure, or container restart was retained.** Memory pressure is therefore unproven as a cause of the 36 HTTP 500 responses observed in the same window.
    - **Current state at HEAD.** Nothing in `packages/` bounds how many crawls are in flight against Crawl4AI. [`packages/toolkit/src/functions.ts`](../../packages/toolkit/src/functions.ts) issues each call immediately through the single shared MCP client in [`packages/toolkit/src/crawl4ai.ts`](../../packages/toolkit/src/crawl4ai.ts), which has no queue, no concurrency limit, and no explicit per-call timeout. [`packages/toolkit/src/schemas.ts`](../../packages/toolkit/src/schemas.ts) line 94 exposes a pass-through `semaphore_count` (documented default 5) that callers may set, but the toolkit never sets it and does not enforce anything itself. `Config.parallelRequests` (value 3, [`packages/toolkit/src/config.ts`](../../packages/toolkit/src/config.ts)) applies only to SearXNG.
    - Scope:
        - Build a repeatable load harness that drives concurrent crawls from 1 through 10 against the deployed Crawl4AI service.
        - Record per concurrency level: browser count, total container RSS, Python RSS, latency distribution, and failure rate by failure class.
        - Use a mixed corpus: ordinary HTML pages, a known anti-bot challenge page, a download/PDF URL, and a deliberately slow page.
        - Verify explicitly that a failed call does not damage subsequent calls sharing the browser and client — including whether a rotation (`kill_browser`) mid-flight affects in-flight requests.
        - Produce a written recommendation: whether a concurrency cap, a per-call timeout, or a memory limit is warranted, with the numbers that justify it.
        - Out of scope: implementing any cap or limit. That is the follow-up story this research must produce.
    - Acceptance criteria:
        - A re-runnable load harness exists and is documented, including how to point it at a deployment.
        - Results are recorded for concurrency levels 1 through 10 across all four corpus categories.
        - Browser count, container RSS, Python RSS, latency, and failure rate are captured per level.
        - The concurrency level at which failure rate or latency degrades materially is identified, or the report states explicitly that no degradation was observed up to 10.
        - It is stated with evidence whether a failed or rotated call corrupts subsequent calls on the shared browser.
        - A written recommendation names either a specific proposed limit with its supporting numbers, or a documented conclusion that no limit is warranted.
        - Durable findings are folded into [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md), and a follow-up implementation story is proposed.
    - References:
        - [`packages/toolkit/src/crawl4ai.ts`](../../packages/toolkit/src/crawl4ai.ts) — shared MCP client, no queue or per-call timeout
        - [`packages/toolkit/src/rotation.ts`](../../packages/toolkit/src/rotation.ts) — `kill_browser` and the `/monitor/browsers` admin endpoints the harness can poll for browser count
        - [`packages/toolkit/src/schemas.ts`](../../packages/toolkit/src/schemas.ts) line 94 — unenforced `semaphore_count` pass-through
        - [`services/crawl4ai/Dockerfile`](../../services/crawl4ai/Dockerfile) — pinned image `unclecode/crawl4ai:0.9.1`
        - [`docs/PRODUCT.md`](../PRODUCT.md) Phase 3 - Operable Service
        - [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) — Health And Statistics
