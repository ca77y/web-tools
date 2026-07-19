# SearXNG egress/proxy reputation blocking

**Status:** open. No fix identified on our side. The leading hypothesis — egress exit-IP/ASN reputation — is **strongly supported but not yet confirmed**: the discriminating experiment in "Reproduction" below has not been run. Treat the conclusion as a well-evidenced working hypothesis, not a settled finding.
**First observed:** 2026-07-17 through 2026-07-18 UTC, Railway project `Agentic-Search` (`81b52d85-de3d-4208-a348-82aa0ef250e6`), environment `production`, SearXNG deployment `15ce2b88-cb4b-49f6-a3c6-72e97fd99db9`
**Covers:** Mojeek HTTP 403, Qwant access denied, and the general cross-provider blocking pattern

## Problem

Independent, unrelated search providers reject our SearXNG instance's requests at nearly the same moment, for unrelated queries, with the full range of anti-bot responses: HTTP 403, "access denied", CAPTCHA redirects, rate limiting, and an explicit "unusual traffic from your network" message. The pattern points at the reputation of the egress path (the rotating residential proxy pool's exit IPs and their ASNs) rather than at anything in a specific query or a specific engine's configuration.

Two engines in our *intended* engine set are affected badly enough that they contribute almost no usable results:

### Mojeek — HTTP 403

Retained warning count in the sample: **94**.

```text
2026-07-18 23:46:35,567 WARNING:searx.network.mojeek: HTTP Request failed: GET https://www.mojeek.com/search?q=Railway+cloud+deployment+platform&safe=0
2026-07-18 23:46:35,570 ERROR:searx.engines.mojeek: HTTP error 403 (suspended_time=0)
```

Request addresses retained in logs:

```text
https://www.mojeek.com/search?q=livestore.dev+local-first&safe=0
https://www.mojeek.com/search?q=Railway+cloud+deployment+platform&safe=0
https://www.mojeek.com/search?q=Claude+Code+subagent+frontmatter+effort+field+%22Available+levels+depend+on+the+model%22&safe=0
```

### Qwant — access denied

Retained warning count in the sample: **93**. The exact Qwant request URL was not retained by SearXNG's logging.

```text
2026-07-18 23:46:35,564 ERROR:searx.engines.qwant: Access denied (suspended_time=0)
```

## Evidence

A 1,000-record sample of SearXNG warnings covering `2026-07-18 20:57:57.580` through `23:46:58.944` UTC. The sample is a lower bound: SearXNG exceeded Railway's per-replica logging rate at `2026-07-18T23:47:12.968054519Z` and Railway reported 372 further messages dropped.

| Failure class | Retained warnings | Engines |
|---|---:|---|
| Access denied / HTTP 403 | 288 | wikidata 101, mojeek 94, qwant 93 |
| Rate limited / unusual traffic | 201 | brave 102, google cse 96, wikipedia 3 |
| CAPTCHA | 99 | startpage 93, duckduckgo 6 |
| Timeout | 117 | duckduckgo 117 |

The strongest single piece of evidence is Google explicitly naming the network as the reason:

```text
2026-07-18 23:46:35,552 ERROR:searx.engines.google cse: google cse: Our systems have detected unusual traffic from your network. (suspended_time=0)
```

Supporting signals, all within the same sample:

- Seven or more independent providers reject the same searches within the same second (note the near-identical timestamps at `23:46:35` across `wikidata`, `google cse`, `qwant`, `duckduckgo`, `mojeek`, `brave`, and `startpage`). **Weigh this carefully**: the *simultaneity* alone proves nothing, because SearXNG queries all active engines concurrently by design, so every engine's outcome lands in the same second whether or not a proxy is involved. What is informative is that the outcomes are near-uniformly *rejections* across providers with entirely unrelated anti-bot stacks — not that they arrived together.
- Startpage redirects to `https://www.startpage.com/sp/captcha`; DuckDuckGo returns `CAPTCHA (us-en)`.
- Blocking persisted across a roughly 2.5-hour idle gap — DuckDuckGo timed out at `21:14:28` and was still being CAPTCHA'd at `23:46:35` — so this is not a short-lived burst penalty that decays on its own.
- Failures recur across completely unrelated query subjects (`livestore.dev local-first`, `Railway cloud deployment platform`, `Claude Code subagent frontmatter effort field`).

