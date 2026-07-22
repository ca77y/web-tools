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

### A spec amendment asserts third-party dependency behaviour as fact, and the claim is never re-verified when the fix lands

**Area**: flow (single-unit implementation spec authoring, `docs/specs/`)

**Observed**: the post-integration-review amendment in `docs/specs/health-liveness-readiness-split.md` states as fact that "Closing aborts the EventSource, which both stops the retry loop (hazard 1) and settles a wedged in-flight connect (hazard 2)". The first half is true; the second is not. In `eventsource@3.0.7`, `_onFetchError` skips both the reconnect *and* the `error` event when `err.name === "AbortError"`, and `close()` sets `readyState` to `CLOSED` so a later `scheduleReconnect` returns early — so `SSEClientTransport`'s connect promise, which settles only on that error event or the `endpoint` event, never settles when a hung connect is closed. The claim propagated unchallenged into the fix's commit message ("settles a wedged in-flight connect"). It went unnoticed because the scenario the spec wrote for it asserts the observable outcome (a later probe recovers to `ok`), which holds for a different reason — the shared state was nulled, not because the connect settled. A spec claim about a vendored dependency is load-bearing in exactly the same way a test assertion is, but nothing in the flow requires evidence for it or re-checks it once code exists.

**Suggested change**: when a spec (or a review finding that becomes one) asserts how a third-party dependency behaves, require a `package@version` plus file/line citation for each distinct mechanism claimed, and require the round that verifies the fix to check the cited mechanism itself rather than only the scenario's observable outcome. Where a claim cannot be cited, phrase it as an assumption so the verifying round knows to test it.

### A production hazard discovered while writing tests gets buried in a test-file comment instead of raised as a finding

**Area**: flow (coder -> lead handoff on a single unit)

**Observed**: on `health-liveness-readiness-split`, the coder discovered while building the fake upstreams that a *refused or hung* Crawl4AI connect makes the `eventsource` package behind `SSEClientTransport` retry every ~3s forever with no way to stop it from outside `getClient()`. That is not merely a test-harness inconvenience — it is the production behaviour of the exact dependency the new `/ready` endpoint polls, and the story card's own manual repro steps 2/3/5 ("stop the Crawl4AI container", "block the port with a listener that never responds") drive straight into it. The finding was written up carefully and accurately, but only as a header comment in `packages/toolkit/src/readiness.test.ts`, `packages/toolkit/src/crawl4ai-probe.test.ts`, and `packages/api/src/ready.test.ts`, where it reads as a justification for a test-fixture choice. The spec's own Risks section told the coder to "report it as a finding" if a scenario proved unworkable, but there is no channel that carries a finding out of the unit other than the diff itself, so the hazard reached review only because a reviewer read the test comments and then verified the vendored `eventsource` source by hand.

**Suggested change**: when a coder works around a scenario because the *production* dependency behaves badly (not because the test harness is awkward), require the hazard to be raised in the unit's completion report to the lead as an explicit finding, in addition to any code comment. A rationale comment on a fixture and a reported production defect are different artifacts with different readers; the comment alone routes a production risk to whoever next edits that test file.

### A behavioural fix for a review finding ships without a test pinning it, while the same round adds tests for the finding's test-quality siblings

**Area**: flow (review-finding remediation, coder round N+1)

**Observed** (state during round 2; **resolved before the story shipped** — recorded for the lesson, not as a live defect): on `health-liveness-readiness-split` round 2, the coder closed three round-1 findings. The two *test-quality* findings were closed with test edits (a pinned `detail` assertion, a `pollUntil` replacing a fixed sleep). The one *behavioural* finding — gating `transport.onerror`'s `resetClient()` on `err instanceof SseError` so a failed tool-call POST no longer tears down the shared transport — was for a time a production-code change plus a long rationale comment with no test: nothing in `packages/toolkit/src/crawl4ai-probe.test.ts` could then produce a non-2xx POST to `/messages`, so reverting the gate left the suite green. The same round later added a `post_fails` fake mode and a test pinning the gate, which is what closed it. The unit was otherwise unusually test-driven — every hazard named in the spec's amendments has a dedicated scenario — so the gap sat specifically at the review-fix boundary, not as a general habit. Root `CLAUDE.md` already says "Add tests for changed behavior", but the review-remediation round has no step that re-applies it to the fixes themselves.

