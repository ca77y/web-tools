# Production Problems Observed on Railway

This document records problems visible in the Railway production logs so they can be reproduced and converted into regression tests later. It is an evidence inventory, not a fix plan.

## Scope and caveats

- Railway project: `Agentic-Search` (`81b52d85-de3d-4208-a348-82aa0ef250e6`)
- Environment: `production` (`9b52fc28-408a-4ca0-9af4-7c1fb937246d`)
- Services inspected: Tools, Crawl4AI, SearXNG, and Redis
- Tools deployment: `377406fe-1e9d-49fe-a403-a84eaac46d23`, commit `423f31b28976cb694881f431a96a46cfcc4b5b30`
- Crawl4AI deployment: `99ea3e00-e6f7-4bf6-aa39-3fce2c2ce7c8`, commit `80fa8a602b371a75e5c38db555b61244a20888e7`
- SearXNG deployment: `15ce2b88-cb4b-49f6-a3c6-72e97fd99db9`, commit `80fa8a602b371a75e5c38db555b61244a20888e7`
- Redis deployment: `04dbb5cd-3886-4327-bfbd-1fa3d8bfd7b0`, image `redis:8.2.1` with digest `sha256:5fa2edb1e408fa8235e6db8fab01d1afaaae96c9403ba67b70feceb8661e8621`
- Main incident window: 2026-07-17 through 2026-07-18 UTC
- All four services had successful deployments and running instances when inspected on 2026-07-19.
- The public Tools and Crawl4AI `/health` endpoints returned HTTP 200 during inspection. Live search and crawl smoke tests also succeeded. The failures below are intermittent, input-specific, or load-specific.
- Some Railway queries were capped at 1,000 retained records. Counts from those queries are explicitly described as samples or lower bounds.
- SearXNG exceeded Railway's per-replica logging rate at `2026-07-18T23:47:12.968054519Z`; Railway reported that 372 messages were dropped. The SearXNG counts therefore understate the real total.
- Crawl4AI abbreviates long URLs in `[ERROR]` lines. Exact addresses are included where another line retained them; otherwise the logged abbreviated address is preserved rather than guessed.
- Tools does not log the search query, crawl target URL, or a request ID. Some application-level failures cannot be matched to a specific input after the fact.
- Code references were checked against repository HEAD `423f31b28976cb694881f431a96a46cfcc4b5b30`. Tools ran that revision during the incident; Crawl4AI and SearXNG ran the earlier revision listed above, so later tests should compare the cited files across both revisions before assuming line numbers are identical.

## Executive summary

1. A single `web_search` starts three simultaneous identical requests to SearXNG. Each SearXNG request fans out to many engines, and failed engine requests may be attempted up to four times with all engine suspension and ban times set to zero. This creates a large request multiplier.
2. The configured proxy/egress path is broadly blocked by search providers. Logs show 403s, CAPTCHAs, rate limits, unusual-traffic responses, and timeouts across Wikidata, Mojeek, Qwant, Brave, Google CSE, Startpage, DuckDuckGo, and Wikipedia.
3. Search failure is hidden from callers. If all three SearXNG requests fail, `web_search` returns an empty array rather than an error or degraded-status result.
4. Crawl4AI returned 36 HTTP 500 responses in the retained incident window, covering Cloudflare, Akamai, 403, 429, 503, suspected structural anti-bot false positives, downloads/non-HTML resources, and navigation timeout.
5. Crawl4AI also returned 72 HTTP 400 responses, including a burst of 51 between `18:56:01` and `19:05:06` on 2026-07-18. The request URL, validation details, and payload were not logged, so the cause is currently unrecoverable.
6. Two Tools-to-Crawl4AI MCP calls timed out. The shared Crawl4AI client has no explicit call timeout, no retry of the failed operation, and limited correlation logging.
7. Current health checks are shallow. Tools reports `{"status":"ok"}` without checking SearXNG, Crawl4AI, Redis, proxy connectivity, or browser readiness, so Railway can remain green during a near-total upstream outage.
8. Logging volume itself failed under load: 372 SearXNG messages were dropped, stack traces were heavily duplicated, and request correlation was insufficient to reconstruct several failures.

