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

### Formatting is a listed repository command but never a gate, so new files ship unformatted

**Area**: flow (unit validation, spec `Validation` sections and the coder/QA checklists)

**Observed**: the root `CLAUDE.md` lists `pnpm format` alongside build/typecheck/test, but every validation gate handed down the pipeline names only `pnpm build`, `pnpm typecheck`, `pnpm test` — `docs/specs/health-liveness-readiness-split.md` Validation, its Tasks entry, and the QA task brief all omit formatting. Consequence on this unit: `packages/api/src/index.ts` and `packages/toolkit/src/crawl4ai.ts` fail `prettier --check` at `HEAD` (pre-existing, confirmed against the `HEAD` blobs, unrelated to this unit's own additions) while every named gate passes, and this unit deliberately left them unformatted rather than reformat lines outside its scope or risk a merge conflict with a sibling story editing the same files. Nothing in the flow ever fails on the drift, so it is invisible until someone runs `pnpm format` and produces an unrelated diff, or until it's checked by hand as it was here.

**Suggested change**: either add `npx prettier --check` (scoped to the files the unit touched) to the validation step the coder and QA run, or drop `pnpm format` from the repository's Validation list so it is not presented as a check that something enforces.

### The code-review skill assumes a GitHub pull request, but the pipeline reviews uncommitted worktrees

**Area**: skill:code-review

**Observed**: the pipeline's review step targets an uncommitted working-tree diff inside `.worktrees/<slug>/` — there is no branch pushed, no pull request, and no `gh` object to address. The `code-review` skill is written end to end around a PR: step 1 checks whether the PR is closed/draft/already reviewed, step 7 re-checks that eligibility, and step 8 requires posting the result as a `gh` comment with permalinks built from a full commit SHA. None of those steps are performable against uncommitted work, and the required output format (GitHub blob permalinks with `#L` ranges) cannot be produced for lines that exist only in the working tree. Every reviewer invoked this way has to silently improvise a substitute for roughly half the skill's steps, which is exactly where relayed findings can drift from the skill's intended structure.

**Suggested change**: give the skill an explicit non-PR target mode — when the target is a working tree or a local commit range, skip the eligibility and `gh`-comment steps, and specify the substitute citation format (absolute file path plus line range) and the substitute delivery (findings returned to the caller). Alternatively, have the pipeline call a review skill written for local diffs and reserve `code-review` for actual pull requests.
