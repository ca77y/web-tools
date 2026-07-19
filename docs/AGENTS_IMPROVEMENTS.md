# Agent Pipeline Improvements

Concrete proposals for improving the agent workflow used in this repository.

Add an entry only when a specific pipeline, agent, or skill improvement is discovered. Check for an existing equivalent entry first. Product and implementation work does not belong here.

### Define the repository's worktree directory in project context

**Area**: flow

**Observed**: The lead is instructed to create story worktrees "under the repository's worktree directory per project context", but no such directory is defined anywhere in `CLAUDE.md`, `AGENTS.md`, `docs/CLAUDE.md`, or `.gitignore`. The lead has to invent a location, and the obvious in-repo choice (`.worktrees/`) is not gitignored, so it would show up as untracked noise in the root checkout that the Obsidian board scans. This forces an undocumented, per-run judgement call about where isolated work lives.

**Suggested change**: name the worktree directory explicitly in `AGENTS.md` (or `CLAUDE.md`) and, if it lives inside the repository, add it to `.gitignore` in the same change, so every story uses the same location and the root checkout stays clean.

### Flag cross-story test-infrastructure races in the Coordination section

**Area**: flow

**Observed**: Three independent Phase 1/3 story cards — `distinguish-search-failure-from-empty-results.md`, `search-client-fanout-and-timeout-budget.md`, and `request-correlation-logging.md` — each independently scope "add the `node:test` runner, since the repo has none yet" as part of their own story, because none of them existed when the others were drafted. Only the first two of the three note their `searxng.ts` content-edit overlap in a "Coordination" section; none of them flag that whichever lands first will also add the root/toolkit `test` script and runner, and the other two must detect and reuse it rather than re-adding it. A coder working from just one card's spec has no signal that this collision exists.

**Suggested change**: when drafting a spec (or refining a story) whose scope includes "add missing shared infrastructure" (a test runner, a logging helper, a config knob), search sibling `docs/tasks/*.md` for the same infra-provisioning language and add an explicit Coordination note — "if `<sibling story>` lands first, detect and reuse its `<infra>` instead of re-adding it" — mirroring how file-edit overlaps are already called out.

### Do not write acceptance scenarios the spec's own boundary makes untestable

**Area**: flow

**Observed**: An earlier draft of the `distinguish-search-failure-from-empty-results` spec stated four "Requirement: Transport reporting" scenarios (total failure over MCP, over REST, through the CLI, and genuine empty across all three) while its Boundary section forbade modifying `packages/api` and `packages/cli` and scoped all new test files to `packages/toolkit/src/`. Since neither transport package had any test setup at that point, those four scenarios had nowhere to execute — satisfiable only by source inspection, which the spec itself ruled out ("must be confirmed by test, not by editing transport code"). The requirement was unfalsifiable as drafted. This was caught during implementation and the spec's own Boundary section was amended to extend test infrastructure (test files and a `test` script only, no runtime changes) into `packages/api` and `packages/cli`, after which all four scenarios execute for real against the adapters' production code.

**Suggested change**: when a spec marks a requirement verify-only, make the spec state where its verification runs. Either extend the test-infrastructure scope to the package that owns the behavior (adding a `test` script there is the same few lines), or write the scenario at the boundary that is actually reachable — e.g. assert the toolkit-side error shape the transports consume — and say plainly that the transport wrappers are covered by inspection. A spec should never contain an acceptance criterion its own boundary section makes impossible to run.

### Rejecting a reviewer finding "by argument" needs a concrete counter-scenario, not a restated conclusion

**Area**: agent:coder

**Observed**: On `distinguish-search-failure-from-empty-results`, a coder closed two reviewer findings about the `unresponsive_engines`-based failure classification (in `packages/toolkit/src/searxng.ts`, the "any non-empty `unresponsive_engines` on zero results ⇒ failed" branch) by judging they "contradicted already-validated spec scenarios," and applied only a comment-only edit — no behavior change. A later independent pass constructed the concrete counter-scenario the findings were pointing at (`SEARXNG_ENGINES="google,bing,duckduckgo"`, only `bing` times out, `google`/`duckduckgo` genuinely find nothing ⇒ zero results, one engine listed unresponsive) and confirmed the code did misclassify a genuine no-match as a total failure — the literal spec scenario said "every engine," the code checked "any engine." The rejection's stated reasoning never traced an actual input through the code; it asserted alignment with the spec without demonstrating it.