## 1. Search request amplification

### Problem

Every application search sends three identical SearXNG HTTP requests concurrently. These are labeled `attempt 1`, `attempt 2`, and `attempt 3`, but they are not sequential retries.

Code evidence:

- `packages/toolkit/src/config.ts:36` hard-codes `parallelRequests: 3`.
- `packages/toolkit/src/searxng.ts:73-75` creates all three promises before waiting for any result.
- `packages/toolkit/src/searxng.ts:82-93` returns after the first usable result, but the other requests are not cancelled.
- `services/searxng/settings.yml:36` configures `retries: 3`, meaning an engine request can have the original attempt plus three retries.
- `services/searxng/settings.yml:15-24` sets access-denied, CAPTCHA, rate-limit, Cloudflare, and reCAPTCHA suspension times to zero and disables failure bans.

The logs confirm parallel execution:

```text
[2026-07-18T20:59:41.210059033Z] SearXNG attempt 2 failed: The operation was aborted due to timeout
[2026-07-18T20:59:41.210073237Z] SearXNG attempt 3 failed: The operation was aborted due to timeout
[2026-07-18T20:59:41.210077456Z] SearXNG attempt 1 failed: The operation was aborted due to timeout
```

Attempt labels frequently complete out of order and within microseconds of each other. In the SearXNG warning sample, 60 distinct full upstream query URLs appeared exactly three times. The `watermelondb` URLs appeared six times each, representing two triplicated searches.

### Observed impact

- Three identical requests hit every enabled/default SearXNG engine within milliseconds.
- Failed engines are immediately eligible again because `suspended_time=0`.
- Upstream rate limits and CAPTCHA systems see bursty duplicate traffic.
- SearXNG emits duplicate stack traces for each copy.
- Work continues on losing requests after Tools has already selected a successful response.
- A single user operation can become three SearXNG searches multiplied by each engine's internal retries.

### Reproduction target

1. Stub SearXNG and invoke one `web_search`.
2. Assert that the current implementation receives three identical `/search` requests concurrently.
3. Make one response succeed quickly and hold the other two open; verify that the other requests are not aborted.
4. At integration level, issue one query with all observed engines enabled and count outbound engine requests.
5. Repeat with access-denied/CAPTCHA responses and verify that zero suspension allows immediate repeated attempts.

## 2. SearXNG provider blocking and timeouts

### Aggregate retained evidence

The 1,000-record SearXNG warning sample covered `2026-07-18 20:57:57.580` through `23:46:58.944` UTC:

| Failure class | Retained engine warnings | Providers |
|---|---:|---|
| Access denied / HTTP 403 | 288 | Wikidata 101, Mojeek 94, Qwant 93 |
| Rate limited / unusual traffic | 201 | Brave 102, Google CSE 96, Wikipedia 3 |
| CAPTCHA | 99 | Startpage 93, DuckDuckGo 6 |
| Timeout | 117 | DuckDuckGo 117 |

All observed SearXNG exceptions reported `suspended_time=0`.

The Tools-side query for search failures was also capped at 1,000 records:

- 997 records: `The operation was aborted due to timeout`
- 3 records: `fetch failed`
- Range: `2026-07-18T19:01:39.622542213Z` through `21:14:36.235090544Z`
- Peak retained minute: `20:52`, with 114 failure records
- Largest retained same-millisecond burst: 14 records at `19:03:25.914`

Representative Tools log:

```text
[2026-07-18T19:02:31.517842227Z] SearXNG attempt 1 failed: fetch failed
[2026-07-18T19:02:31.517850313Z] SearXNG attempt 2 failed: fetch failed
[2026-07-18T19:02:31.517859378Z] SearXNG attempt 3 failed: fetch failed
```

### 2.1 Wikidata returns HTTP 403

Address:

```text
POST https://query.wikidata.org/sparql
```

Example:

```text
2026-07-18 23:46:35,495 WARNING:searx.network.wikidata: HTTP Request failed: POST https://query.wikidata.org/sparql
2026-07-18 23:46:35,496 ERROR:searx.engines.wikidata: HTTP error 403 (suspended_time=0)
```

