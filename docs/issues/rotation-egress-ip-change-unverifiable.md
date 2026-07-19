# Browser rotation cannot be verified to change the egress IP

Status: open, no solution identified on our side.

## The problem

The IP-rotation mechanism in `packages/toolkit/src/rotation.ts` rests on an unverified causal chain. The module header states the theory (lines 1-18): Crawl4AI's Chromium process holds a persistent HTTP CONNECT tunnel to the upstream residential proxy, so every request from a given Crawl4AI container egresses on the same provider IP regardless of `session_id`, even with a "rotating" proxy configuration. Killing the hot browser via `POST /monitor/actions/kill_browser` is expected to tear down that tunnel, so the next `/crawl` call spawns a fresh browser, opens a fresh TCP connection to the proxy, and receives a new egress IP.

We can observe and test our own side of that chain — that N block signals produce exactly one `kill_browser` call. We cannot observe the part that determines whether rotation is worth doing at all: **whether the egress IP actually changed**.

## What was investigated

- **`packages/toolkit/src/rotation.ts` (whole file).** `rotate()` (lines 53-95) reads `GET /monitor/browsers`, filters `killable`, and issues `POST /monitor/actions/kill_browser` per browser. Nothing in the response of either call reports an egress IP. The typed shape the code expects from `/monitor/browsers` is `{ sig, killable, type, hits }` (lines 65-67) — no network or address information.
- **The repository's Crawl4AI service definition.** `services/crawl4ai/` contains only a `Dockerfile`. A repository-wide search for `monitor/browsers`, `kill_browser`, and `killable` across `services/` and `docs/` returns no matches outside `packages/toolkit/src/rotation.ts` itself. These admin endpoints are used but nowhere specified, versioned, or documented in this repository, so their response contract is not ours to rely on and can change under us on a Crawl4AI upgrade.
- **`docs/ARCHITECTURE.md`.** The document contains no mention of rotation or of the proxy at all. The rotation mechanism and the proxy egress path are absent from the system model, so there is no documented contract to check the implementation against.
- **The evidence behind the theory.** The only supporting datum recorded in the code is the parenthetical in the module header: "we saw 64% 429 after a few hundred calls". That is an observation of block *rate over volume on one IP*, which is consistent with the persistent-tunnel theory but does not establish it, and says nothing about whether `kill_browser` changes the IP.
- **Production logs.** A 14-day Railway log search for `rotation` across the Tools service returned no matches, so there is no production instance of a rotation from which before/after egress behaviour could be compared. That gap is being addressed separately by the instrumentation in `rotation-block-signal-detection` and `rotation-monitor-call-timeouts`, but instrumenting our own calls still does not reveal the egress IP.

## Why no solution could be identified

Verifying the chain requires observing the egress IP as seen from outside the proxy, before and after a `kill_browser`. Every route to that observation is blocked or unacceptable from our side:

1. **Crawl4AI exposes no egress introspection.** The monitor endpoints report browser identity and hit counts, not network identity. There is no supported call that answers "what address does this browser egress from".
2. **The proxy provider assigns addresses opaquely.** Residential proxy IP assignment is controlled by the provider and is not exposed to the client on the CONNECT path. We cannot ask for, pin, or read back the assigned address.
3. **The obvious workaround is a product-boundary violation.** We could crawl a third-party IP-echo endpoint before and after each rotation to read the egress address. That makes an external network call whose only purpose is self-diagnosis, on the request path of a service whose product boundary is retrieval and capture on behalf of the caller. It also burns billed residential proxy bandwidth per rotation and introduces a dependency on a third party whose availability we do not control. This is a plausible one-off manual experiment; it is not a mechanism we should ship.
4. **The incident evidence is retrospectively unrecoverable.** The main incident window (2026-07-17 to 2026-07-18 UTC) has passed, several Railway log queries were capped at 1,000 retained records, and SearXNG alone dropped 372 messages when it exceeded the per-replica logging rate. Tools logs no request ID, no search query, and no crawl target URL, so upstream Crawl4AI failures cannot be matched to specific Tools requests after the fact. The question cannot be settled from the data we have.

## Consequence and current disposition

The rotation mechanism should be treated as an **unvalidated mitigation**, not an established fix. The board stories that touch it — `rotation-block-signal-detection` (block/success accounting), `rotation-monitor-call-timeouts` (bounding the monitor calls), and `classify-crawl-upstream-status` (which failures count as blocks at all) — make the mechanism correct, bounded, and observable *at our boundary*, which is worth doing regardless. None of them can establish that killing a browser changes the egress IP.

## What would settle it

- A check of whether the residential-proxy provider exposes a session or dashboard API — separate from the CONNECT data path — that reports the currently assigned exit IP per session. If one exists it would settle the question without burning billed bandwidth on a third-party echo endpoint, which is the objection to option 3 above. This should be checked before treating the question as closed.
- A one-off manual experiment, run outside the request path and outside production traffic: crawl an IP-echo endpoint, call `kill_browser`, crawl it again, and compare. Repeat enough times to distinguish a real effect from proxy-side churn. Record the result in `docs/ARCHITECTURE.md` to describe the proxy egress path either way.
- Upstream documentation or source confirmation of Crawl4AI's browser-to-proxy connection lifecycle, which would establish the tunnel-teardown half of the chain without a network experiment.
- Confirmation from the proxy provider on how egress addresses are assigned across CONNECT sessions.

Until one of these lands, do not describe browser rotation as a proven IP-rotation mechanism in user-facing documentation.