**Suggested change**: when a coder rejects a reviewer finding, require the rejection to include a concrete input/state that the coder traced through the actual code and got the claimed-correct output from — the same standard `ReportFindings`/review verdicts already apply to confirming a finding. A restated conclusion ("this matches the validated scenario") is not evidence; a walked-through example is.

### `/simplify`'s Phase 1 dispatch pattern doesn't work from the coder's own agent roster

**Area**: skill:simplify

**Observed**: The `coder` agent runs the story-level simplify pass by invoking `/simplify`, whose Phase 1 instructs launching "4 independent review agents via the Agent tool" using the generic `general-purpose` subagent type. Inside this pipeline the `coder`'s `Agent` tool call failed outright — `general-purpose is not available to this pipeline` — because the fleet restricts the coder to the named `ca77y-engineering:*` agents. The skill has no fallback path, so the step silently cannot run as written and the coder had to perform all four review angles itself by reading the diff and files directly, which works but isn't what the skill specifies and isn't guaranteed to get the same breadth as four independently-primed agents.

**Suggested change**: either give `/simplify` a documented fallback ("if `general-purpose` is unavailable, perform the four angles directly against the diff instead of dispatching agents") or have it detect the caller's available agent roster and substitute an equivalent named agent (e.g. `Explore` for read-only angles) when `general-purpose` is off-limits.

### The `scribe`'s mandatory `auditor` gate has no reachable auditor

**Area**: agent:scribe

**Observed**: The `scribe`'s instructions make the `auditor` subagent an absolute, non-substitutable gate — it may not self-audit, and a no-result must stop the run and escalate. But the `scribe`'s tool roster contains no agent-spawn tool at all; the only agent-directed tool is `SendMessage`, which requires an already-running teammate. On `distinguish-search-failure-from-empty-results`, `SendMessage` to `auditor` returned `No agent named 'auditor' is reachable`, so the required gate was unsatisfiable by construction and the doc pass had to stop with the spec left in `docs/specs/`. This is not the same as the `/simplify` dispatch gap above: there the skill merely lacked a fallback for an optional optimization, here a hard gate the agent is forbidden to bypass cannot be invoked at all.

**Suggested change**: either give the `scribe` a dispatch tool that can launch the `auditor`, or have the `lead` spawn the `auditor` as a named teammate before invoking the `scribe` and pass its name in the task. Failing both, the `scribe`'s instructions should state explicitly what a run may still deliver when no auditor exists (e.g. commit the doc edits, keep the spec, report docs-incomplete) so the outcome is a defined path rather than an escalation every time.

### Validation gates must cover the container build when build scripts change

**Area**: flow

**Observed**: On `distinguish-search-failure-from-empty-results`, the story changed every package's `build` script from `tsc` to `tsc -p tsconfig.build.json` and added the new `tsconfig.build.json` files, but the root `Dockerfile` copies only `packages/*/tsconfig.json` into the builder stage. `pnpm build` and `pnpm typecheck` — the story's only stated Validation scenario — both pass locally, while `docker build` fails with `error TS5058: The specified path does not exist: 'tsconfig.build.json'`. The spec's Validation requirement names only the two root scripts, so nothing in the story's definition of done could have caught a broken production image.

**Suggested change**: when a story touches a package's `build` script, its `tsconfig*`, or any file the `Dockerfile` copies by name, require a Validation scenario that builds the image (`docker build .` / `docker compose build`) rather than only the root `build`/`typecheck` scripts. The spec author should add that scenario, and the reviewer should treat a build-script change with an unchanged `Dockerfile` as a finding by default.

### Root CLAUDE.md and AGENTS.md keep independent copies of the Validation command list

**Area**: flow