Retained warning count: 101 engine failures and 100 network failure lines. The slight mismatch is because the sample begins or ends inside a burst.

### 2.2 Mojeek returns HTTP 403

Addresses retained in logs include:

```text
https://www.mojeek.com/search?q=livestore.dev+local-first&safe=0
https://www.mojeek.com/search?q=Railway+cloud+deployment+platform&safe=0
https://www.mojeek.com/search?q=Claude+Code+subagent+frontmatter+effort+field+%22Available+levels+depend+on+the+model%22&safe=0
```

Example:

```text
2026-07-18 23:46:35,567 WARNING:searx.network.mojeek: HTTP Request failed: GET https://www.mojeek.com/search?q=Railway+cloud+deployment+platform&safe=0
2026-07-18 23:46:35,570 ERROR:searx.engines.mojeek: HTTP error 403 (suspended_time=0)
```

Retained warning count: 94.

### 2.3 Qwant denies access

Example:

```text
2026-07-18 23:46:35,564 ERROR:searx.engines.qwant: Access denied (suspended_time=0)
```

Retained warning count: 93. The exact Qwant request URL was not retained.

### 2.4 Brave rate-limits requests

Addresses retained in logs include:

```text
https://search.brave.com/search?q=livestore.dev+local-first&source=web
https://search.brave.com/search?q=Railway+cloud+deployment+platform&source=web
https://search.brave.com/search?q=Claude+Code+subagent+frontmatter+effort+field+%22Available+levels+depend+on+the+model%22&source=web
```

Example:

```text
2026-07-18 23:46:35,673 WARNING:searx.network.brave: HTTP Request failed: GET https://search.brave.com/search?q=Railway+cloud+deployment+platform&source=web
2026-07-18 23:46:35,674 ERROR:searx.engines.brave: Too many request (suspended_time=0)
```

Retained warning count: 102.

### 2.5 Google CSE reports unusual traffic from the network

Example:

```text
2026-07-18 23:46:35,552 ERROR:searx.engines.google cse: google cse: Our systems have detected unusual traffic from your network. (suspended_time=0)
```

Retained warning count: 96. The exact Google CSE request URL was not retained.

This message is the strongest direct evidence that proxy exit IP or egress reputation is a major factor.

### 2.6 Startpage redirects to CAPTCHA

Address:

```text
https://www.startpage.com/sp/captcha
```

Example:

```text
2026-07-18 23:46:35,915 ERROR:searx.engines.startpage: get_sc_code: got redirected to https://www.startpage.com/sp/captcha (suspended_time=0)
```

Retained warning count: 93. The originating Startpage search URL was not retained.

### 2.7 DuckDuckGo times out and later returns CAPTCHA

Timeout example:

```text
2026-07-18 21:14:28,492 ERROR:searx.engines.duckduckgo: engine timeout
2026-07-18 21:14:28,693 ERROR:searx.engines.duckduckgo: HTTP requests timeout (search duration : 15.20066828187555 s, timeout: 15.0 s) : TimeoutException
```

CAPTCHA example after a roughly 2.5-hour quiet period:

```text
2026-07-18 23:46:35,576 ERROR:searx.engines.duckduckgo: CAPTCHA (us-en) (suspended_time=0)
```

Retained warning counts: 117 timeout warnings and 6 CAPTCHA warnings. The exact DuckDuckGo request URL was not retained.

### 2.8 Wikipedia rate-limits requests

Example:

```text
2026-07-18 20:57:59,509 WARNING:searx.engines.wikipedia: ... SearxEngineTooManyRequestsException ... Too many request (suspended_time=0)
```

Retained warning count: 3. The exact Wikipedia request URL was not retained.

### 2.9 Unexpected engines are active

`services/searxng/settings.yml:55-93` explicitly lists Google, Brave, DuckDuckGo, Bing, Qwant, Mojeek, and Wikipedia. Production logs also show Wikidata, Google CSE, and Startpage. `use_default_settings: true` may be merging default engines with the local list rather than restricting production to the intended set.

This matters because the three unexpected engines generated hundreds of retained failures.