**Suggested change**: require each round of review-finding remediation to state, per finding, either the test that now fails without the fix or an explicit reason no test can reach it; and have the re-review round check that claim by mutation (revert the fix, expect a red test) rather than by reading the diff. A fix that no test pins is indistinguishable from no fix on the next refactor.

### A commit landed in a coder's worktree mid-task from outside its own session, mixing an unrelated change into the coder's uncommitted work

**Area**: flow (worktree isolation during an active coder unit)

**Observed**: on `health-liveness-readiness-split`, the coder started with `HEAD` at `059c8df` and a clean tree, then built round 1 (the ownership-guard fix plus QA's three tests) as uncommitted changes and moved on to review/fix-loop rounds without committing. Partway through round 2, `HEAD` in the same worktree had advanced to `425a565` — a commit titled `docs(spec): reconcile Tasks and Design with the amendment's reset policy`, made by the **story lead orchestrating this very unit** while the coder was mid-loop. Its diff was not just the spec-doc fix its message describes: it also carried the coder's entire uncommitted round-1 code diff (`crawl4ai.ts` and `crawl4ai-probe.test.ts`, matching byte-for-byte), swept in because the lead staged with `git add -A` in the coder's dirty worktree instead of naming the one file it meant to commit. The coder only discovered this because a `git diff --numstat` count didn't match an earlier number from memory; nothing in the task flow surfaces a mid-task base change, and the coder's own instructions assume the worktree is exclusively theirs for the unit's duration. The result is one commit whose message misdescribes its contents (a spec doc fix bundled with an unrelated code change neither reviewed together nor scoped as one coherent change, violating this repo's own "keep commits scoped to one coherent change" rule), and a coder that had to stop mid-task to reason about a base it didn't expect to move.

**Suggested change**: worktrees dispatched to a coder for the unit's `qa`→`review`→`fix`→`commit` loop should be treated as exclusively owned for that duration — no other session (including the human working directly, or a sibling story's lead) should commit into a worktree another coder currently has checked out and dirty. If a human or another agent needs to land an unrelated fix (like a shared spec doc correction) while a coder is mid-unit, it should go through a separate worktree/branch, not the coder's own dirty tree. Short of enforcement, the coder role should at least check `git rev-parse HEAD` against the value it was dispatched with before its final commit, and escalate to the lead if it moved.

### An improvement note describing a mid-round state is committed alongside the change that invalidates it

**Area**: flow (process-feedback capture during a fix round)

**Observed**: commit `7d0fd4a` on `health-liveness-readiness-split` does three things at once: it adds the `err instanceof SseError` gate to `transport.onerror`, it adds the `post_fails` fake-server mode plus the test `"onerror does not close the transport for a failed tool-call POST"` that pins that gate, and it adds the entry above asserting that the gate "shipped as a production-code change plus a long rationale comment, with no test", that "Nothing in `packages/toolkit/src/crawl4ai-probe.test.ts` can produce a non-2xx POST to `/messages`", and that "reverting the gate leaves 14/14 green". All three assertions were true at the parent commit `425a565` (14 tests in that file) and false at `7d0fd4a` (15 tests, the new one being exactly the missing discriminator). The note was drafted mid-round as an accurate observation, then carried forward unchanged into the commit that closed the gap it describes. Nothing in the flow re-reads a pending improvement note against the diff it is about to ship in, so a note written in the present tense silently becomes a false record of the repository the moment the same round fixes it — and this file is explicitly a durable record read by later agents.

**Suggested change**: treat a pending `AGENTS_IMPROVEMENTS.md` entry as part of the change under review rather than as commentary alongside it. Before committing, re-check each entry's `Observed` claims against the final diff and either delete the entry (the round resolved it), rewrite it in the past tense scoped to the round it describes, or keep only the residual general lesson. Where an entry states a falsifiable check ("reverting X leaves N/N green"), re-run that check against the commit being made, not the state the note was drafted in.
### Environment-specific validation findings discovered during implementation should be folded back into the spec's Validation section

**Area**: flow (spec -> implementation -> QA handoff)

**Observed**: The spec for `align-compose-stack-with-deployed-images` lists its acceptance commands plainly (`docker compose build crawl4ai`, crawl `http://localhost:11235`). None of them work as written on this machine. The implementer had to discover three environment facts to get a real pass: the pinned base image's browser-binary guard only resolves on `linux/amd64` so the build needs `DOCKER_DEFAULT_PLATFORM=linux/amd64` (this records what was discovered mid-implementation; the shipped fix instead pins the service-scoped `platform:` key in `docker-compose.yml`, so the env var is no longer current guidance); the container binds `127.0.0.1` and is unreachable from the host unless `CRAWL4AI_API_TOKEN` is set; and host port 11235 is held by a concurrent sibling worktree's container, requiring a `!override` port remap rather than stopping the sibling. All three reached QA only through the ephemeral task message, never through the spec, whose Validation section still reads as if the plain commands suffice. Anyone re-running acceptance from the spec alone — a later reviewer, or a re-run after the worktree is gone — hits three consecutive failures that look like defects but are not.

**Suggested change**: Make it part of the implementation-to-QA handoff that any environment-specific precondition or workaround discovered while executing a spec's Validation steps is written back into that Validation section (as a precondition note next to the affected command), not just relayed in the handoff message. Ephemeral agent messages are not a durable home for acceptance preconditions.

### The `code-review` skill assumes a GitHub pull request, but every review in this flow targets an uncommitted worktree diff

**Area**: skill:code-review

**Observed**: Reviews in this pipeline run against the uncommitted working-tree diff of a `.worktrees/<slug>/` checkout — no pull request, no pushed branch, no commit SHA for the changed lines. The skill is written end-to-end for a PR: step 1 checks whether the PR is closed/draft/already reviewed, steps 4c-4d dispatch agents to read "previous pull requests that touched these files" and their review comments, step 7 re-runs the PR eligibility check, and step 8 posts the result with `gh` in a mandated format built from permalinks that require a full commit SHA. None of that is reachable for uncommitted work, so the reviewer must silently discard roughly half the prescribed procedure and invent a report shape, while the caller's own instructions ask for findings relayed "as-is" from a skill that never produced them in the expected form. This is the second round of the same review to re-derive that adaptation from scratch.

**Suggested change**: Give the skill an explicit uncommitted/worktree mode selected from the target it is handed: skip the PR eligibility and re-eligibility steps, replace the PR-history agents with `git log`/`git blame` over the touched paths, and specify a non-`gh` output shape that cites `absolute/path:line` instead of SHA permalinks. Failing that, state in the skill that non-PR targets are out of scope so callers route them elsewhere rather than each reviewer improvising.
### A spec must state plainly when it cannot satisfy a card acceptance criterion as written

**Area**: flow (spec authoring against a story card)

**Observed**: while specing `normalize-crawl4ai-config-payloads`, the empirical investigation the card itself commissioned proved that two of the card's own statements are mutually unsatisfiable against the pinned provider image: "the default stealth **and proxy** `browser_config` behavior is preserved" cannot hold at the same time as "no Web Tools code path can emit a config shape that Crawl4AI rejects with a 400", because the proxy field is exactly what the provider rejects. The first spec draft resolved this the easy way — the matching acceptance scenario quietly added "and no proxy configured" and moved on. Nothing in the draft was false, but a downstream story-acceptance reviewer diffing scenarios against the card's criteria would have had to notice a dropped clause by close reading. The audit caught it; nothing in the flow required the spec to declare it.

**Suggested change**: require a spec to carry an explicit "Deviations from the card" section whenever its design cannot satisfy a card acceptance criterion or scope item as literally written — naming the criterion's own sentence, the reasoned override, and the follow-up it implies. Narrowing the criterion inside a scenario's wording should not be an available option. The lead should then carry that section into the story-acceptance audit and the PR rather than letting it be discovered at review time.

### Cards should date-stamp their HEAD-state assertions

**Area**: flow (story cards in `docs/tasks/`)

**Observed**: `normalize-crawl4ai-config-payloads` scoped "introduce a test runner for the packages this story touches if none exists", asserting at length that at HEAD "the repository has no test framework, no `*.test.ts` files, and no `test` script" in three named `package.json` files. All of that was true when the card was written and false by the time it was invoked: a sibling story had landed `node:test`, `tsconfig.test.json`, five `*.test.ts` files, and a `test` script in every package. The card's code citations had drifted too (`web_fetch`'s wrapped config is at `functions.ts:168-181`, not the cited `:158-167`). Nothing broke, but the lead has to re-verify every factual claim on a card before trusting any of it, and a card that reads as ground truth can quietly send a coder to re-provision infrastructure that already exists.

