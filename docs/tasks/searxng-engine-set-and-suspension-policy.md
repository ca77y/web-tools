---
type: story
title: Restrict the SearXNG engine set and bound engine failure suspension
---

# Restrict the SearXNG engine set and bound engine failure suspension

- [<] Restrict the SearXNG engine set and bound engine failure suspension #bug ⏫ 🆔 searxng-engine-set-and-suspension-policy
  - Phase: Phase 1 - Reliable Core
  - **Problem.** Our SearXNG instance runs engines we never configured, and retries permanently-blocked engines forever. Together these generate hundreds of avoidable upstream failures per hour and amplify the traffic that gets our egress blocked.
  - **Evidence — unintended engines are active.** [`services/searxng/settings.yml`](../../services/searxng/settings.yml) sets `use_default_settings: true` (line 1) and then lists exactly seven engines under `engines:` (lines 55-93): `google`, `brave`, `duckduckgo`, `bing`, `qwant`, `mojeek`, `wikipedia`. Production logs from 2026-07-18 show three engines that appear nowhere in that list producing failures: `wikidata`, `google cse`, and `startpage`.
  - **Root cause (confirmed against upstream docs).** With `use_default_settings: true`, a local `engines:` list does **not** restrict the engine set. Per <https://docs.searxng.org/admin/settings/settings.html#use-default-settings>: "With `use_default_settings: true`, each settings can be override in a similar way, the `engines` section is merged according to the engine `name`... SearXNG will load **all the default engines**". Our seven entries are therefore per-engine *overrides* layered on top of the full upstream default engine set, not an allowlist. The documented mechanism to restrict the set is the mapping form of `use_default_settings`:

    ```yaml
    use_default_settings:
      engines:
        keep_only:
          - google
          - duckduckgo
    ```

    A `remove:` list is also supported for the inverse. Note that adopting either form means replacing the scalar `use_default_settings: true` with a mapping — the two forms are alternatives, not additive.
  - **Evidence — failure volume by engine.** A 1,000-record sample of SearXNG warnings covering `2026-07-18 20:57:57.580` through `23:46:58.944` UTC (Railway project `Agentic-Search`, `production`, SearXNG deployment `15ce2b88-cb4b-49f6-a3c6-72e97fd99db9`). The sample is a lower bound: SearXNG exceeded Railway's per-replica log rate at `2026-07-18T23:47:12.968054519Z` and 372 further messages were dropped.

    | Failure class | Retained warnings | Engines |
    |---|---:|---|
    | Access denied / HTTP 403 | 288 | wikidata 101, mojeek 94, qwant 93 |
    | Rate limited / unusual traffic | 201 | brave 102, google cse 96, wikipedia 3 |
    | CAPTCHA | 99 | startpage 93, duckduckgo 6 |
    | Timeout | 117 | duckduckgo 117 |

    **290 of the 705 non-timeout failures (41%) came from `wikidata`, `google cse`, and `startpage` — engines we never intended to run at all.** Disabling them is pure loss elimination with zero impact on intended result quality.
  - **Representative log lines** (verbatim, with the exact request addresses that were retained):

    ```text
    2026-07-18 23:46:35,495 WARNING:searx.network.wikidata: HTTP Request failed: POST https://query.wikidata.org/sparql
    2026-07-18 23:46:35,496 ERROR:searx.engines.wikidata: HTTP error 403 (suspended_time=0)

    2026-07-18 23:46:35,552 ERROR:searx.engines.google cse: google cse: Our systems have detected unusual traffic from your network. (suspended_time=0)

    2026-07-18 23:46:35,915 ERROR:searx.engines.startpage: get_sc_code: got redirected to https://www.startpage.com/sp/captcha (suspended_time=0)

    2026-07-18 23:46:35,673 WARNING:searx.network.brave: HTTP Request failed: GET https://search.brave.com/search?q=Railway+cloud+deployment+platform&source=web
    2026-07-18 23:46:35,674 ERROR:searx.engines.brave: Too many request (suspended_time=0)

    2026-07-18 21:14:28,492 ERROR:searx.engines.duckduckgo: engine timeout
    2026-07-18 21:14:28,693 ERROR:searx.engines.duckduckgo: HTTP requests timeout (search duration : 15.20066828187555 s, timeout: 15.0 s) : TimeoutException

    2026-07-18 23:46:35,576 ERROR:searx.engines.duckduckgo: CAPTCHA (us-en) (suspended_time=0)

    2026-07-18 20:57:59,509 WARNING:searx.engines.wikipedia: ... SearxEngineTooManyRequestsException ... Too many request (suspended_time=0)
    ```

  - **Evidence — no engine is ever suspended.** Every single failure line above ends in `suspended_time=0`. [`services/searxng/settings.yml:15-24`](../../services/searxng/settings.yml) zeroes the entire suspension and ban system:

    ```yaml
    # Never suspend engines — retry immediately (useful with rotating proxies)
    suspended_times:
      SearxEngineAccessDenied: 0
      SearxEngineCaptcha: 0
      SearxEngineTooManyRequests: 0
      cf_SearxEngineCaptcha: 0
      cf_SearxEngineAccessDenied: 0
      recaptcha_SearxEngineCaptcha: 0
    ban_time_on_fail: 0
    max_ban_time_on_fail: 0
    ```

    Upstream defaults (<https://docs.searxng.org/admin/settings/settings_search.html>) are `SearxEngineAccessDenied: 86400`, `SearxEngineCaptcha: 86400`, `SearxEngineTooManyRequests: 3600`, `cf_SearxEngineCaptcha: 1296000`, `cf_SearxEngineAccessDenied: 86400`, `recaptcha_SearxEngineCaptcha: 604800`, `ban_time_on_fail: 5`, `max_ban_time_on_fail: 120`. We are at zero across the board, so an engine that is permanently blocked for us (Wikidata 403, Mojeek 403) is re-attempted on every single search forever, with no circuit breaker.
  - **The zeroing was deliberate — do not blindly revert it.** The in-file comment and [`services/searxng/settings.yml:30-36`](../../services/searxng/settings.yml) explain the intent: Google `/sorry/`-blocks a fraction of rotating residential exit IPs, `google_sorry_fix.py` converts a 302/sorry into an immediate-retry CAPTCHA, and `outgoing.retries: 3` (4 total attempts) then rotates to a fresh exit IP, so ~99% of attempts land a clean IP. Zero suspension is what makes that rotation strategy work. The defect is that the policy is applied **globally and unconditionally**, including to engines whose blocking is by ASN or request fingerprint rather than by IP, where retrying cannot help.
  - **Traffic multiplier.** `outgoing.retries: 3` means up to 4 attempts per engine per search. The Tools client independently fires 3 identical concurrent SearXNG searches per `web_search` call (`Config.parallelRequests: 3` at [`packages/toolkit/src/config.ts:36`](../../packages/toolkit/src/config.ts), fanned out at [`packages/toolkit/src/searxng.ts:73-75`](../../packages/toolkit/src/searxng.ts)). With the full default engine set active, one user-facing search can become several hundred outbound provider requests. That volume is itself a plausible contributor to the `brave`/`wikipedia` rate-limiting and the `google cse` "unusual traffic" response. The Tools-side half of this multiplier is owned by the separate story `search-client-fanout-and-timeout-budget`; this story owns the SearXNG-side half.
  - Scope:
    - Replace `use_default_settings: true` with the mapping form carrying an explicit `engines.keep_only` allowlist, so only intended engines load.
    - Decide and document the intended engine set. Start from the seven already listed (`google`, `brave`, `duckduckgo`, `bing`, `qwant`, `mojeek`, `wikipedia`) and drop any that the evidence shows are unusable through our egress — see the caveat below on `mojeek` and `qwant`.
    - Replace the blanket zero-suspension policy with a differentiated one: keep `0` (or a very small value) only for the failure classes where exit-IP rotation genuinely recovers the request (the Google `/sorry/` CAPTCHA path the `google_sorry_fix.py` design depends on), and set a bounded non-zero suspension for classes that indicate durable per-ASN or per-fingerprint blocking (`SearxEngineAccessDenied`, `SearxEngineTooManyRequests`). Values should be short enough to recover within an operator's patience (order of minutes, not the upstream 24 hours) but long enough to stop per-search retry storms.
    - Set a bounded non-zero `ban_time_on_fail` / `max_ban_time_on_fail` for the same reason.
    - Preserve the existing `google_sorry_fix.py` behavior and the proxy-injection entrypoint in [`services/searxng/Dockerfile`](../../services/searxng/Dockerfile) (the `sed` that strips the `proxies:` block when `PROXY_URL` is unset must still work against the edited file).
    - Record the chosen engine set and suspension values, with their rationale, in the durable docs.
  - Out of scope:
    - Any change to `packages/toolkit` — the client-side fan-out and timeout budget belong to `search-client-fanout-and-timeout-budget`.
    - Changing or replacing the proxy/egress provider. The underlying exit-IP reputation problem is tracked separately in [`../issues/searxng-egress-proxy-reputation.md`](../issues/searxng-egress-proxy-reputation.md); this story reduces avoidable load but does not claim to fix egress reputation.
    - Changing how `web_search` reports failure to callers.
  - **Caveat on `mojeek` and `qwant`.** Both are in our intended list yet returned 403 / access-denied 94 and 93 times respectively in the sample. Their blocking is very likely egress-reputation driven rather than configuration driven. Do **not** silently drop them from `keep_only` as part of this story without evidence; treat "keep and suspend on failure" as the default and record the decision. See the linked issue note.
  - Acceptance criteria:
    - `services/searxng/settings.yml` uses the mapping form of `use_default_settings` with an explicit `engines.keep_only` allowlist.
    - With the service running, the set of engines reported active by SearXNG's `GET /config` endpoint contains only the intended allowlisted engines and no others.
    - `wikidata`, `google cse`, and `startpage` are absent from that active engine set.
    - `suspended_times`, `ban_time_on_fail`, and `max_ban_time_on_fail` are no longer uniformly `0`; each non-zero value has an in-file comment stating why that class is suspended and why zero was kept where it was kept.
    - The Google `/sorry/` immediate-retry path still has an effective suspension short enough for `outgoing.retries` rotation to work, and this is stated in a comment.
    - A search issued against the deployed service returns results, confirming the allowlist did not disable the working engines.
    - Building the SearXNG image succeeds and the `PROXY_URL`-unset entrypoint branch still produces a valid `settings.yml` (verify by running the container without `PROXY_URL` and confirming it starts and logs `Proxy: disabled`).
    - The chosen engine set and suspension policy, with rationale, are documented in [`../ARCHITECTURE.md`](../ARCHITECTURE.md).
  - References:
    - [`services/searxng/settings.yml`](../../services/searxng/settings.yml) — lines 1 (`use_default_settings`), 15-24 (suspension), 26-53 (`outgoing`/proxy), 55-93 (engines)
    - [`services/searxng/Dockerfile`](../../services/searxng/Dockerfile) — image build, `google_sorry_fix.py` patch, proxy-injection entrypoint
    - [`services/searxng/google_sorry_fix.py`](../../services/searxng/google_sorry_fix.py)
    - [`packages/toolkit/src/config.ts`](../../packages/toolkit/src/config.ts) — `parallelRequests: 3`, `requestTimeout: 15`
    - [`packages/toolkit/src/searxng.ts`](../../packages/toolkit/src/searxng.ts) — client fan-out
    - SearXNG `use_default_settings` / `keep_only`: <https://docs.searxng.org/admin/settings/settings.html#use-default-settings>
    - SearXNG `search:` suspension defaults: <https://docs.searxng.org/admin/settings/settings_search.html>
    - SearXNG `outgoing:` options: <https://docs.searxng.org/admin/settings/settings_outgoing.html>
    - [`../PRODUCT.md`](../PRODUCT.md) — Phase 1 "Reliable Core"; [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — SearXNG service boundary
    - Related: [`search-client-fanout-and-timeout-budget.md`](./search-client-fanout-and-timeout-budget.md), [`../issues/searxng-egress-proxy-reputation.md`](../issues/searxng-egress-proxy-reputation.md)