### 2.10 Egress/proxy reputation hypothesis

The evidence strongly supports a burned or low-reputation proxy/egress path rather than query-specific failures:

- Independent providers reject the same searches at nearly the same time.
- Google explicitly reports unusual traffic from the network.
- Startpage and DuckDuckGo issue CAPTCHAs.
- Wikidata and Mojeek return 403.
- Brave and Wikipedia rate-limit.
- Qwant denies access.
- Failures recur across unrelated query subjects.
- Blocking remains after a multi-hour idle gap.
- Triplicated requests amplify traffic, but the broad immediate rejection suggests pre-existing IP/ASN reputation as well.

Reproduction should compare the same exact query from Railway and from a clean network, first once and then three times concurrently. Record the proxy exit IP for each test.

## 3. SearXNG late-completion race

Three internal errors followed three DuckDuckGo 15-second timeouts:

```text
2026-07-18 21:14:28,692 ERROR:searx: call to ResultContainer.add_unresponsive_engine after ResultContainer.close
2026-07-18 21:14:28,692 ERROR:searx: call to ResultContainer.add_unresponsive_engine after ResultContainer.close
2026-07-18 21:14:28,694 ERROR:searx: call to ResultContainer.add_unresponsive_engine after ResultContainer.close
```

This indicates that timeout callbacks can attempt to mutate a result container after the search has already closed it. The exact threefold duplication matches the application-level three-request fan-out.

Reproduction target:

1. Run three concurrent identical searches.
2. Make one engine complete or close the result at 15 seconds while DuckDuckGo times out at approximately 15.2 seconds.
3. Assert that late callbacks do not mutate a closed result container or emit internal errors.

## 4. Search failures are converted to successful empty results

`packages/toolkit/src/searxng.ts:39-61` converts HTTP errors, empty results, JSON errors, fetch failures, and timeout aborts to `null`. `packages/toolkit/src/searxng.ts:95-114` then returns `{ data: [] }` when every parallel request fails.

Operational consequence:

- A total SearXNG outage looks like a valid search with zero matches.
- Callers cannot distinguish “no results” from “all providers failed.”
- HTTP monitoring can remain green because the tool request itself completes successfully.

Reproduction target:

1. Make all three SearXNG calls time out.
2. Verify the current result is an empty array without an error indicator.
3. Make SearXNG return a genuine empty result and compare it with the outage response; they are currently indistinguishable.

## 5. Crawl4AI failures

The retained Crawl4AI runtime logs contain 36 HTTP 500 responses:

| Failure class | Count | Notes |
|---|---:|---|
| Structural anti-bot classification | 14 | Many may be missing/short resources rather than anti-bot pages; upstream status was not retained |
| Cloudflare JS challenge | 9 | OpenAI, npm, Cybertec, Stack Overflow, CouchDB docs |
| Playwright navigation starts a download | 4 | Three PDF attempts and one `build.gradle` resource |
| Akamai block | 3 | Couchbase sites |
| HTTP 403 with HTML | 2 | Crunchbase |
| HTTP 429 | 2 | npm |
| HTTP 503 with HTML | 1 | Wayback CDX request |
| Navigation timeout | 1 | AWS Amplify docs; later succeeded |

### 5.1 Structural detector may misclassify short/missing pages as anti-bot

Repeated exact error:

```text
Blocked by anti-bot protection: Structural: minimal_text on small page (165 bytes, 14 chars visible)
```

The identical `165 bytes, 14 chars visible` response across unrelated raw GitHub paths strongly suggests a short not-found response such as `404: Not Found` is being reported as anti-bot. This is an inference, but it is supported by successful neighboring raw GitHub requests and by a successful corrected filename in one case.

Exact retained targets:

```text
https://raw.githubusercontent.com/instantdb/instant/main/LICENSE
https://raw.githubusercontent.com/tursodatabase/turso/main/sync/engine/README.md
https://raw.githubusercontent.com/sqliteai/sqlite-sync/main/LICENSE
https://raw.githubusercontent.com/tursodatabase/turso/main/packages/sync-react-native/README.md
```

Useful control:

