# Third-party anti-bot blocks with no identified solution

Status: investigated, no solution identified on our side.
Evidence window: 2026-07-17 to 2026-07-18 UTC, Crawl4AI service, Railway project `Agentic-Search`, production environment.

This note records crawl failures caused by genuine third-party anti-bot enforcement against our egress IP. Unlike the misclassification and download failures recorded as stories in [`../tasks/`](../tasks/), these responses are correct behaviour by the target site. We can improve how we *report* them, but we have not identified a way to *retrieve* the content within the product boundary.

## The failures

All produced Crawl4AI HTTP 500 responses of the form
`Crawl request failed: Blocked by anti-bot protection: <reason>`.

### Cloudflare JS challenge (9 occurrences)

Reason string: `Cloudflare JS challenge`

Affected targets, as retained (Crawl4AI abbreviates long URLs in `[ERROR]` lines):

```text
https://openai.com/inde...ow-generally-available/
https://openai.com/inde...cing-upgrades-to-codex/
https://www.npmjs.com/package/@powersync/node
https://www.cybertec-po...uid-keys-in-postgresql/
https://www.npmjs.com/package/cbl-reactnative
https://stackoverflow.c...b?tab=votes&pagesize=50
https://stackoverflow.c...moryerror-in-react-nati
https://docs.couchdb.or.../setup/single-node.html
https://stackoverflow.c...ons/tagged/watermelondb
```

Exact log pair:

```text
[2026-07-18T18:59:10.259437046Z] [ERROR]... × https://www.npmjs.com/package/@powersync/node | Error: Blocked by anti-bot protection: Cloudflare JS challenge
2026-07-18 18:59:10,250 - server - ERROR - server error 500 [cid=6781227bb59c]: Crawl request failed: Blocked by anti-bot protection: Cloudflare JS challenge
```

Three of these fired within the same second at `20:54:33` against Stack Overflow, CouchDB docs, and Stack Overflow tags. Simultaneous challenges across three unrelated domains indicate the shared browser's egress IP was being challenged, not any per-site condition.

### Akamai block (3 occurrences)

Reason string: `Akamai block (Reference #)`

```text
https://forums.couchbase.com/search?q=walrus        failed twice: 20:54:01 and 20:55:04
https://www.couchbase.c...ensing-and-support-faq/   failed once:  20:57:29
```

### HTTP 403 with HTML body (2 occurrences)

```text
https://www.crunchbase.com/organization/journeyapps       HTTP 403 with HTML content (5388 bytes)   cid=8b8fab23688c
https://www.crunchbase.com/organization/garden-computing  HTTP 403 with HTML content (4269 bytes)   cid=bc6d9d2a54ed
```

### HTTP 429 rate limiting (2 occurrences)

```text
20:57:30  https://www.npmjs.com/p...tate?activeTab=versions   cid=9c0764c86148
20:57:35  https://www.npmjs.com/package/@fireproof/core        cid=3cdf797738e0
```

## What was investigated

**1. Is the detection a false positive, as with the structural detector?**
No. Verified against Crawl4AI v0.9.1 `crawl4ai/antibot_detector.py`. These reasons come from Tier 1 structural vendor markers, which are matched on specific block-page artifacts rather than on page size:

- `Cloudflare JS challenge` requires the literal IUAM script path `/cdn-cgi/challenge-platform/\S+orchestrate`.
- `Akamai block (Reference #)` requires the full Akamai reference format `Reference #\d+\.[0-9a-f]+\.\d+\.[0-9a-f]+`.

Neither pattern plausibly appears in ordinary content. The HTTP 403 cases carry multi-kilobyte HTML bodies, consistent with real challenge/denial pages. These detections are correct. (Contrast with the `Structural: minimal_text` reason, which *is* a false positive and is addressed by the `classify-crawl-upstream-status` story.)