**Suggested change**: when a card asserts something about the state of HEAD — line numbers, "no X exists yet", "no test framework" — record the commit or date it was verified against, in the card itself. Then a lead picking the card up can tell staleness from fact at a glance, and a card whose stamp predates recent merges is a signal to re-verify rather than a claim to build on. This complements the existing rule that shared-infrastructure scope items carry a coordination note naming the sibling story that might land the same thing first.

### Behavior asserted only in a spec's Design section gets no test, because coders test the Requirements list 1:1

**Area**: flow (spec authoring / test planning)

**Observed**: `normalize-crawl4ai-config-payloads`'s Design section states that the normalizer "is applied inside the shared `call(name, args)` function so `crawl`, `md`, `screenshot`, `pdf`, and `execute_js` are all covered. The last three carry no config keys today, so for them it is a pass-through." That is a real behavioral claim about four tools, and it is exactly the kind of claim that silently breaks. But the Requirements section — the part a coder walks scenario by scenario — contains no scenario naming any tool other than `crawl`. The coder produced a near-exact 1:1 test per scenario, so all four other tools shipped untested; QA had to add the pass-through and fail-fast coverage for `web_screenshot` / `web_pdf` / `web_execute_js`. The same shape produced the other gaps QA filled (the spec records `--magic`'s changed user-visible behavior in "Deviations from the card", with no Requirement scenario, so no test existed for it either).