```text
https://raw.githubusercontent.com/sqliteai/sqlite-sync/main/LICENSE.md
```

`LICENSE` failed with 165 bytes/14 visible characters at `2026-07-18 21:08:24,524`, while `LICENSE.md` succeeded shortly afterward in 15.27 seconds.

Other affected addresses as retained, with Crawl4AI's own abbreviation:

```text
https://raw.githubuserc...litellm/types/router.py
https://raw.githubuserc...r_strategy/fallbacks.py
https://raw.githubuserc...ex-backend/main/LICENSE
https://raw.githubuserc...res-ssl/main/Dockerfile
https://raw.githubuserc...e/postgres-persister.js
https://raw.githubuserc...postgres-persistance.js
https://raw.githubuserc...ain/docs/docs/libsql.md
```

Two non-raw structural failures:

```text
https://graft.rs/docs/
  Structural: minimal_text, no_content_elements (39 bytes, 0 chars visible)

https://tanstack.com/bl...base-for-tanstack-query
  Structural: minimal_text, no_content_elements, script_heavy_shell
  (23242 bytes, 0 chars visible)
```

Representative correlation IDs:

- `326acd651b93`: Turso `sync/engine/README.md`
- `5793b591f4e7`: sqlite-sync `LICENSE`
- `4e8001c265a4`: Turso sync React Native README
- `cec3e6ff11fb`: `https://graft.rs/docs/`
- `44d55df0ebfd`: TanStack script-heavy shell

Reproduction target:

1. Crawl a raw GitHub URL that returns a short 404 body.
2. Assert that it is classified as HTTP not-found, not anti-bot.
3. Crawl the `LICENSE` and `LICENSE.md` pair above and preserve the upstream status/body in test fixtures.
4. Test a legitimate short page and a script-only shell independently from actual challenge-page fixtures.

### 5.2 Cloudflare challenge failures

Retained affected addresses:

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

Exact example:

```text
[2026-07-18T18:59:10.259437046Z] [ERROR]... × https://www.npmjs.com/package/@powersync/node | Error: Blocked by anti-bot protection: Cloudflare JS challenge
2026-07-18 18:59:10,250 - server - ERROR - server error 500 [cid=6781227bb59c]: Crawl request failed: Blocked by anti-bot protection: Cloudflare JS challenge
```

Three Cloudflare failures occurred almost simultaneously at `20:54:33` against Stack Overflow, CouchDB docs, and Stack Overflow tags, consistent with a shared browser/proxy IP being challenged across sites.

### 5.3 Akamai block failures

Targets:

```text
https://forums.couchbase.com/search?q=walrus
https://www.couchbase.c...ensing-and-support-faq/
```

`forums.couchbase.com/search?q=walrus` failed twice, at `20:54:01` and `20:55:04` UTC. The Couchbase licensing FAQ failed at `20:57:29`.

Representative error:

```text
Blocked by anti-bot protection: Akamai block (Reference #)
```

### 5.4 HTTP 403 pages from Crunchbase

Targets:

```text
https://www.crunchbase.com/organization/journeyapps
https://www.crunchbase.com/organization/garden-computing
```

Errors:

```text
HTTP 403 with HTML content (5388 bytes)
HTTP 403 with HTML content (4269 bytes)
```

Correlation IDs: `8b8fab23688c` and `bc6d9d2a54ed`.

### 5.5 HTTP 429 from npm

Targets:

```text
https://www.npmjs.com/p...tate?activeTab=versions
https://www.npmjs.com/package/@fireproof/core
```

Both occurred within five seconds at `20:57:30` and `20:57:35`. Correlation IDs: `9c0764c86148` and `3cdf797738e0`.

### 5.6 Wayback request returns HTTP 503

Retained abbreviated target:

```text
http://web.archive.org/...*&output=json&limit=200
```

Example:

```text
2026-07-18 20:51:49,254 - server - ERROR - server error 500 [cid=4ee94c082088]: Crawl request failed: Blocked by anti-bot protection: HTTP 503 with HTML content (120 bytes)
```

The target resembles a Wayback CDX API query. The full URL was not retained.

