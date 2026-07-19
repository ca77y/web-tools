---
type: story
title: Bound the Crawl4AI monitor calls used by browser rotation
---

# Bound the Crawl4AI monitor calls used by browser rotation

- [ ] Bound the Crawl4AI monitor calls used by browser rotation #bug ⏫ 🆔 rotation-monitor-call-timeouts
  - Phase: Phase 1 - Reliable Core
  - **Problem.** The `rotate()` routine in `packages/toolkit/src/rotation.ts:53-95` performs two unbounded HTTP calls against the Crawl4AI admin surface — `GET /monitor/browsers` and `POST /monitor/actions/kill_browser` — using bare `fetch` with no `AbortSignal`, no timeout, and no retry. Relevant code at HEAD:
    - ```ts
      const listUrl = new URL('/monitor/browsers', Config.crawl4ai.url);
      const listRes = await fetch(listUrl, { headers });
      ```
    - and, per killable browser:
    - ```ts
      const killUrl = new URL('/monitor/actions/kill_browser', Config.crawl4ai.url);
      const r = await fetch(killUrl, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sig: b.sig }),
      });
      ```
  - **Failure mode 1 - permanent rotation lockout.** `noteBlocked()` (`packages/toolkit/src/rotation.ts:40-47`) guards rotation with a module-level in-flight latch:
    - ```ts
      export function noteBlocked(): void {
        consecutive429++;
        if (consecutive429 >= ROTATE_THRESHOLD && !rotating) {
          rotating = rotate().finally(() => {
            rotating = null;
          });
        }
      }
      ```
    - If either `fetch` hangs — a plausible outcome given that Crawl4AI is the service already under anti-bot load and returning HTTP 500s when rotation is most needed — the `rotate()` promise never settles, `rotating` is never reset to `null`, and **every future rotation for the remaining lifetime of the process is silently suppressed**. There is no watchdog and no log line at the point of the hang, so this failure is invisible in production.
  - **Failure mode 2 - no retry and a partially completed rotation.** The kill loop iterates every killable browser sequentially. A single failed or hung kill leaves the fleet in a partially rotated state. On a non-`ok` response the code logs and continues, but on success accounting it unconditionally increments `stats.rotations`, sets `last_rotated_at`, and resets `consecutive429 = 0` (lines 86-88) even if every individual kill returned a non-`ok` status. The recorded rotation count therefore overstates successful rotations, and the block counter is cleared on the strength of a rotation that may not have happened.
  - **Failure mode 3 - early-return paths clear nothing.** When `/monitor/browsers` returns non-`ok` (line 61) or reports no killable browser (line 69), `rotate()` returns after logging without resetting `consecutive429`. The next `noteBlocked()` call will therefore re-enter `rotate()` immediately on every subsequent block, producing an unthrottled retry loop against an already unhealthy upstream. There is no backoff between rotation attempts.
  - **Production context.** Over a 14-day Railway log window for the Tools service, no `[rotation]` line of any kind appeared — including the failure lines `[rotation] /monitor/browsers HTTP <status>`, `[rotation] no killable browser found`, and `[rotation] failed: <message>`. That is consistent with rotation never being attempted, and it means none of the above failure modes can currently be ruled out from production evidence. Bounding and instrumenting these calls makes the mechanism diagnosable.
  - Scope:
    - Apply an explicit, configurable timeout (via `AbortSignal.timeout` or equivalent) to both `/monitor/browsers` and `/monitor/actions/kill_browser` requests, with a conservative default in the seconds range.
    - Guarantee the in-flight `rotating` latch is always released, including on timeout, abort, and unexpected throw, so a single hang can never permanently disable rotation.
    - Add a minimum interval or backoff between rotation attempts so repeated failures do not produce an unthrottled retry loop against an unhealthy Crawl4AI.
    - Only count a rotation in `stats.rotations` / `last_rotated_at` and only clear the block counter when at least one `kill_browser` call actually succeeded.
    - Add a bounded retry for the transient case, or explicitly document why no retry is appropriate.
    - Log every outcome distinctly — timeout, HTTP error, no killable browser, partial success, full success — so the mechanism's behaviour is recoverable from logs.
    - Surface rotation failure counts and the last failure reason through `getRotationStats()` (`packages/toolkit/src/rotation.ts:32-38`), which reaches callers via `packages/toolkit/src/stats.ts:108` and the `web_usage_stats` tool.
    - Out of scope: how block signals are classified and counted — owned by the separate stories `classify-crawl-upstream-status` and `rotation-block-signal-detection`. This story changes only the HTTP calls inside `rotate()` and the in-flight latch, so it can proceed in parallel with them without conflict.
    - Out of scope: changing the `kill_browser` rotation strategy itself, or any Crawl4AI service configuration.
  - Acceptance criteria:
    - A hanging `GET /monitor/browsers` aborts at the configured timeout rather than hanging indefinitely.
    - A hanging `POST /monitor/actions/kill_browser` aborts at the configured timeout rather than hanging indefinitely.
    - After a hung or failed rotation, a subsequent block sequence can still trigger a new rotation attempt — the in-flight latch is proven released.
    - A rotation in which every `kill_browser` call fails does not increment `stats.rotations` and does not clear the block counter.
    - A rotation in which at least one `kill_browser` call succeeds does increment `stats.rotations` and sets `last_rotated_at`.
    - Repeated rotation failures are throttled by the configured minimum interval rather than firing on every subsequent block.
    - Timeout, HTTP-error, no-killable-browser, partial-success, and full-success outcomes each emit a distinct stderr line.
    - `web_usage_stats` exposes a rotation failure count and the last failure reason.
    - The timeout value is configurable through the existing configuration surface in `packages/toolkit/src/config.ts` and has a documented default.
    - `pnpm build` and `pnpm typecheck` pass.
  - References:
    - `packages/toolkit/src/rotation.ts` — module header (lines 1-18), `ROTATE_THRESHOLD` (line 22), `getRotationStats()` (lines 32-38), `noteBlocked()` (lines 40-47), `rotate()` (lines 53-95).
    - `packages/toolkit/src/config.ts` — `Config.crawl4ai.url` and `Config.crawl4ai.apiToken`.
    - `packages/toolkit/src/stats.ts:108` — surfaces `rotation: getRotationStats()` through `web_usage_stats`.
    - Related open question: [`../issues/rotation-egress-ip-change-unverifiable.md`](../issues/rotation-egress-ip-change-unverifiable.md).
    - [`../PRODUCT.md`](../PRODUCT.md) — Principle 4 "Safe defaults beat maximum configurability"; Principle 5 "Operational truth is explicit"; Phase 1 exit condition on bounded, testable failure behaviour.
    - [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — Runtime Services (Crawl4AI), Failure Model, Health And Statistics.
