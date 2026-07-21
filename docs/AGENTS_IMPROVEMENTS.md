# Agent Pipeline Improvements

Concrete proposals for improving the agent workflow used in this repository.

Add an entry only when a specific pipeline, agent, or skill improvement is discovered. Check for an existing equivalent entry first. Product and implementation work does not belong here.

### Issue-note shaping must not assert "no fix identified" while its own Reproduction section is unperformed

**Area**: flow (issue-note shaping, `docs/issues/`)

**Observed**: `docs/issues/searxng-egress-proxy-reputation.md` states as its `Status` line and in "Why no solution could be identified" that the root cause is confirmed to sit outside the repo's control (proxy exit-IP/ASN reputation). Its own "Reproduction" section, in the same file, says the protocol that would confirm or refute that exact hypothesis "Not yet performed." The evidence offered for the hypothesis (near-identical rejection timestamps across seven providers) is also explainable by SearXNG's own concurrent per-engine fan-out — every metasearch call hits all active engines within the same second by design — so the "strongest single piece of evidence" doesn't cleanly discriminate between "reputation" and "our own request volume/pattern," which the note elsewhere concedes it can't rule out. `docs/issues/README.md` frames an issue note as the durable record of an investigation that "concluded" with no actionable fix, which reads as a settled finding, not a hypothesis pending its own stated confirmation step.

**Suggested change**: When shaping an issue note, require the "why no solution could be identified" conclusion to either (a) reflect that the confirming reproduction was actually run, or (b) be phrased as a provisional/leading hypothesis with `Status` and the conclusion section worded accordingly (e.g. "suspected, unconfirmed") until the reproduction closes the gap. Treat an unperformed reproduction step as a blocker on a confirmed-root-cause framing, not a footnote. No agent currently owns `docs/issues/` shaping, so this rule also needs a home.

### Spec writing should name an owner for every card acceptance criterion, not only the one an audit happens to flag

**Area**: flow (single-unit implementation spec authoring, `docs/specs/`)

**Observed**: `docs/specs/health-liveness-readiness-split.md` was revised to add an explicit owning mechanism for the card's documentation acceptance criterion ("Documentation (owned, not dropped)" subsection naming the story-level `writer` pass, plus a Tasks entry marked "Not the coder's task"). The same card carries another acceptance criterion outside the coder's automated scope — "The manual reproduction steps above have been executed and each produced the stated result" (`docs/tasks/health-liveness-readiness-split.md`) — and the spec's Validation section acknowledges it ("recorded as a separate acceptance activity, not as automated tests") but never names who runs it, when, or as which Tasks entry, unlike the docs criterion's fix. A spec revision that closes one such gap when audited tends to leave sibling gaps of the identical shape unexamined.

**Suggested change**: When a spec author (or the audit that flags a missing-owner finding) resolves one out-of-coder-scope acceptance criterion by naming its owning mechanism, sweep the rest of the card's acceptance criteria for the same pattern (present on the card, absent from the Tasks checklist, no stated owner) in the same pass rather than one at a time across audit rounds.