### 5.7 PDF and other download responses fail browser navigation

Exact targets:

```text
https://cse.buffalo.edu/tech-reports/2014-04.pdf
https://martin.kleppmann.com/papers/local-first.pdf
https://unpkg.com/@nozbe/watermelondb@0.28.1-0/native/android-jsi/build.gradle
```

The Buffalo PDF failed twice, at `18:59:22` and `19:03:41`. The local-first PDF and `build.gradle` each failed once.

Exact root message:

```text
Unexpected error in _crawl_web at line 778 in _crawl_web
Error: Failed on navigating ACS-GOTO:
Page.goto: Download is starting
Call log:
  - navigating to "<URL>", waiting until "load"
```

Representative correlation IDs:

- `97df4ea73463` and `ac512b79f319`: Buffalo PDF
- `49e8514dc9d6`: local-first PDF
- `f5df197b01cf`: unpkg `build.gradle`

These are non-HTML resources that Chromium treats as downloads. They should not be sent through a page-navigation-only path without a direct HTTP/download fallback.

### 5.8 Navigation timeout can be transient

Target:

```text
https://docs.amplify.aws/reference/maintenance-policy/?platform=react-native
```

Failure:

```text
2026-07-18 20:57:35,500 - server - ERROR - server error 500 [cid=590376c8547a]: ... Page.goto: Timeout 60000ms exceeded ... waiting until "load"
```

The same URL succeeded later at `20:59:41` in 16.22 seconds. This is a useful deterministic test shape: fail the first navigation by exceeding the timeout, then permit a second attempt to complete. Current `web_crawl` does not retry; the later success came from a separate call.

### 5.9 Browser concurrency and memory

During the main Crawl4AI burst:

- The hot browser reached `active=10` at `21:01:01` and again at `21:01:04`.
- The unpkg download failure occurred immediately after the second `active=10` observation.
- Successful requests continued immediately after failures, so the shared browser did not appear to crash.
- Per-request Python memory logs during the analyzed segment peaked around 404.8 MB.
- Railway container metrics over 24 hours showed Crawl4AI memory averaging 0.805 GB and peaking at 3.671 GB, with CPU peaking at 2.1404. Browser subprocesses likely explain why platform memory is much higher than per-request process logs.
- No OOM, process kill, allocation failure, or container restart was retained, so memory pressure is a risk signal rather than a proven cause of the observed 500s.

Load-test target:

1. Increase concurrent crawls from 1 through 10.
2. Track browser count, total container RSS, Python RSS, latency, and failure rate.
3. Include a mix of normal HTML, challenge pages, downloads, and slow pages.
4. Verify a failed call does not damage subsequent calls sharing the browser/client.

## 6. Crawl4AI HTTP 400 burst has no diagnostic context

The retained logs contain 72 lines of this form:

```text
HTTP Request: POST http://127.0.0.1:11235/crawl "HTTP/1.1 400 Bad Request"
```

Important timing:

- One occurrence: `2026-07-12 11:48:40,553`
- 51 occurrences between `2026-07-18 18:56:01,062` and `19:05:06,280`
- 19 later occurrences between `20:48:37,369` and `21:13:37,025`

The densest part of the burst included multiple 400s per second, for example:

```text
2026-07-18 18:58:04,384 ... 400 Bad Request
2026-07-18 18:58:04,416 ... 400 Bad Request
2026-07-18 18:58:04,921 ... 400 Bad Request
2026-07-18 18:58:04,927 ... 400 Bad Request
```

There is no validation error, target URL, request schema, correlation ID, or response body. The requests appear to have been rejected before browser allocation in at least one later sample, but the exact cause cannot be recovered.

Reproduction/observability target:

1. Send malformed `urls`, `browser_config`, and `crawler_config` shapes to `/crawl`.
2. Exercise empty URL lists, invalid URLs, unknown config keys, and wrapped-vs-unwrapped config objects.
3. Log a safe request shape summary, target host, validation error, and correlation ID for every 400.
4. Match Tools call timestamps to Crawl4AI correlation IDs.

## 7. Tools-to-Crawl4AI MCP timeouts

Tools logged two call-level failures:

