---
type: story
title: Reconcile the tool_call outcome with the inner operation records
---

# Reconcile the tool_call outcome with the inner operation records

- [ ] Reconcile the tool_call outcome with the inner operation records #improvement 🔼 🆔 reconcile-tool-call-outcome-with-inner-records
  - Problem: one logical operation is recorded twice with contradictory outcomes. `deriveOutcome` in `packages/toolkit/src/functions.ts` keys off `isError` and can therefore only ever emit `ok` or `error`, while the inner provider records also emit `empty`. The two disagree in both directions:
    - an empty crawl returns `{ isError: true }`, so `crawl4ai_call` logs `outcome="empty"` while the enclosing `tool_call` logs `outcome="error"`;
    - an empty search returns a bare `[]` with no `isError`, so `search_complete` logs `outcome="empty"` while the enclosing `tool_call` logs `outcome="ok"`.
  - Why it matters: each record is individually correct, so nothing looks broken. But an operator aggregating on `tool_call.outcome` — the obvious top-level field to alert on — over-counts crawl errors and under-counts search empties. The correlation-ID work exists so that operators can attribute traffic from these records; an alert built on the natural rollup field would be quietly wrong.
  - Scope — pick one and apply it consistently:
    - teach `deriveOutcome` to surface `empty`, so the outer record agrees with the inner one; or
    - state explicitly in the `docs/ARCHITECTURE.md` logging contract that `tool_call.outcome` is a two-valued transport-level result and that empties must be read from the inner records, so nobody builds the wrong alert.
  - Acceptance criteria:
    - An empty crawl and an empty search each produce a consistent, documented pair of records, with a test pinning the chosen outcome vocabulary for both.
    - The logging contract in `docs/ARCHITECTURE.md` states which field an operator should aggregate for empties.
  - Depends on the logging contract shipped by [`request-correlation-logging`](./request-correlation-logging.md).
  - Source: review of PR #4 (`story/request-correlation-logging`), finding 2 — raised as informational, not blocking.
