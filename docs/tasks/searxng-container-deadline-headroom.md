---
type: story
title: Send an explicit SearXNG timeout_limit so the result container outlives its engines
---

# Send an explicit SearXNG timeout_limit so the result container outlives its engines

- [ ] Send an explicit SearXNG timeout_limit so the result container outlives its engines #bug 🔽 🆔 searxng-container-deadline-headroom ⛔ search-client-fanout-and-timeout-budget
    - Phase: Phase 1 - Reliable Core
    - **Problem.** SearXNG closes a search's result container at the exact moment its slowest engine is still 200ms away from its own HTTP deadline. Every engine that actually times out therefore reports its failure into an already-closed container, and SearXNG logs an `ERROR` for it. This is deterministic, not a flaky race. The fix is a single request parameter we currently never send.
    - **Evidence — observed production logs** (SearXNG service, 2026-07-18 UTC):

      ```text
      2026-07-18 21:14:28,492 ERROR:searx.engines.duckduckgo: engine timeout
      2026-07-18 21:14:28,692 ERROR:searx: call to ResultContainer.add_unresponsive_engine after ResultContainer.close
      2026-07-18 21:14:28,692 ERROR:searx: call to ResultContainer.add_unresponsive_engine after ResultContainer.close
      2026-07-18 21:14:28,694 ERROR:searx: call to ResultContainer.add_unresponsive_engine after ResultContainer.close
      2026-07-18 21:14:28,693 ERROR:searx.engines.duckduckgo: HTTP requests timeout (search duration : 15.20066828187555 s, timeout: 15.0 s) : TimeoutException
      ```

      Note the exact interval: the container-close error lands at `.692`, exactly 200ms after the `engine timeout` at `.492`. The engine's own reported duration is `15.2007 s` against a `15.0 s` limit. The threefold duplication corresponds to the client's three identical concurrent requests (`parallelRequests: 3`, `packages/toolkit/src/config.ts:36`) — one racing engine per in-flight SearXNG search. In the same incident window SearXNG exceeded the host platform's per-replica log rate and 372 messages were dropped, so this ERROR-level noise displaces genuinely diagnostic logs.
    - **Root cause — verified against upstream source** (`searxng/searxng` master; our image is built `FROM searxng/searxng:latest`, `services/searxng/Dockerfile:1`):
        - `searx/search/__init__.py`, `Search._get_requests()` computes `default_timeout = max(processor.engine.timeout)` across the loaded engines, then selects the container deadline through a four-branch dispatch on `max_request_timeout` (from settings) and `query_timeout` (the request's `timeout_limit`):

          ```python
          max_request_timeout = settings['outgoing']['max_request_timeout']
          actual_timeout = default_timeout
          query_timeout = self.search_query.timeout_limit

          if max_request_timeout is None and query_timeout is None:
              pass
          elif max_request_timeout is None and query_timeout is not None:
              actual_timeout = min(default_timeout, query_timeout)
          elif max_request_timeout is not None and query_timeout is None:
              actual_timeout = min(default_timeout, max_request_timeout)
          elif max_request_timeout is not None and query_timeout is not None:
              # Max & user query: From user query except if above max
              actual_timeout = min(query_timeout, max_request_timeout)
          ```

        - We currently hit the **third** branch, because `services/searxng/settings.yml:28` sets `max_request_timeout: 20.0` but our client never sends `timeout_limit`. That gives `actual_timeout = min(15.0, 20.0)` = **15.0s**.
        - `Search.search_multiple_requests()` joins each engine thread against that deadline; a thread still alive is flagged `th._timeout = True` and recorded via `add_unresponsive_engine(...)` (correct — container still open). The abandoned thread is **not cancelled** and keeps running. `SearchWithPlugins.search()` then calls `result_container.close()`, setting `_closed = True`.
        - `searx/network/__init__.py`, `_get_timeout()` adds a fixed allowance: `timeout += 0.2  # overhead`. So an engine's effective HTTP deadline is `engine.timeout + 0.2` = **15.2s**, while the container closed at **15.0s** — exactly the 200ms gap seen in the logs above.
        - At 15.2s the abandoned thread's request times out; `searx/search/processors/online.py` catches `httpx.TimeoutException` and calls `handle_exception()` → `add_unresponsive_engine(...)`, which in `searx/results.py` hits the closed guard and logs the error:

          ```python
          def add_unresponsive_engine(self, engine_name: str, error_type: str, suspended: bool = False):
              with self._lock:
                  if self._closed:
                      log.error("call to ResultContainer.add_unresponsive_engine after ResultContainer.close")
                      return
          ```

    - **The fix.** The **fourth** branch computes `actual_timeout = min(query_timeout, max_request_timeout)` — it does not involve `default_timeout` at all. So sending an explicit `timeout_limit` lifts the container deadline clear of the engine HTTP deadline. With `max_request_timeout: 20.0` already configured, sending `timeout_limit=16` yields `min(16, 20)` = **16s** > 15.2s, so the engine's own timeout exception lands while the container is still open and is recorded normally, with no error.
        - `timeout_limit` is an ordinary request parameter. `searx/webadapter.py`, `parse_timeout()` reads it via `raw_text_query.timeout_limit` then falls back to `form.get('timeout_limit')`, and query-string args are merged into `form`. Our client already assembles `URLSearchParams` at `packages/toolkit/src/searxng.ts:28`, so this is a small, contained change.
    - **Why this is sequenced behind `search-client-fanout-and-timeout-budget`.** Raising SearXNG's internal deadline while the client still aborts at 15.0s (`packages/toolkit/src/config.ts:37`, `AbortSignal.timeout` at `packages/toolkit/src/searxng.ts:35`) would make things strictly worse: the server would run to 16s and the client would abort every such search. The client budget must be raised above the new container deadline first. That story owns the client budget; this one owns the server-side deadline. The required ordering across all three values is:

      ```text
      max engine timeout + 0.2  <  timeout_limit  <=  max_request_timeout  <  client abort timeout
      ```

    - Scope:
        - Send an explicit `timeout_limit` parameter on SearXNG search requests from `packages/toolkit/src/searxng.ts`, chosen to exceed the maximum loaded engine's HTTP deadline (`engine timeout + 0.2`) while remaining at or below `outgoing.max_request_timeout`.
        - Make the value configurable rather than a bare literal, consistent with however `search-client-fanout-and-timeout-budget` exposes the client budget.
        - Record the four-value ordering constraint as a comment in both `packages/toolkit/src/config.ts` and `services/searxng/settings.yml`, so the budgets cannot silently drift back into collision.
        - Add regression coverage for the ordering constraint.
        - Out of scope: the client abort budget and the fan-out count (owned by `search-client-fanout-and-timeout-budget`); the SearXNG engine allowlist and suspension policy (owned by `searxng-engine-set-and-suspension-policy`); broader SearXNG log-volume reduction (owned by `searxng-log-volume`); returning an error instead of an empty array when all attempts fail.
    - Acceptance criteria:
        - SearXNG search requests issued by `packages/toolkit/src/searxng.ts` include a `timeout_limit` query parameter.
        - The configured `timeout_limit` is strictly greater than the maximum loaded engine timeout plus 0.2s, and is less than or equal to `outgoing.max_request_timeout` in `services/searxng/settings.yml`.
        - The configured `timeout_limit` is strictly less than the client abort timeout.
        - A test fails if `timeout_limit` is set outside the ordering constraint on either side.
        - A comment stating the full four-value ordering appears in both `packages/toolkit/src/config.ts` and `services/searxng/settings.yml`.
        - A search in which one engine exceeds its timeout produces no `call to ResultContainer.add_unresponsive_engine after ResultContainer.close` line in SearXNG logs, verified against a stubbed or deliberately slow engine.
        - That same search still returns results from the engines that did respond.
        - `pnpm build` and `pnpm typecheck` pass.
    - Notes and constraints:
        - **The correct value depends on knowing the loaded engine set.** `services/searxng/settings.yml:1` sets `use_default_settings: true`, which means the seven entries under `engines:` (lines 55-93) are per-engine *overrides layered on the full upstream default engine set*, not an allowlist — so more engines load than are listed, and the true maximum engine timeout is not currently knowable from our config alone. `searxng-engine-set-and-suspension-policy` replaces this with an explicit `engines.keep_only` allowlist; landing it first makes the maximum determinate. That story is already the blocker of this story's blocker, so the ordering works out, but confirm the loaded set before fixing the number.
        - **Impact is log volume, not lost results** — hence the low priority. The engine was already recorded as unresponsive by the join loop before `close()`, so the late call is a duplicate and discarding it is correct. Results returned to the caller are unaffected. The cost is ERROR-level log budget under exactly the load conditions where logs matter most.
        - Separately, `ResultContainer.extend()` drops results from an engine that completes after close (`log.debug("container is closed, ignoring results: %s", results)`). Raising the container deadline also widens the window in which a slow-but-successful engine's results are still accepted, a secondary benefit.
        - `services/searxng/Dockerfile:1` pins `searxng/searxng:latest`, so the upstream timing internals above can change without any change in this repository. Pinning a digest would make this analysis reproducible; raise it as a question rather than treating it as scoped here.
    - References:
        - [`packages/toolkit/src/searxng.ts`](../../packages/toolkit/src/searxng.ts) — `URLSearchParams` assembly (line 28), `AbortSignal.timeout` (line 35)
        - [`packages/toolkit/src/config.ts`](../../packages/toolkit/src/config.ts) — `parallelRequests: 3`, `requestTimeout: 15` (lines 36-37)
        - [`services/searxng/settings.yml`](../../services/searxng/settings.yml) — `use_default_settings` (line 1), `request_timeout`/`max_request_timeout` (lines 27-28), `retries` (line 36), `engines:` (lines 55-93)
        - [`services/searxng/Dockerfile`](../../services/searxng/Dockerfile) — image base (line 1)
        - Upstream: `searx/search/__init__.py` (`_get_requests`, `search_multiple_requests`, `SearchWithPlugins.search`), `searx/network/__init__.py` (`_get_timeout`), `searx/results.py` (`ResultContainer.close`, `add_unresponsive_engine`, `extend`), `searx/webadapter.py` (`parse_timeout`), `searx/search/processors/online.py`, `searx/search/processors/abstract.py`
        - [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — Failure Model ("Cancellation and timeout signals should propagate through the toolkit to provider clients where supported")
        - [`../PRODUCT.md`](../PRODUCT.md) — Phase 1 exit condition "Search retry and deduplication behavior is bounded and testable"
        - Blocked by: [`search-client-fanout-and-timeout-budget.md`](./search-client-fanout-and-timeout-budget.md); related: [`searxng-engine-set-and-suspension-policy.md`](./searxng-engine-set-and-suspension-policy.md), [`searxng-log-volume.md`](./searxng-log-volume.md)
</content>