**Suggested change**: when a spec asserts behavior in Design or Deviations that no Requirement scenario covers, either promote it into a scenario or mark it explicitly as untested-by-design with a reason. A cheap enforcement point: have the spec author, before handing off, grep their own Design/Deviations sections for behavioral claims and check each one maps to a scenario. Coders reasonably treat the Requirements list as the test plan; anything outside it needs to be either restated there or declared out of test scope.

### Process-feedback notes are written into the shared root checkout, where parallel agents clobber each other

**Area**: flow (`AGENTS_IMPROVEMENTS.md` writes during parallel story work)

**Observed**: four leads ran concurrently on four stories. Each lead works in its own worktree, but every agent that files a process note writes to `docs/AGENTS_IMPROVEMENTS.md` in the **repository root checkout**, on the base branch, uncommitted. Two auditors from two different stories accumulated notes there at the same time. When this lead reverted what it believed was its own auditor's stray edit, it discarded the other story's note in the same `git checkout --` and had to reconstruct it from a transcript — exactly the "never discard unrelated worktree changes" failure the repository rules warn about, produced by the flow rather than by carelessness. Anyone committing that file from the root would also sweep up another story's in-flight note into an unrelated commit.

**Suggested change**: have each agent file its process notes inside the worktree it is working in, so the note travels with that story's branch and PR and never lands in the shared root checkout. Failing that, tell agents to append only, never to revert or `git checkout --` that file, and to assume any other pending edit in it belongs to a concurrent story.