```text
[2026-07-18T20:55:14.272879053Z] Crawl4AI crawl threw: MCP error -32001: Request timed out
[2026-07-18T20:57:35.945134082Z] Crawl4AI crawl threw: MCP error -32001: Request timed out
```

Related implementation details:

- `packages/toolkit/src/crawl4ai.ts:5-43` shares one process-global SSE MCP client.
- `packages/toolkit/src/crawl4ai.ts:46-54` clears cached client state after a tool-call exception but does not retry the failed operation.
- No explicit connect/call timeout or caller abort signal is configured in this client.
- If `c.connect()` rejects directly before transport callbacks run, `connecting` can retain the rejected promise because it is cleared only after successful connect or in transport callbacks.
- `packages/toolkit/src/functions.ts:91-97` converts the thrown timeout to a tool error, but logs no target URL or request ID.

The second timeout is close to the AWS Amplify 60-second navigation failure at `20:57:35`, but the logs do not contain enough correlation data to prove they are the same request.

Reproduction target:

1. Make one shared-client call exceed the MCP timeout.
2. Verify the failing operation is reported with target URL and request ID.
3. Verify the next operation reconnects and succeeds.
4. Force `connect()` itself to reject and verify future calls do not reuse a permanently rejected `connecting` promise.
5. Run concurrent calls while one times out and determine whether clearing the shared client disrupts the others.

## 8. Browser rotation may not observe the server-side failures

The logs contain no `[rotation]` success or failure messages even though Crawl4AI recorded many anti-bot responses.

Relevant behavior:

- `packages/toolkit/src/functions.ts:31-40` only calls `noteBlocked()` when the text returned to Tools matches `BLOCK_RE`.
- `packages/toolkit/src/functions.ts:61-70` wraps upstream `isError` content.
- `packages/toolkit/src/rotation.ts:22` defaults to rotation after three consecutive blocks.
- `packages/toolkit/src/rotation.ts:53-94` logs every attempted rotation outcome.

Possible explanations that need tests:

- The relevant failing calls did not pass back through Tools.
- Successful calls between failures reset the process-global consecutive counter.
- The first textual content item did not contain a matching pattern.
- Crawl4AI returned or threw errors in a form that bypassed `trace()`.
- The rotation log query missed events, although a 14-day search for `rotation` returned none.

There is also a classification issue: `BLOCK_RE` treats every `Unexpected error in _crawl_web` as rotation-worthy. That includes deterministic download handling failures for PDFs and `build.gradle`, where changing proxy IP cannot help.

Reproduction target:

1. Feed three consecutive Cloudflare/429 fixtures and assert exactly one rotation.
2. Interleave success and block fixtures to document reset semantics.
3. Feed a PDF `Download is starting` error and assert it does not trigger IP rotation.
4. Test non-first content items and thrown errors.
5. Make browser-list and browser-kill requests fail or hang; both currently lack explicit timeouts/retries.

## 9. Health checks report green while dependencies fail

Tools `/health` is implemented at `packages/api/src/index.ts:113-115` as:

```json
{"status":"ok"}
```

It does not check:

- SearXNG reachability or whether any engine can return a result
- Crawl4AI MCP connectivity
- Crawl4AI browser readiness
- Redis connectivity
- Proxy connectivity or exit-IP health

Railway's deployment health check therefore succeeded even though the later logs show sustained periods where all three application SearXNG calls timed out and multiple Crawl4AI calls failed.

Crawl4AI's `/health` also returned HTTP 200 during inspection, despite input-specific 400/500 failures and MCP timeouts.

Reproduction target:

1. Keep the API process alive while making SearXNG unreachable; `/health` currently remains 200.
2. Break Crawl4AI MCP connection or browser startup; Tools `/health` currently remains 200.
3. Return healthy/degraded/unhealthy dependency details separately from process liveness.

## 10. Logging and observability failures

### 10.1 Railway dropped 372 SearXNG messages

At `2026-07-18T23:47:12.968054519Z`, Railway reported the replica exceeded 500 logs per second and dropped 372 messages. Repeated full tracebacks from triplicated searches make the logging system fail exactly when the service is under the most stress.