**Observed**: `CLAUDE.md` states "Follow the complete repository rules in `AGENTS.md`" yet still carries its own `## Validation` list (`Build: pnpm build`, `Type-check: pnpm typecheck`), duplicating rather than deferring to `AGENTS.md`'s `## Validation` section. On `distinguish-search-failure-from-empty-results`, the writer correctly added `pnpm test` to `AGENTS.md`'s list (per this story's own docs-placement rule) but had no instruction to touch the mirrored list in `CLAUDE.md`, which is checked into the repo and now understates the validation command set relative to the file it says to defer to.

**Suggested change**: either delete the duplicated `## Validation` list from `CLAUDE.md` and rely on its existing pointer to `AGENTS.md`, or add an explicit rule that any edit to `AGENTS.md`'s `## Validation` section must be mirrored in `CLAUDE.md`'s. Leaving both as independently-maintained copies will keep drifting on every future validation-command change.
### Card shaping must check RAILWAY.md before asserting "deployed" facts

**Area**: flow (story-shaping from repo analysis)

**Observed**: The card `docs/tasks/align-compose-stack-with-deployed-images.md` asserts specific "deployed" facts (deployed Redis runs `redis:8.2.1`; deployed Crawl4AI runs the custom `0.9.1` pinned build) that are not derivable from the repository and are directly contradicted by the repo's own `RAILWAY.md`, whose "Railway Service Configuration" table documents Crawl4AI as deployed via `unclecode/crawl4ai:latest` (a plain Docker image, not the repo build) and Redis via `redis:7-alpine` — matching `docker-compose.yml` exactly. The card never cites `RAILWAY.md`, so whoever shaped it either did not check it or relied on external session context that will not survive into the card. Since the evidence document that produced the card is temporary and gets deleted, any "what's actually deployed" claim needs a citable repo source or must be phrased as unconfirmed.

**Suggested change**: When a card claims something about the deployed/production state of a service, require the shaping step to search the repo for a deployment-config doc (e.g. `RAILWAY.md`, `railway.json`, `*.toml`) and either cite it or explicitly flag the claim as unverified-from-repo rather than asserting it as fact.

### Card shaping must grep `docs/tasks/` for existing cards on the same subsystem before writing a new one

**Area**: flow (story-shaping from a temporary evidence file)

**Observed**: `docs/tasks/searxng-engine-retry-amplification.md` was written as a new `#research` card proposing to measure, then decide whether to differentiate, SearXNG's `retries`/`suspended_times`/`ban_time_on_fail` by failure class. `docs/tasks/searxng-engine-set-and-suspension-policy.md` already exists in the same directory as a more-refined `#bug` card that proposes the same differentiated-suspension outcome (keep 0 for the Google `/sorry/` CAPTCHA path, non-zero for `SearxEngineAccessDenied`/`SearxEngineTooManyRequests`), cites the same production evidence (same 1,000-record sample, same 372-dropped-log incident, same rationale comment), and is already closer to implementation-ready. Neither card references the other. (Correction to an earlier draft of this entry: `search-client-fanout-and-timeout-budget.md` does exist and is not a stale link — it was being written by a concurrently running agent and appeared mid-audit. The duplicate cards `searxng-engine-retry-amplification.md` and `bound-searxng-request-fanout.md` were the redundant ones and have since been removed.)

**Suggested change**: Before finalizing a new card, require the shaping step to `grep`/`ls` `docs/tasks/` (including `_archive` and `_backlog`) for other cards touching the same files or subsystem, and either fold the new evidence into the existing card, explicitly supersede it, or cross-link and de-scope so the two don't duplicate decision work. Also treat a card that links to a sibling story slug as a cue to verify that slug still resolves to a real file.

### Parallel card-shaping agents over one evidence file need disjoint assignments and a pre-write re-check

**Area**: flow (fanning one evidence document out to several concurrent shaping agents)

**Observed**: `docs/tasks/` contained zero story cards at the start of a shaping run scoped to a single problem group. By the time that run finished, 21 cards written by sibling agents working other groups of the same evidence file had appeared, two of which (`search-client-fanout-and-timeout-budget.md`, `searxng-engine-set-and-suspension-policy.md`) covered the assigned group more thoroughly than the cards just written — including root causes the assigned run had missed (client and server timeouts both at 15s; `use_default_settings: true` not restricting the engine set). A duplicate-check performed at the start of the run was correct when taken and stale by the time it mattered, so the duplication was only caught by the advisor gate. Problem groups in an evidence file are not cleanly separable: one root cause routinely spans several groups.

**Suggested change**: When fanning one evidence file out to parallel shaping agents, either (a) have a single agent shape all groups so cross-group root causes are seen once, or (b) require each agent to re-list `docs/tasks/` immediately before writing each card, not only at intake, and to reconcile against anything that appeared meanwhile. Also tell each agent which groups its siblings own, so overlap is expected and cross-linked rather than discovered as duplication.

### Issue-note shaping must not assert "no fix identified" while its own Reproduction section is unperformed

**Area**: flow (issue-note shaping, `docs/issues/`)

**Observed**: `docs/issues/searxng-egress-proxy-reputation.md` states as its `Status` line and in "Why no solution could be identified" that the root cause is confirmed to sit outside the repo's control (proxy exit-IP/ASN reputation). Its own "Reproduction" section, in the same file, says the protocol that would confirm or refute that exact hypothesis "Not yet performed." The evidence offered for the hypothesis (near-identical rejection timestamps across seven providers) is also explainable by SearXNG's own concurrent per-engine fan-out — every metasearch call hits all active engines within the same second by design — so the "strongest single piece of evidence" doesn't cleanly discriminate between "reputation" and "our own request volume/pattern," which the note elsewhere concedes it can't rule out. `docs/issues/README.md` frames an issue note as the durable record of an investigation that "concluded" with no actionable fix, which reads as a settled finding, not a hypothesis pending its own stated confirmation step.

**Suggested change**: When shaping an issue note, require the "why no solution could be identified" conclusion to either (a) reflect that the confirming reproduction was actually run, or (b) be phrased as a provisional/leading hypothesis with `Status` and the conclusion section worded accordingly (e.g. "suspected, unconfirmed") until the reproduction closes the gap. Treat an unperformed reproduction step as a blocker on a confirmed-root-cause framing, not a footnote.

### Reconciling one flagged duplication should re-check every sibling that touches the same code region, not only the pair named in the finding

**Area**: flow (duplication reconciliation after an audit finding)

**Observed**: A reconciliation of `docs/tasks/fix-rotation-block-signal-detection.md` against a flagged overlap with `classify-crawl-upstream-status.md` added an explicit ⛔ dependency and a paragraph naming the exact merge-conflict risk ("both stories edit `trace()` ... doing them in parallel would merge-conflict"). The same file also prescribes edits to `noteBlocked()`/`trace()` in `packages/toolkit/src/functions.ts` that a third sibling, `fetch-non-html-resources-directly.md`, independently prescribes for the same functions (excluding download failures from `noteBlocked()`). That third card depends only on `classify-crawl-upstream-status`, not on `fix-rotation-block-signal-detection`, and neither card's text flags the shared-region risk between the two of them, even though the reconciliation had just demonstrated it knows how to write that disclosure for the other pair.

**Suggested change**: When reconciling a flagged duplication between card A and card B, also grep the board for any other card C that shares A's or B's dependency prerequisite and touches the same file/function region, and apply the same disclosure (dependency edge, or an explicit shared-region note) to C if warranted — not only to the pair the audit named.

### Coordination notes should recompute counts by re-grepping, not carry forward a number written before the last sibling was added

**Area**: flow (coordination-note revision after adding new sibling dependencies)

**Observed**: `docs/tasks/classify-crawl-upstream-status.md`'s "Coordination — other stories edit the same code" section states "This story lands first; two cards declare a dependency on it," naming `fix-rotation-block-signal-detection` and `fetch-non-html-resources-directly`. A third card, `retry-transient-crawl-failures.md`, also carries `⛔ classify-crawl-upstream-status` in its own checkbox line and states at its end "Depends on `classify-crawl-upstream-status`." `grep -rl "⛔ classify-crawl-upstream-status" docs/tasks/*.md` returns three files, not two. The prose count was evidently written (or last true) before the third dependency was added and never recomputed.

**Suggested change**: When a coordination note states a count of dependent/sibling cards, generate that count from a fresh `grep` of the dependency marker across `docs/tasks/` at write time (or just before finalizing edits) rather than writing a fixed number, so a later-added dependency doesn't silently make an earlier card's count stale.

### A resumed auditor cannot reach its caller, so re-audit findings can be silently stranded

**Area**: agent:auditor (and the analyst/lead advisor-gate flow that resumes it)

**Observed**: The advisor gate requires re-running the auditor after non-mechanical edits. Resuming the auditor via `SendMessage` worked, but when it finished it tried to return its second verdict by calling `SendMessage` back to `ca77y-engineering:analyst` and failed — it reported the agent "isn't reachable under that name" and asked to be told the correct identifier. Its re-audit findings (including one genuinely blocking citation defect) were therefore never delivered as a normal result; they existed only inside the raw task transcript, and were recovered only because the caller happened to parse that JSONL output file directly. A caller that simply waited for a reply, or that trusted the first verdict, would have shipped the card with the defect.

**Suggested change**: Make the resumed-agent contract explicit in the auditor's instructions — a resumed auditor should end its turn with the verdict as its final assistant message and must not attempt to `SendMessage` its caller, since the caller receives the return value directly. Correspondingly, callers should treat the resumed agent's completion notification (not an inbound message) as the delivery channel for a re-audit verdict.