## What was investigated

1. **Engine configuration.** [`services/searxng/settings.yml`](../../services/searxng/settings.yml) was reviewed in full. A real configuration defect was found — `use_default_settings: true` does not restrict the engine set, so unintended engines (`wikidata`, `google cse`, `startpage`) were running. That defect is genuine and is tracked as a fixable story at [`../tasks/searxng-engine-set-and-suspension-policy.md`](../tasks/searxng-engine-set-and-suspension-policy.md). It explains *which* engines were failing but not *why* the configured ones (`mojeek`, `qwant`, `brave`, `duckduckgo`) are blocked.
2. **Request volume amplification.** Confirmed a large multiplier: `Config.parallelRequests: 3` at [`packages/toolkit/src/config.ts:36`](../../packages/toolkit/src/config.ts) fires three identical concurrent SearXNG searches per `web_search`; `outgoing.retries: 3` at [`services/searxng/settings.yml:36`](../../services/searxng/settings.yml) allows 4 attempts per engine; `suspended_times` and `ban_time_on_fail` are all `0` ([`services/searxng/settings.yml:15-24`](../../services/searxng/settings.yml)) so blocked engines are retried on every search forever. This amplification plausibly *worsens* the reputation problem and is being reduced by the two linked stories — but it does not explain the immediate, broad, first-contact rejection by providers that have no prior request from us in that window.
3. **Existing proxy mitigations.** The repository already carries substantial hard-won work on this exact problem, documented in comments at [`services/searxng/settings.yml:30-53`](../../services/searxng/settings.yml) and implemented in [`services/searxng/google_sorry_fix.py`](../../services/searxng/google_sorry_fix.py): US geo-targeting of the residential pool (the EU pool was found broadly `/sorry/`-blocked by Google), rotating rather than sticky sessions, a patch converting Google's 302/sorry into an immediately-retryable CAPTCHA so retries rotate to a fresh exit IP, and a tested decision to keep connection keep-alive on (`pool_maxsize: 20`) after per-request tunnel establishment was measured to be slower and less reliable (3/12 vs 7/10). The mitigations available within our configuration surface appear to have already been applied.
4. **Upstream documentation.** SearXNG's settings documentation (<https://docs.searxng.org/admin/settings/settings_outgoing.html>) exposes proxies, timeouts, retries, and connection pooling. It offers no mechanism that changes how a third-party provider judges our exit IP's reputation.

## Confounds not yet ruled out

Honesty about what this evidence does *not* settle:

- **Request-volume amplification is a live alternative explanation** for at least the rate-limiting subset (`brave` 102, `wikipedia` 3, `google cse` 96). With three identical concurrent client requests times four attempts per engine times the full default engine set, our own traffic could plausibly trigger volume-based throttling on a *clean* IP. The two linked stories reduce that amplification; re-measuring afterwards will separate the two causes cheaply.
- **The 403/access-denied subset (`wikidata`, `mojeek`, `qwant`) is harder to explain by volume**, since those arrive on first contact rather than after sustained traffic, which is what points at reputation. But this has not been isolated experimentally.
- **The proxy vendor is not consistently identified in this repository.** The comment at [`services/searxng/settings.yml:48-50`](../../services/searxng/settings.yml) documents an Evomi credential format, while [`proxy-exit-ip-health-unverifiable.md`](./proxy-exit-ip-health-unverifiable.md) names iProyal. Resolve which is actually deployed before drawing vendor-specific conclusions.

Running the reproduction below resolves all three cheaply. Until it is run, the conclusion in the next section is a judgement about where a fix could *live*, not a proven diagnosis.