**2. Do we already mitigate this?**
In principle yes, but the mitigation is **deployed and not proven to have fired**. Production Tools logs across a 14-day window covering this incident contain zero `[rotation]` lines of any kind, so the rotation described below did not actually run during these blocks — see [`fix-rotation-block-signal-detection`](../tasks/fix-rotation-block-signal-detection.md). Read the rest of this section as the intended design rather than as observed behaviour. [`../../packages/toolkit/src/rotation.ts`](../../packages/toolkit/src/rotation.ts) exists precisely for this. Crawl4AI's Chromium holds a persistent HTTP CONNECT tunnel to the upstream proxy, so every request from the container egresses on the same IP regardless of `session_id`. After `ROTATE_AFTER_429` (default 3) consecutive block signals, the toolkit calls Crawl4AI's `/monitor/actions/kill_browser`, forcing a fresh browser, a fresh tunnel, and a new IP. This is already deployed and already fires for every reason string listed above, since `BLOCK_RE` in [`../../packages/toolkit/src/functions.ts`](../../packages/toolkit/src/functions.ts) line 22 matches `anti-bot protection`.

**3. Does stealth configuration help?**
Already applied and already tuned. `web_fetch` sets `enable_stealth: true` with `wait_until: 'load'` and a 15 second `delay_before_return_html`, a recipe recorded in `functions.ts` as verified 5/5 against a Cloudflare-protected site. The same comment records that enabling `magic` / `simulate_user` / `override_navigator` made things *worse* by triggering Crawl4AI's pre-emptive Cloudflare detection and fingerprinting as a bot. There is no further stealth setting to turn on.

**4. Does Crawl4AI's own retry or fallback rescue these?**
Only partially, and not for the underlying cause. `crawl4ai/async_webcrawler.py` supports `max_retries` and a `fallback_fetch_function`, but `_get_proxy_list()` returns a single-element list when `proxy_config` is one proxy, so retries re-use the same blocked IP. `fallback_fetch_function` is a Python callable and cannot be supplied over the MCP/REST boundary we use. Bounded retry is still worth adding for *transient* signals and is tracked in the `retry-transient-crawl-failures` story, but it does not solve Cloudflare or Akamai challenges.

**5. Would a commercial unlocker solve it?**
Technically, most likely yes — this is the gap Crawl4AI's fallback hook is designed for. It is not proposed here because it conflicts with the stated product boundary. [`../PRODUCT.md`](../PRODUCT.md) states Web Tools is not "a guarantee that arbitrary third-party websites can be fetched or rendered successfully", and adding a paid third-party unlocker is a Phase 4 "Deliberate Expansion" decision requiring a defined user, contract, provider boundary, operating cost, and failure model. It is out of scope for a Phase 1 reliability fix.

## Why no solution is proposed

The target sites are deliberately and correctly refusing automated traffic from a proxy IP pool. Every lever available inside the current architecture — stealth configuration, residential proxying, IP rotation on block — is already implemented and deployed. What remains is an economic and product question (buy unblocking capability, accept the failures, or narrow the supported target set), not an engineering defect we can fix.

## What we can still improve

These items are tracked elsewhere and are about reporting, not retrieval:

- Report the vendor and block class to the caller as structured, actionable data rather than a wrapped provider string — see the Product Promise "Actionable" in [`../PRODUCT.md`](../PRODUCT.md).
- Avoid diluting the rotation signal with false positives, so rotation fires on genuine blocks like these rather than on 404s — see [`classify-crawl-upstream-status`](../tasks/classify-crawl-upstream-status.md).
- Fix rotation *accounting*, since production logs show the rotation mechanism never actually fired during this window despite these abundant block signals — see [`fix-rotation-block-signal-detection`](../tasks/fix-rotation-block-signal-detection.md). Until that lands, the mitigation described above is deployed but unproven in production.
- Apply bounded backoff to HTTP 429 specifically, which is the one class here that a short wait can plausibly clear — see [`retry-transient-crawl-failures`](../tasks/retry-transient-crawl-failures.md).

## Revisit if

- Block rates rise materially after `classify-crawl-upstream-status` ships and rotation stops being wasted on false positives, which would show whether rotation is currently under-firing.
- The product enters Phase 4 and an unlocker provider is evaluated against a defined user and operating cost.
- Crawl4AI exposes a fallback fetch mechanism configurable over the HTTP/MCP boundary rather than only as an in-process Python callable.
