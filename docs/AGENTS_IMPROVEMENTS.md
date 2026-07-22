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


### A re-audit verifying a prior round's fix must resolve the finding against the file the finding cited

**Area**: agent:auditor

**Observed**: during the `request-correlation-logging` docs pass, round 1 raised a minor finding against the boundary bullet list in `docs/ARCHITECTURE.md:23-34`. The fix was applied there and round 2 verified the new bullet present at `docs/ARCHITECTURE.md:35` — then, in the same report, looked for the same bullet in `packages/CLAUDE.md`, a file round 1 never named and which was explicitly out of bounds for a documentation-only pass, and escalated it to **must-fix** as "claimed fixed but was never applied". A verifiably-applied item was reported as a false claim by the writer. That is the most expensive class of false positive: it impugns the previous round's honesty, and it cost a full extra audit round to adjudicate and discard. Round 3 agreed the discard was correct.

**Suggested change**: when re-auditing a prior round's fixes, resolve each finding against the exact file and line the original finding cited before judging whether it was applied; if the property seems to also apply elsewhere, raise that as a *new* finding at its own severity rather than as a not-applied verdict on the old one. And never grade a fix as missing in a file the pass was not permitted to modify — check the stated out-of-bounds list first, and route such items to the lead as out-of-scope.

### The code-review skill is written for GitHub PRs, but the pipeline invokes it on uncommitted worktree diffs

**Area**: skill:code-review

**Observed**: Every step of `code-review` assumes a GitHub pull request: it opens with a PR eligibility check (closed / draft / already reviewed), fans out to five parallel Sonnet subagents plus per-issue Haiku scorers, and ends by posting a `gh` comment with permalinks built from a full commit SHA. The reviewer agent in this pipeline is instead pointed at an *uncommitted* working-tree diff in a `.worktrees/<slug>/` checkout — there is no PR to check eligibility on, no SHA to build permalinks from, nothing to comment on, and the reviewer thread has no Task/subagent tool, so the prescribed fan-out cannot run. The reviewer has to silently reinterpret most of the skill, which means the confidence-scoring gate (score 0-100, filter below 80) that decides what actually gets reported is applied ad hoc rather than by the procedure the skill specifies.

**Suggested change**: Give `code-review` an explicit non-PR mode: when the target is a working tree or a local commit range, skip the eligibility and `gh`-comment steps, cite findings as absolute `path:line` instead of GitHub permalinks, and state that the fan-out is optional when no subagent tool is available (with the scoring rubric still applied inline). Alternatively, have the pipeline hand the reviewer a real PR. Either way the reporting bar should be prescribed rather than improvised.

### `pnpm format` reformats the whole repo, dragging out-of-boundary files into a bounded unit's diff

**Area**: flow (validation step in specs and per-unit instructions)

**Observed**: The repository's `main` is not Prettier-clean, so the mandated `pnpm format` validation step (`prettier --write` over all packages) rewrote eleven files that no in-flight unit owned — `packages/toolkit/src/{rotation,schemas,stats,tools,wayback}.ts`, `packages/api/src/{handler,mcp}.ts`, and four `packages/cli/src/**` files — several of which the same spec explicitly lists under "Must not touch". Running the prescribed validation therefore *creates* a boundary violation, and the only way to satisfy both is to run it and then hand-revert the collateral, which is easy to miss and silently pollutes the story branch.

**Suggested change**: Make the formatting gate scope-aware. Either have specs prescribe `prettier --check` over the unit's own file list instead of a repo-wide `--write`, or land a one-off "format the repo" chore on `main` so `pnpm format` becomes a no-op for untouched files. Until one of those happens, unit instructions that mandate `pnpm format` should also tell the agent to `git status` afterwards and revert any file outside its Boundary.

### The code-review skill's fixed 7-agent fan-out ignores the caller's effort level and assumes a subagent tool the reviewer may not have

**Area**: skill:code-review

**Observed**: the reviewer agent is invoked with an explicit effort level (`low` for a single-unit review, `medium` for the lead's whole-story integration review), but the skill's procedure is a fixed pipeline — one Haiku eligibility agent, one Haiku CLAUDE.md-locator, one Haiku summarizer, five parallel Sonnet reviewers, then one Haiku scorer per issue found. Nothing in it reads or reacts to an effort level, so `low` and `medium` produce the identical, maximal procedure. Worse, this reviewer's tool set contained no subagent-launch tool at all, so the mandated fan-out was not executable and the whole procedure had to be performed inline by one agent. Both the effort parameter and the fan-out then become fiction the reviewer silently improvises around, which is where passes get dropped without anyone noticing.

**Suggested change**: have the skill declare which passes are mandatory at each effort level (for example: `low` = diff-only bug scan plus CLAUDE.md adherence; `medium` = add git history, prior-review context, and code-comment adherence) and state that the passes are the contract while the fan-out is only an optimization — so a reviewer without a subagent tool runs the same passes sequentially and says so, instead of quietly substituting its own shorter procedure. Have it read the effort argument it is already being handed rather than ignoring it.


### A spec amendment that supersedes a design rule must reconcile the Tasks checklist that still states the old rule

**Area**: flow (spec amendment after integration review, `docs/specs/`)

**Observed**: `docs/specs/health-liveness-readiness-split.md` gained a post-integration-review amendment in its Design section that explicitly supersedes an earlier rule, stating that `probeCrawl4AI` must call `resetClient()` on **every** failure branch "including `timeout`". The Tasks checklist further down the same file was not reconciled and still instructs the coder to "reset `client`/`connecting` on rejection only (not on timeout)" — the exact rule the amendment overturned. The two instructions are in the same document and directly contradict each other. A coder working the checklist implements the superseded behavior; a reviewer checking the diff against the checklist reports a false finding. Neither reads as obviously stale, because the amendment announces itself only in the Design section and the Tasks entry carries no marker that it was written pre-amendment.

**Suggested change**: make reconciling every other section of the spec — Tasks entries, Requirements scenarios, and the Validation list — a required step of writing an amendment, not an optional follow-up. At minimum require the amendment to enumerate which existing bullets it invalidates and to edit them in the same pass, so the spec never carries two live instructions for the same decision.