### The code-review skill assumes a GitHub PR, but this flow always hands it an uncommitted worktree diff

**Area**: skill:code-review

**Observed**: every review in this pipeline runs against uncommitted changes in a `.worktrees/<slug>/` checkout — there is no PR, because the repository rules forbid branching or opening one unless asked. The skill's procedure is written end to end for a PR: step 1 checks whether the PR is closed/draft/already reviewed, step 4d reads previous pull requests and their comments, step 7 re-checks PR eligibility, and step 8 posts the result with `gh pr comment` in a fixed Markdown format built around permalinks with a full commit SHA. None of that is reachable for an uncommitted diff, and the mandated output format cannot be produced (no SHA exists for the lines under review). The reviewer has to silently improvise a substitute procedure on every single invocation, which is exactly where a step gets dropped.

**Suggested change**: give the skill an explicit worktree-diff mode selected by the target it is handed. In that mode: skip the PR eligibility checks and the prior-PR-comments pass, substitute `git log`/`git blame` on the touched files for historical context, and specify the non-PR output contract — absolute file path plus line range instead of a SHA permalink, returned to the caller rather than posted with `gh`. Keep the parallel-agent fan-out and the 0-100 confidence filter unchanged; those are the parts that carry the value and they are target-agnostic.

### The code-review skill's fixed 7-agent fan-out ignores the caller's effort level and assumes a subagent tool the reviewer may not have

**Area**: skill:code-review

**Observed**: the reviewer agent is invoked with an explicit effort level (`low` for a single-unit review, `medium` for the lead's whole-story integration review), but the skill's procedure is a fixed pipeline — one Haiku eligibility agent, one Haiku CLAUDE.md-locator, one Haiku summarizer, five parallel Sonnet reviewers, then one Haiku scorer per issue found. Nothing in it reads or reacts to an effort level, so `low` and `medium` produce the identical, maximal procedure. Worse, this reviewer's tool set contained no subagent-launch tool at all, so the mandated fan-out was not executable and the whole procedure had to be performed inline by one agent. Both the effort parameter and the fan-out then become fiction the reviewer silently improvises around, which is where passes get dropped without anyone noticing.

**Suggested change**: have the skill declare which passes are mandatory at each effort level (for example: `low` = diff-only bug scan plus CLAUDE.md adherence; `medium` = add git history, prior-review context, and code-comment adherence) and state that the passes are the contract while the fan-out is only an optimization — so a reviewer without a subagent tool runs the same passes sequentially and says so, instead of quietly substituting its own shorter procedure. Have it read the effort argument it is already being handed rather than ignoring it.


### A spec amendment that supersedes a design rule must reconcile the Tasks checklist that still states the old rule

**Area**: flow (spec amendment after integration review, `docs/specs/`)

**Observed**: `docs/specs/health-liveness-readiness-split.md` gained a post-integration-review amendment in its Design section that explicitly supersedes an earlier rule, stating that `probeCrawl4AI` must call `resetClient()` on **every** failure branch "including `timeout`". The Tasks checklist further down the same file was not reconciled and still instructs the coder to "reset `client`/`connecting` on rejection only (not on timeout)" — the exact rule the amendment overturned. The two instructions are in the same document and directly contradict each other. A coder working the checklist implements the superseded behavior; a reviewer checking the diff against the checklist reports a false finding. Neither reads as obviously stale, because the amendment announces itself only in the Design section and the Tasks entry carries no marker that it was written pre-amendment.

**Suggested change**: make reconciling every other section of the spec — Tasks entries, Requirements scenarios, and the Validation list — a required step of writing an amendment, not an optional follow-up. At minimum require the amendment to enumerate which existing bullets it invalidates and to edit them in the same pass, so the spec never carries two live instructions for the same decision.
