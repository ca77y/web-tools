# Agent Pipeline Improvements

Concrete proposals for improving the agent workflow used in this repository.

Add an entry only when a specific pipeline, agent, or skill improvement is discovered. Check for an existing equivalent entry first. Product and implementation work does not belong here.

### Issue-note shaping must not assert "no fix identified" while its own Reproduction section is unperformed

**Area**: flow (issue-note shaping, `docs/issues/`)

**Observed**: `docs/issues/searxng-egress-proxy-reputation.md` states as its `Status` line and in "Why no solution could be identified" that the root cause is confirmed to sit outside the repo's control (proxy exit-IP/ASN reputation). Its own "Reproduction" section, in the same file, says the protocol that would confirm or refute that exact hypothesis "Not yet performed." The evidence offered for the hypothesis (near-identical rejection timestamps across seven providers) is also explainable by SearXNG's own concurrent per-engine fan-out — every metasearch call hits all active engines within the same second by design — so the "strongest single piece of evidence" doesn't cleanly discriminate between "reputation" and "our own request volume/pattern," which the note elsewhere concedes it can't rule out. `docs/issues/README.md` frames an issue note as the durable record of an investigation that "concluded" with no actionable fix, which reads as a settled finding, not a hypothesis pending its own stated confirmation step.

**Suggested change**: When shaping an issue note, require the "why no solution could be identified" conclusion to either (a) reflect that the confirming reproduction was actually run, or (b) be phrased as a provisional/leading hypothesis with `Status` and the conclusion section worded accordingly (e.g. "suspected, unconfirmed") until the reproduction closes the gap. Treat an unperformed reproduction step as a blocker on a confirmed-root-cause framing, not a footnote. No agent currently owns `docs/issues/` shaping, so this rule also needs a home.

### A revision fixing a named-example audit finding should re-check the general property, not just the named examples

**Area**: flow (spec revision in response to audit findings)

**Observed**: `docs/specs/request-correlation-logging.md` round 2 flagged "no scenario verifies `web_snapshots`, `web_archive`, `web_usage_stats` are routed through `runOperation()` without altering their return values — these three have zero existing test coverage." Round 3 added a scenario naming exactly those three functions and fixed them. But the underlying property — "every one of the nine public tool functions this unit routes through `runOperation()` is exercised by a scenario that would fail if the wrapping were skipped or the return value altered" — was never restated as the actual requirement. A grep of the five pre-existing test files plus the new spec text shows `web_screenshot` and `web_pdf` are invoked by zero scenarios anywhere in the spec, and `web_fetch`/`web_execute_js` are invoked only for the unrelated `crawl4ai_request_shape` assertion, not for the `runOperation` wrap itself — so the identical coverage gap the round-2 finding described persists for four of the nine tools, just not the three it happened to name.

**Suggested change**: When a spec revision responds to an audit finding, restate the finding as a general property before writing the fix, then check the fix against every instance the property applies to (here: all nine functions in the "route all nine through `runOperation()`" task), not only the specific examples the finding's prose used to illustrate it. The auditor re-checking the revision should do the same generalization rather than verifying only the named examples.

### The AGENTS_IMPROVEMENTS instruction should resolve against the worktree an agent was given, not the repository root

**Area**: flow (the shared process-feedback paragraph carried by `lead`, `auditor`, and the other pipeline agents)

**Observed**: the paragraph says to record a note in `AGENTS_IMPROVEMENTS.md` "at the root of the project's documentation area — discover that folder from project context". It says nothing about *which checkout*. During `request-correlation-logging`, an `auditor` dispatched with explicit absolute paths into `.worktrees/request-correlation-logging/` correctly read everything from the worktree, then wrote its improvement note to `/Users/catty/Workspace/web-tools/docs/AGENTS_IMPROVEMENTS.md` — the repository root, sitting on the base branch. That is precisely the checkout the `lead` is required to keep clean (its only permitted base-branch write is the board card status), so the note landed as an uncommitted stray on `main` and the lead had to detect it, move it onto the story branch, and `git checkout` the root file. Nothing in the agent's instructions signals that the repository root is off-limits, so this recurs on every story where a subagent files a note.

**Suggested change**: extend the shared paragraph with a checkout rule — "when you were given a worktree to work in, resolve the documentation area inside *that* worktree; never write to the repository root checkout" — and have the `lead` state the worktree path as the writable root when it dispatches. Leaving the base-branch checkout clean is a safety rule the subagents currently have no way to know about.