## Why no solution could be identified

Scoped to the 403 / access-denied pattern this issue actually tracks (Mojeek, Qwant), and regardless of which confound dominates *within* that subset, the root cause sits outside every surface this repository controls. Note this argument deliberately does **not** extend to the rate-limiting subset (`brave`, `wikipedia`, `google cse`), where our own request volume is a live and fully repo-fixable explanation addressed by the two linked stories:

- **The exit IPs are not ours.** They belong to a third-party rotating residential proxy vendor and are shared with that vendor's other customers. Their reputation with Google, Brave, Mojeek, Qwant, Startpage, and DuckDuckGo is set by aggregate traffic from all those customers, which we cannot observe or influence.
- **The blocking decision is unilateral and opaque.** Each provider decides independently, publishes no appeal path for proxy traffic, and gives no signal distinguishing "this IP is burned" from "this ASN is burned" from "this request fingerprint is suspicious". We cannot target a fix at an unobservable classifier.
- **The obvious remedies are procurement decisions, not code changes.** Switching proxy vendors, buying a cleaner/dedicated pool, moving to paid provider APIs with contractual quotas (Brave Search API, Google Programmable Search, Bing API), or accepting a smaller working engine set are all commercial and product-scope choices requiring a cost decision by the operator. Making that choice unilaterally would also push against the [`../PRODUCT.md`](../PRODUCT.md) boundary — Web Tools is explicitly "not a guarantee that arbitrary third-party websites can be fetched or rendered successfully", and adding paid provider dependencies is Phase 4 "Deliberate Expansion" work gated on a defined operating cost.
- **No repository change makes the blocking go away.** The two linked stories reduce avoidable load and stop the retry storms, which is worth doing on its own merits, but neither will make Mojeek or Qwant start returning 200s through a burned exit IP.

The remaining honest engineering response is not to fix the blocking but to make it *visible and correctly reported* — see "Related work" below.

## Reproduction

Not yet performed. The intended protocol, which would confirm or refute the reputation hypothesis:

1. Pick one fixed query, e.g. `Railway cloud deployment platform`.
2. Run it once from the Railway deployment through the configured proxy. Record the proxy exit IP and the per-engine outcome.
3. Run the identical query once from a clean residential or office network with no proxy. Record the per-engine outcome.
4. Repeat both, this time three concurrent identical requests, matching current `parallelRequests: 3` behavior.
5. Compare. If the clean network succeeds where the proxied path is blocked, and single vs triple makes little difference, the cause is exit-IP/ASN reputation rather than request volume.

Record the exit IP for every test — without it the results cannot be interpreted.

## Related work

- [`../tasks/searxng-engine-set-and-suspension-policy.md`](../tasks/searxng-engine-set-and-suspension-policy.md) — removes unintended engines and stops unbounded retry of permanently blocked ones. Reduces load; does not fix reputation.
- [`../tasks/search-client-fanout-and-timeout-budget.md`](../tasks/search-client-fanout-and-timeout-budget.md) — removes the 3x client fan-out and fixes the timeout budget. Reduces load; does not fix reputation.
- [`../tasks/distinguish-search-failure-from-empty-results.md`](../tasks/distinguish-search-failure-from-empty-results.md) — `web_search` currently returns an empty array when every SearXNG attempt fails ([`packages/toolkit/src/searxng.ts:95-114`](../../packages/toolkit/src/searxng.ts)), making total upstream failure indistinguishable from a legitimate no-result search. **This is the most important related story while this issue stays open**: it does not fix the blocking, but it makes the blocking visible to callers instead of silently degrading to zero results.
- [`proxy-exit-ip-health-unverifiable.md`](./proxy-exit-ip-health-unverifiable.md) and [`rotation-egress-ip-change-unverifiable.md`](./rotation-egress-ip-change-unverifiable.md) — closely related egress-observability limits. Together with this note they describe the same underlying constraint: we do not own the tunnel, so we can neither verify nor influence the exit IP's standing.
