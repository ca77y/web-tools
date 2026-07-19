# Proxy connectivity and exit-IP health cannot be meaningfully health-checked

## Status

No solution identified on our side. Recorded so the question is not re-opened without new information.

## Related stories

- [`../tasks/health-liveness-readiness-split.md`](../tasks/health-liveness-readiness-split.md) - adds a dependency readiness endpoint covering SearXNG and Crawl4AI. It deliberately does **not** report proxy status, for the reasons below. It reduces the symptom (health blind to dependencies) without addressing proxy egress at all.
- [`rotation-egress-ip-change-unverifiable.md`](./rotation-egress-ip-change-unverifiable.md) - closely related: the same tunnel-ownership constraint that makes a proxy health probe meaningless also prevents verifying that a rotation actually changed the exit IP.

## The problem

Web Tools health reporting is being split into liveness and dependency readiness (see [`../tasks/health-liveness-readiness-split.md`](../tasks/health-liveness-readiness-split.md)). One dependency named in the original production incident review was "proxy connectivity or exit-IP health": browser-backed tools egress through an upstream residential proxy (iProyal), and during the incident window that egress path was broadly blocked by search and target providers (403s, CAPTCHAs, rate limits, unusual-traffic responses, timeouts). Health reporting stayed green throughout.

The desired check would be: "is our proxy egress path currently usable?" No implementable version of that check was identified.

## What was investigated

- `packages/toolkit/src/config.ts:28-35` - the proxy is optional configuration (`PROXY_SERVER`, `PROXY_USERNAME`, `PROXY_PASSWORD`), exposed as `Config.proxy`. Web Tools itself holds the credentials but does not open the tunnel.
- `packages/toolkit/src/rotation.ts:1-18` - the authoritative description of how egress actually works. Verbatim from the source comment:

  > IP rotation for Crawl4AI. Crawl4AI's Chromium process holds a persistent HTTP CONNECT tunnel to the upstream proxy, so EVERY request from a given Crawl4AI container egresses on the same iProyal IP — regardless of `session_id`, even with a "rotating" proxy config.

  Rotation is performed reactively, by killing the hot browser via Crawl4AI's admin `kill_browser` action after N consecutive anti-bot signals, which forces a new tunnel and therefore a new exit IP.
- `packages/toolkit/src/stats.ts:60-84` - only Crawl4AI-backed tools accrue proxy bandwidth, and that bandwidth is billed per GB (`PROXY_USD_PER_GB`, default 10).
- `docs/ARCHITECTURE.md` ("Deployment Model", "Health And Statistics") - the proxy is not modelled as one of the four owned services and has no owned health surface.

## Why no check works

1. **A probe from Tools does not test the path that matters.** The egress IP that crawls actually use belongs to the Chromium process inside the Crawl4AI container and its persistent CONNECT tunnel. Any probe issued from the Web Tools process opens a *different* connection and therefore gets a *different* exit IP. A green probe would say nothing about the IP the next crawl uses, and a red probe could be a false alarm.
2. **The result is not stable enough to be a health signal.** Rotation deliberately changes the exit IP over time, and blocking is per-target and per-reputation: the same IP can be fine for one site and 403'd by another in the same second. There is no single boolean "the proxy is healthy" to report.
3. **A probe that is representative is expensive.** The only faithful test is a real browser fetch of a real, protected target through the real tunnel. That costs billed residential bandwidth on every poll, adds seconds of latency, and would itself contribute to the rate-limit accumulation the rotation logic exists to avoid - the check would degrade the thing it measures.
4. **A cheap probe is not meaningfully different from a proxy-configured/not-configured assertion**, which is static configuration and not health.

## Current disposition

- The readiness endpoint will not report a proxy dependency status. This is stated as explicit out-of-scope on the story card rather than left as a silent gap.
- Proxy-path degradation is better surfaced **reactively, from real traffic**, than proactively from a probe: consecutive anti-bot signals are already counted and acted upon in `packages/toolkit/src/rotation.ts`, and the honest place to expose that state is observability (rotation counts, per-outcome error classification, block-rate over recent requests), not a health check.
- Documenting proxy egress as an unmonitored dependency in operator-facing deployment guidance is the realistic mitigation.

## What would change this

- Exposing rotation and block-rate counters as an operator-visible signal, so proxy-path degradation is reported from traffic that was going to happen anyway rather than from a synthetic probe.
- A proxy provider health/status API that reports account and pool state without consuming billed bandwidth.
- A change in egress architecture that gives Web Tools a directly observable, per-request exit path instead of a tunnel owned by another container's browser process.