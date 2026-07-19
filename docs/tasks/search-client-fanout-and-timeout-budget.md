---
type: story
title: Bound the SearXNG client fan-out and fix its timeout budget
---

# Bound the SearXNG client fan-out and fix its timeout budget

- [ ] Bound the SearXNG client fan-out and fix its timeout budget #bug 🔺 🆔 search-client-fanout-and-timeout-budget ⛔ searxng-engine-set-and-suspension-policy
  - Phase: Phase 1 - Reliable Core
  - **Problem.** Every `web_search` call fires three identical concurrent requests to SearXNG, and each is given a client deadline exactly equal to SearXNG's own per-engine deadline. The result is a 3x traffic multiplier on an already-blocked egress path, plus a structural race the client usually loses: in a 1,000-record production sample, 997 of 1,000 Tools-side search failures were client-side timeouts.
  - **Evidence — the triple fan-out.** [`packages/toolkit/src/config.ts:36-37`](../../packages/toolkit/src/config.ts):

    ```ts
    parallelRequests: 3,
    requestTimeout: 15,
    ```

    [`packages/toolkit/src/searxng.ts:70-75`](../../packages/toolkit/src/searxng.ts) turns that into three identical in-flight requests:

    ```ts
    const timeout = Config.requestTimeout;
    const count = Config.parallelRequests;

    const tasks = Array.from({ length: count }, (_, i) =>
      fetchSearXNG(query, { engines: options?.engines, timeout }, i + 1),
    );
    ```

    The three requests carry **identical** query, engines, and categories — there is no diversification (no engine split, no stagger, no varied parameters). They are pure duplicates raced against each other by `raceAll` ([`packages/toolkit/src/searxng.ts:117-145`](../../packages/toolkit/src/searxng.ts)), which returns the first response that has results with non-empty `content`. SearXNG then fans each one out across every active engine, and `outgoing.retries: 3` in [`services/searxng/settings.yml:36`](../../services/searxng/settings.yml) allows up to 4 attempts per engine. One user-facing `web_search` can therefore become several hundred outbound provider requests.
  - **Evidence — the timeout budget is structurally unwinnable.** The client aborts at `Config.requestTimeout` = **15 s** ([`packages/toolkit/src/searxng.ts:35`](../../packages/toolkit/src/searxng.ts)):

    ```ts
    signal: AbortSignal.timeout(options.timeout * 1000),
    ```

    SearXNG's own per-engine timeout is *also* 15 s — [`services/searxng/settings.yml:27-28`](../../services/searxng/settings.yml):

    ```yaml
    request_timeout: 15.0
    max_request_timeout: 20.0
    ```

    Confirmed live in production logs, where an engine consumed the full budget and SearXNG reported it against a 15.0 s limit:

    ```text
    2026-07-18 21:14:28,492 ERROR:searx.engines.duckduckgo: engine timeout
    2026-07-18 21:14:28,693 ERROR:searx.engines.duckduckgo: HTTP requests timeout (search duration : 15.20066828187555 s, timeout: 15.0 s) : TimeoutException
    ```

    Because the two deadlines are equal, any search containing one slow engine is aborted by the client at the same instant SearXNG would have given up on that engine and returned whatever the *other* engines produced. The client throws away a usable partial result it was about to receive. The client budget must exceed SearXNG's worst-case internal budget (which is at least `request_timeout`, and up to `max_request_timeout` = 20 s) plus aggregation and transfer overhead.
  - **Evidence — production failure volume.** Railway project `Agentic-Search` (`81b52d85-de3d-4208-a348-82aa0ef250e6`), environment `production`, Tools deployment `377406fe-1e9d-49fe-a403-a84eaac46d23` at commit `423f31b28976cb694881f431a96a46cfcc4b5b30`. A 1,000-record query of Tools-side search failures, capped by retention, covering `2026-07-18T19:01:39.622542213Z` through `21:14:36.235090544Z`:

    - **997 records**: `The operation was aborted due to timeout`
    - **3 records**: `fetch failed`
    - Peak retained minute: `20:52`, with **114** failure records
    - Largest retained same-millisecond burst: **14** records at `19:03:25.914`

    The triplication is directly visible in the log, three attempts failing within microseconds of each other for a single user request:

    ```text
    [2026-07-18T19:02:31.517842227Z] SearXNG attempt 1 failed: fetch failed
    [2026-07-18T19:02:31.517850313Z] SearXNG attempt 2 failed: fetch failed
    [2026-07-18T19:02:31.517859378Z] SearXNG attempt 3 failed: fetch failed
    ```

    Because the three requests are identical and simultaneous, they share every failure mode — they do not provide redundancy, they only multiply load. The same-millisecond triples also make the failure counts in logs 3x the real number of affected user requests, which distorts every operational read of the logs.
  - **Why this is sequenced behind the SearXNG config story.** The correct client timeout depends on SearXNG's worst-case internal budget, and that budget changes once `searxng-engine-set-and-suspension-policy` restricts the active engine set and introduces non-zero engine suspension. Land that story first, measure the resulting latency distribution, then set the client budget against real numbers rather than the current guess.
  - Scope:
    - Make the SearXNG client's timeout budget strictly greater than SearXNG's worst-case internal budget, so the client stops aborting searches that were about to return partial results. Derive the value from measured post-change latency, and make the relationship between the two timeouts explicit and commented in both files so they cannot silently drift back into equality.
    - Reduce or eliminate the identical triple fan-out. Either drop to a single request, or — if redundancy is still wanted — make the extra requests actually useful (staggered hedge issued only after the first request has visibly stalled, rather than three simultaneous duplicates). A hedge must be bounded and must not reintroduce a fixed 3x multiplier on every call.
    - Make both the fan-out count and the timeout configurable rather than hardcoded constants in `Config`, so an operator can tune them without a code change.
    - Ensure log lines emitted per attempt make it possible to tell how many user requests failed, not just how many attempts failed.
    - Preserve the existing "prefer a response whose results have non-empty `content`" selection behavior, and the URL de-duplication and `limit` truncation at [`packages/toolkit/src/searxng.ts:99-112`](../../packages/toolkit/src/searxng.ts).
    - **Cancel losing requests.** If any concurrency is retained (a hedge), a request still in flight must be aborted once a usable result has been selected. Today nothing cancels the losers: [`packages/toolkit/src/searxng.ts:82-93`](../../packages/toolkit/src/searxng.ts) `break`s out of the `raceAll` loop on the first result with content, but the only abort signal anywhere in the module is the per-request `AbortSignal.timeout` at line 35. The losing requests therefore run to completion against SearXNG and every engine behind it, so work continues on a response Tools has already discarded. Thread an `AbortController` through `fetchSearXNG` and compose it with the existing timeout signal rather than replacing it. Note that [`request-lifecycle-abort-propagation`](./request-lifecycle-abort-propagation.md) separately plans to thread a *caller* disconnect signal through the same code path — the two signal sources must compose, not clobber each other.
    - **Test infrastructure does not exist yet.** The repository currently has no test runner, no `*.test.ts` files anywhere outside `node_modules`, and no `test` script in the root `package.json`. The acceptance criteria below require automated tests, so this story must also introduce a runner. Node's built-in `node:test` is sufficient and adds no dependency.
  - Out of scope:
    - Changing `services/searxng/settings.yml` engine or suspension configuration — that is the blocking story.
    - Changing what `web_search` returns to callers when every attempt fails. Today [`packages/toolkit/src/searxng.ts:95-114`](../../packages/toolkit/src/searxng.ts) falls through to `rawResults = []` and returns `{ data: [] }`, so total upstream failure is indistinguishable from a legitimate no-result search — a direct violation of the "Failures are data, not empty arrays" principle in [`../PRODUCT.md`](../PRODUCT.md). That is a real defect and it is deliberately **not** fixed here: it is a public contract change to `web_search` affecting MCP, REST, and CLI, and belongs in its own story — it is carded separately as [`distinguish-search-failure-from-empty-results.md`](./distinguish-search-failure-from-empty-results.md). Do not change the return contract as a side effect of this one; coordinate with that story, since both touch `searchSearXNG`.
    - Replacing the proxy/egress path — see [`../issues/searxng-egress-proxy-reputation.md`](../issues/searxng-egress-proxy-reputation.md).
  - Acceptance criteria:
    - A single `web_search` call issues fewer than three simultaneous identical requests to SearXNG, verifiable by counting requests observed at the SearXNG service for one search.
    - If a hedged retry is retained, it is issued only after a delay rather than simultaneously, and the delay is configurable.
    - The client-side timeout is strictly greater than SearXNG's configured `max_request_timeout`, and a comment in both `packages/toolkit/src/config.ts` and `services/searxng/settings.yml` states the required ordering.
    - A search in which one engine is slow but others succeed returns those other engines' results instead of aborting, verified with a test that simulates a slow upstream.
    - Fan-out count and request timeout are both readable from environment configuration with the current values as defaults.
    - Automated tests cover: a successful single request; an upstream that exceeds the client timeout; an upstream returning results with empty `content` alongside one with content (the content-preferring path is still honoured); and duplicate URLs across results (de-duplication still applied).
    - If any concurrency is retained, a request still in flight is aborted once a usable result has been selected, observable as a client disconnect at a SearXNG stub rather than a request left open until its own timeout expires.
    - A test runner and a `test` script exist and the new suite runs green via that script (the repository has none today).
    - `pnpm build` and `pnpm typecheck` pass.
    - Post-change, a repeat of the production log query no longer shows same-millisecond triples of `SearXNG attempt N failed` for a single user request.
  - References:
    - [`packages/toolkit/src/searxng.ts`](../../packages/toolkit/src/searxng.ts) — `fetchSearXNG` (lines 21-62), `searchSearXNG` fan-out (65-115), `raceAll` (117-145)
    - [`packages/toolkit/src/config.ts`](../../packages/toolkit/src/config.ts) — `parallelRequests: 3`, `requestTimeout: 15` (lines 36-37); `SEARXNG_URL`, `SEARXNG_ENGINES`, `SEARXNG_CATEGORIES` env schema (lines 4-6)
    - [`packages/toolkit/src/functions.ts`](../../packages/toolkit/src/functions.ts) — `web_search` handler (lines 103-114), the sole caller
    - [`services/searxng/settings.yml`](../../services/searxng/settings.yml) — `outgoing.request_timeout`, `max_request_timeout`, `retries` (lines 26-36)
    - [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — "Failure Model" ("Retries must be bounded and limited to operations known to be safe"), toolkit package boundary
    - [`../PRODUCT.md`](../PRODUCT.md) — Phase 1 exit condition "Search retry and deduplication behavior is bounded and testable"
    - Blocked by: [`searxng-engine-set-and-suspension-policy.md`](./searxng-engine-set-and-suspension-policy.md)
