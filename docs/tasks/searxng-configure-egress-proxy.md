---
type: story
title: Configure egress proxying for SearXNG
---

# Configure egress proxying for SearXNG

- [ ] Configure egress proxying for SearXNG #bug 🔺 🆔 searxng-configure-egress-proxy
  - Phase: Phase 1 - Reliable Core
  - **Problem.** Production SearXNG has no proxy configured. It egresses directly from the Railway datacenter IP, and search providers block datacenter traffic. Five of the (then) seven allowlisted engines failed on every query as a result, leaving `web_search` running on `bing` and `brave` alone. (The allowlist has since been revised to nine engines — see the 2026-07-24 correction below.)
  - **Evidence — `PROXY_URL` is unset in production.** [`services/searxng/Dockerfile`](../../services/searxng/Dockerfile)'s entrypoint branches on `PROXY_URL` and echoes the branch it took. Deployment `01de4f18-8c5a-4265-bd2a-dfe8d99e2be8` (Railway project `Agentic-Search`, `production`, 2026-07-23T21:25:22Z) logs:

    ```text
    Proxy: disabled
    ```

    The `else` branch runs `sed '/proxies:/,/PROXY_URL}/d'`, which strips the entire `proxies:` block from the generated `settings.yml`. Every setting in [`services/searxng/settings.yml`](../../services/searxng/settings.yml) tuned for a rotating residential pool — US geo-targeting, rotating rather than sticky sessions, the `pool_maxsize: 20` keep-alive decision measured at 3/12 vs 7/10 — is currently inert, as is the `outgoing.retries: 3` exit-IP rotation, which re-uses the same datacenter IP on all four attempts.
  - **Evidence — the engines work from a clean IP.** Six sequential queries per engine, run 2026-07-23 against the identical engine set. The production arm used the deployed `web_search`; the clean arm used the local Compose stack on a residential connection.

    | Engine | Clean residential IP | Production (datacenter, unproxied) |
    |---|---|---|
    | `mojeek` | 6/6 results | fails every attempt |
    | `qwant` | 6/6 results | fails every attempt |
    | `google cse` | 6/6, ~20 results each | fails ("unusual traffic from your network") |
    | `duckduckgo` | 3/6 (CAPTCHA) | fails every attempt |
    | `bing` | 6/6 results | works |
    | `brave` | works | works |

    Mojeek and Qwant were previously believed permanently blocked. They are not — the egress path is the variable. Full evidence and caveats in [`../issues/searxng-egress-proxy-reputation.md`](../issues/searxng-egress-proxy-reputation.md).
  - **Correction 2026-07-24 — two rows of the table above are superseded.** Single-variable tests on the stock image (see ARCHITECTURE's "2026-07-24 engine-set revision") showed: the `mojeek` failures were **configuration-driven, not egress-driven** — `default_lang: en` resolves to locale cookies that trip mojeek's bot detection from any IP; fixed with `default_lang: auto`. `qwant` fails from **every** IP (Datadome) and was removed from the allowlist. `duckduckgo` was replaced by `duckduckgo web`, and `yandex`, `dogpile`, `gmx` were added — the allowlist is now nine engines, and production re-measurement under this story should measure those nine. The `google cse`/`duckduckgo`/`bing`/`brave` rows and the core finding (production egresses unproxied from a datacenter IP and is blocked where a residential IP is not) stand.
  - **Why this is now a story rather than an issue note.** The issue note concluded no fix existed on our side because it assumed we were already on a third-party residential pool whose reputation we could not influence. That premise was wrong — there is no proxy at all — so the fix is ordinary configuration, not procurement of a *better* pool.
  - Scope:
    - Choose an egress proxy provider and geo policy, and record the decision and its operating cost.
    - Set `PROXY_URL` on the SearXNG service in Railway, in the format the `proxies:` block expects.
    - Confirm the deployed service logs `Proxy: enabled` at boot.
    - Re-measure all nine allowlisted engines from production and record the per-engine result in [`../ARCHITECTURE.md`](../ARCHITECTURE.md).
    - Re-evaluate `search.suspended_times` against the proxied behaviour. The current values are calibrated for a rotation that has never actually run.
    - Decide whether `wikipedia` stays in the allowlist — it is infobox-only and contributes zero entries to `results` (measured 2026-07-24: entity queries return `results=0, infoboxes=1`; a `wikipedia`-only toolkit search correctly fails with HTTP 500 rather than succeeding empty).
  - Out of scope:
    - Changing the engine allowlist itself, beyond the `wikipedia` decision above.
    - Any change to `packages/toolkit` fan-out or timeout budget.
    - Building proxy-health observability — tracked in [`../issues/proxy-exit-ip-health-unverifiable.md`](../issues/proxy-exit-ip-health-unverifiable.md).
  - **Caveat — a proxy is not guaranteed to fix every engine.** The clean-IP arm was a residential connection. A commercial proxy pool is shared with other customers and may carry its own poor reputation; that is exactly the situation the original issue note described. Treat "engines recover" as the hypothesis to verify after the change, not as a settled outcome, and keep the per-engine measurement above as the baseline to compare against.
  - Acceptance criteria:
    - The deployed SearXNG service logs `Proxy: enabled` at boot.
    - A production search with no explicit `engines` argument returns results from more than the two engines that work today, evidenced by a per-engine measurement.
    - The per-engine production results are recorded in [`../ARCHITECTURE.md`](../ARCHITECTURE.md), replacing the "two of seven" baseline.
    - The chosen provider, geo policy, and operating cost are documented.
    - [`../issues/searxng-egress-proxy-reputation.md`](../issues/searxng-egress-proxy-reputation.md) is removed or reduced to whatever genuinely remains unsolved after the change.
  - References:
    - [`../issues/searxng-egress-proxy-reputation.md`](../issues/searxng-egress-proxy-reputation.md) — evidence trail and the performed reproduction
    - [`services/searxng/settings.yml`](../../services/searxng/settings.yml) — `outgoing.proxies`, suspension policy
    - [`services/searxng/Dockerfile`](../../services/searxng/Dockerfile) — the `PROXY_URL` entrypoint branch
    - [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — engine allowlist and suspension policy
    - Related: [`searxng-engine-set-and-suspension-policy.md`](./searxng-engine-set-and-suspension-policy.md), [`search-client-fanout-and-timeout-budget.md`](./search-client-fanout-and-timeout-budget.md)
