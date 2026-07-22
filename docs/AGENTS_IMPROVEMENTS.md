# Agent Pipeline Improvements

Concrete proposals for improving the agent workflow used in this repository.

Add an entry only when a specific pipeline, agent, or skill improvement is discovered. Check for an existing equivalent entry first. Product and implementation work does not belong here.

### Issue-note shaping must not assert "no fix identified" while its own Reproduction section is unperformed

**Area**: flow (issue-note shaping, `docs/issues/`)

**Observed**: `docs/issues/searxng-egress-proxy-reputation.md` states as its `Status` line and in "Why no solution could be identified" that the root cause is confirmed to sit outside the repo's control (proxy exit-IP/ASN reputation). Its own "Reproduction" section, in the same file, says the protocol that would confirm or refute that exact hypothesis "Not yet performed." The evidence offered for the hypothesis (near-identical rejection timestamps across seven providers) is also explainable by SearXNG's own concurrent per-engine fan-out — every metasearch call hits all active engines within the same second by design — so the "strongest single piece of evidence" doesn't cleanly discriminate between "reputation" and "our own request volume/pattern," which the note elsewhere concedes it can't rule out. `docs/issues/README.md` frames an issue note as the durable record of an investigation that "concluded" with no actionable fix, which reads as a settled finding, not a hypothesis pending its own stated confirmation step.

**Suggested change**: When shaping an issue note, require the "why no solution could be identified" conclusion to either (a) reflect that the confirming reproduction was actually run, or (b) be phrased as a provisional/leading hypothesis with `Status` and the conclusion section worded accordingly (e.g. "suspected, unconfirmed") until the reproduction closes the gap. Treat an unperformed reproduction step as a blocker on a confirmed-root-cause framing, not a footnote. No agent currently owns `docs/issues/` shaping, so this rule also needs a home.


### The code-review skill's fixed 7-agent fan-out ignores the caller's effort level and assumes a subagent tool the reviewer may not have

**Area**: skill:code-review

**Observed**: the reviewer agent is invoked with an explicit effort level (`low` for a single-unit review, `medium` for the lead's whole-story integration review), but the skill's procedure is a fixed pipeline — one Haiku eligibility agent, one Haiku CLAUDE.md-locator, one Haiku summarizer, five parallel Sonnet reviewers, then one Haiku scorer per issue found. Nothing in it reads or reacts to an effort level, so `low` and `medium` produce the identical, maximal procedure. Worse, this reviewer's tool set contained no subagent-launch tool at all, so the mandated fan-out was not executable and the whole procedure had to be performed inline by one agent. Both the effort parameter and the fan-out then become fiction the reviewer silently improvises around, which is where passes get dropped without anyone noticing.

**Suggested change**: have the skill declare which passes are mandatory at each effort level (for example: `low` = diff-only bug scan plus CLAUDE.md adherence; `medium` = add git history, prior-review context, and code-comment adherence) and state that the passes are the contract while the fan-out is only an optimization — so a reviewer without a subagent tool runs the same passes sequentially and says so, instead of quietly substituting its own shorter procedure. Have it read the effort argument it is already being handed rather than ignoring it.


### A spec amendment that supersedes a design rule must reconcile the Tasks checklist that still states the old rule

**Area**: flow (spec amendment after integration review, `docs/specs/`)

**Observed**: `docs/specs/health-liveness-readiness-split.md` gained a post-integration-review amendment in its Design section that explicitly supersedes an earlier rule, stating that `probeCrawl4AI` must call `resetClient()` on **every** failure branch "including `timeout`". The Tasks checklist further down the same file was not reconciled and still instructs the coder to "reset `client`/`connecting` on rejection only (not on timeout)" — the exact rule the amendment overturned. The two instructions are in the same document and directly contradict each other. A coder working the checklist implements the superseded behavior; a reviewer checking the diff against the checklist reports a false finding. Neither reads as obviously stale, because the amendment announces itself only in the Design section and the Tasks entry carries no marker that it was written pre-amendment.

**Suggested change**: make reconciling every other section of the spec — Tasks entries, Requirements scenarios, and the Validation list — a required step of writing an amendment, not an optional follow-up. At minimum require the amendment to enumerate which existing bullets it invalidates and to edit them in the same pass, so the spec never carries two live instructions for the same decision.