Future tests should verify rate-limited/aggregated engine logging and ensure one upstream failure does not emit multiple full stack traces per request copy.

### 10.2 Missing request correlation

Tools search logs contain only an attempt number and error:

```text
SearXNG attempt 1 failed: The operation was aborted due to timeout
```

They omit query, request ID, duration, SearXNG URL/status, and whether another parallel request ultimately succeeded.

Tools Crawl4AI logs omit the target URL and request ID:

```text
Crawl4AI crawl threw: MCP error -32001: Request timed out
```

Crawl4AI 400 logs omit payload validation details and target URL. This prevents exact incident reconstruction.

### 10.3 `Request closed` is noisy and not actionable

Tools emits many identical lines:

```text
Request closed
```

`packages/api/src/index.ts:57-63` registers the close listener only after `transport.handleRequest()` resolves. The line has no request ID, method, duration, completion state, or cancellation state. Downstream close is not propagated as an abort signal to SearXNG or Crawl4AI work.

This should be tested with a client disconnect during a long search/crawl. Verify whether upstream work continues and whether the close can occur before the listener is attached.

### 10.4 Repeated GET requests to `/mcp` return 405

Railway HTTP logs retained 52 responses of this form between 2026-07-12 and 2026-07-18:

```text
GET /mcp 405 1ms
```

Examples:

```text
[2026-07-12T07:04:09.634700255Z] GET /mcp 405 9ms
[2026-07-18T23:45:24.211636569Z] GET /mcp 405 3ms
```

This may be harmless probing or an MCP client attempting an unsupported transport method, but it inflates HTTP error-rate metrics and should be identified by user agent/request source before deciding whether it is expected.

## 11. Redis and build status

No Redis runtime warnings/errors were returned for the inspected deployment. Redis remained running, its volume was `READY`, and background saves completed successfully:

```text
1 changes in 3600 seconds. Saving...
BGSAVE done, 1 keys saved, 0 keys skipped, 234 bytes written.
Background saving terminated with success
```

The latest Tools and Crawl4AI builds completed successfully. Crawl4AI's build confirmed the matching Playwright Chromium headless-shell binary exists at:

```text
/home/appuser/.cache/ms-playwright/chromium_headless_shell-1228/chrome-headless-shell-linux64/chrome-headless-shell
```

No current browser-executable-missing startup failure was observed.

## Suggested test fixture matrix

| Area | Fixture/scenario | Expected distinction to test |
|---|---|---|
| Search | One fast success plus two slow requests | Losing requests are cancelled |
| Search | All requests timeout | Outage is not returned as genuine empty search |
| Search | 403, 429, CAPTCHA, timeout | Correct classification and bounded retry/backoff |
| Search | Three concurrent identical queries | Deduplication and upstream request count |
| Search | Late engine timeout after result close | No closed-container mutation |
| Search | Railway proxy vs clean egress | Isolate IP/ASN reputation |
| Crawl | Raw GitHub 404/short body | HTTP not-found, not anti-bot |
| Crawl | Valid short page | Not a false anti-bot positive |
| Crawl | Script-only shell | Distinguish client-rendering wait from block page |
| Crawl | Cloudflare challenge | Block classification and session/proxy behavior |
| Crawl | Akamai reference page | Block classification |
| Crawl | HTTP 403/429/503 | Preserve upstream status and retry metadata |
| Crawl | PDF and attachment response | Direct fetch/download fallback |
| Crawl | First navigation timeout, second succeeds | Retry policy and idempotency |
| Crawl | Malformed crawl payload | Actionable 400 response and logs |
| MCP | Tool call timeout | Reconnect and subsequent-call health |
| MCP | Connect failure | Rejected connection promise is cleared |
| MCP | Concurrent calls, one timeout | Shared client remains valid for unaffected calls |
| Rotation | Three real block responses | Exactly one browser/IP rotation |
| Rotation | Download error | No unnecessary IP rotation |
| Health | Dependency outage with live API process | Readiness reports degraded/unhealthy |
| Logging | High-concurrency provider failure | No dropped logs; request IDs correlate layers |
