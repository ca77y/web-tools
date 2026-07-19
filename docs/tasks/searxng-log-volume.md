---
type: story
title: Reduce SearXNG per-failure log verbosity so logging survives upstream failure
---

# Reduce SearXNG per-failure log verbosity so logging survives upstream failure

- [ ] Reduce SearXNG per-failure log verbosity so logging survives upstream failure #improvement 🔽 🆔 searxng-log-volume ⛔ search-client-fanout-and-timeout-budget
    - Phase: Phase 3 - Operable Service
    - Problem: the logging system fails exactly when the service is under the most stress. On 2026-07-18 at `23:47:12.968054519Z` the SearXNG replica exceeded the hosting platform's limit of 500 logs per second and **372 log messages were dropped**. That window is unrecoverable, so every failure count gathered from SearXNG logs for that incident is a lower bound rather than a true total. This story owns the **per-failure log verbosity** half of the problem: how many lines a single engine failure emits. It does not own the request multiplier that determines how many failures occur — see the dependency note below.
    - Evidence - the dropped-message event:
        - The platform reported the replica exceeded 500 logs per second and dropped 372 messages at `2026-07-18T23:47:12.968054519Z`.
        - Sample failure lines from the same window, each emitted per engine per attempt:

          ```text
          2026-07-18 23:46:35,496 ERROR:searx.engines.wikidata: HTTP error 403 (suspended_time=0)
          2026-07-18 23:46:35,552 ERROR:searx.engines.google cse: google cse: Our systems have detected unusual traffic from your network. (suspended_time=0)
          2026-07-18 23:46:35,576 ERROR:searx.engines.duckduckgo: CAPTCHA (us-en) (suspended_time=0)
          2026-07-18 23:46:35,674 ERROR:searx.engines.brave: Too many request (suspended_time=0)
          2026-07-18 23:46:35,915 ERROR:searx.engines.startpage: get_sc_code: got redirected to https://www.startpage.com/sp/captcha (suspended_time=0)
          ```

        - Several of these failure classes are accompanied by full Python tracebacks rather than the single summary line shown above. A traceback is tens of lines; at the observed failure rate that is what carries the replica past the 500 lines-per-second budget.
    - Evidence - the multiplier that turns per-failure verbosity into an outage (owned by other stories, recorded here for context):
        - `services/searxng/settings.yml` sets `retries: 3` (four attempts per engine per search) with suspension disabled: `suspended_times` zeroed, `ban_time_on_fail: 0`, `max_ban_time_on_fail: 0`. So a permanently blocked engine is retried at full rate and logs on every attempt.
        - `packages/toolkit/src/config.ts:36` sets `parallelRequests: 3`, and `searchSearXNG` (`packages/toolkit/src/searxng.ts:73-75`) fires that many *simultaneous identical* SearXNG requests per user search, triplicating the whole fan-out.
        - Combined: one user search against a broadly failing engine set becomes several hundred outbound provider requests, each capable of emitting a multi-line traceback.
    - Dependency note - why this story is scoped narrowly and sequenced last:
        - The SearXNG-side multiplier (engine allowlist and suspension policy) is owned by [`searxng-engine-set-and-suspension-policy`](./searxng-engine-set-and-suspension-policy.md).
        - The Tools-side multiplier (`parallelRequests` fan-out and timeout budget) is owned by [`search-client-fanout-and-timeout-budget`](./search-client-fanout-and-timeout-budget.md), which itself depends on the engine-set story.
        - Those two stories will remove most of the volume by removing most of the failures. This story runs after them and addresses the residual: making a single genuine engine failure cheap to log. Sequencing it last also means its measurement is taken against the real post-fix baseline rather than a moving one.
        - Do **not** re-litigate `parallelRequests`, `retries`, or the suspension timers here. Those decisions belong to the two stories above and carry a deliberate proxy-rotation rationale documented in `services/searxng/settings.yml`.
    - Scope:
        - Configure SearXNG's logging so a single upstream engine failure emits a bounded summary line rather than a full repeated stack trace: set an appropriate log level and use whatever per-engine error aggregation the pinned SearXNG version supports, in `services/searxng/settings.yml`.
        - Establish the residual log-line rate after the two dependency stories have landed, and confirm it fits within a 500 lines-per-second replica budget with headroom.
        - Preserve attributability: aggregate counts are an acceptable substitute for individual tracebacks, but an operator must still be able to determine which engine failed and how often.
        - Out of scope: changing `parallelRequests`, `outgoing.retries`, the engine allowlist, or the suspension/ban timers (owned by the two stories above); changing the proxy or egress provider; the Web Tools application-side log format (owned by [`request-correlation-logging`](./request-correlation-logging.md)); returning search failure to the caller instead of an empty array (owned by [`distinguish-search-failure-from-empty-results`](./distinguish-search-failure-from-empty-results.md)).
    - Constraints:
        - [`../ARCHITECTURE.md`](../ARCHITECTURE.md) "Runtime Services - SearXNG" keeps metasearch configuration inside the SearXNG service boundary; do not move aggregation behavior into the toolkit.
        - Do not lower the SearXNG log level so far that genuine engine failures become invisible. The goal is fewer lines per failure, not fewer detectable failures. A change that silences errors entirely fails this story.
        - [`../PRODUCT.md`](../PRODUCT.md) Principle 5 ("Operational truth is explicit"): if failures are aggregated, the aggregation must be stated in the operator documentation so counts are not misread as individual events.
    - Acceptance criteria:
        - A single failing SearXNG engine request emits at most a bounded number of log lines, with no full Python traceback; the permitted line count is stated explicitly in `services/searxng/settings.yml` or the accompanying design note.
        - Before-and-after line counts for one user search against a fully failing engine set are measured and recorded in the pull request.
        - The measured post-change rate for that scenario stays under 500 log lines per second, the replica budget that was exceeded on 2026-07-18.
        - An operator can still determine which engine failed and how many times after the change, verified by inspecting the logs from the failing-engine scenario.
        - A normal successful search still returns results from the deployed service after the configuration change, verified by a live smoke test.
        - `parallelRequests`, `outgoing.retries`, the engine allowlist, and the suspension timers are unchanged by this story's diff.
        - Any aggregation or sampling introduced is documented in `docs/ARCHITECTURE.md` so aggregated counts are not misread as individual events.
    - References: [`../ARCHITECTURE.md`](../ARCHITECTURE.md) (Failure Model, Runtime Services - SearXNG), [`../PRODUCT.md`](../PRODUCT.md) (Phase 3 "Logs identify operation, provider, duration, outcome, and safe error context"; Principle 5), `services/searxng/settings.yml`, `packages/toolkit/src/config.ts`, `packages/toolkit/src/searxng.ts`, [`searxng-engine-set-and-suspension-policy`](./searxng-engine-set-and-suspension-policy.md), [`search-client-fanout-and-timeout-budget`](./search-client-fanout-and-timeout-budget.md)
