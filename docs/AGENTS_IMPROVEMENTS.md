# Agent Pipeline Improvements

Concrete proposals for improving the agent workflow used in this repository.

Add an entry only when a specific pipeline, agent, or skill improvement is discovered. Check for an existing equivalent entry first. Product and implementation work does not belong here.

### Issue-note shaping must not assert "no fix identified" while its own Reproduction section is unperformed

**Area**: flow (issue-note shaping, `docs/issues/`)

**Observed**: `docs/issues/searxng-egress-proxy-reputation.md` states as its `Status` line and in "Why no solution could be identified" that the root cause is confirmed to sit outside the repo's control (proxy exit-IP/ASN reputation). Its own "Reproduction" section, in the same file, says the protocol that would confirm or refute that exact hypothesis "Not yet performed." The evidence offered for the hypothesis (near-identical rejection timestamps across seven providers) is also explainable by SearXNG's own concurrent per-engine fan-out — every metasearch call hits all active engines within the same second by design — so the "strongest single piece of evidence" doesn't cleanly discriminate between "reputation" and "our own request volume/pattern," which the note elsewhere concedes it can't rule out. `docs/issues/README.md` frames an issue note as the durable record of an investigation that "concluded" with no actionable fix, which reads as a settled finding, not a hypothesis pending its own stated confirmation step.

**Suggested change**: When shaping an issue note, require the "why no solution could be identified" conclusion to either (a) reflect that the confirming reproduction was actually run, or (b) be phrased as a provisional/leading hypothesis with `Status` and the conclusion section worded accordingly (e.g. "suspected, unconfirmed") until the reproduction closes the gap. Treat an unperformed reproduction step as a blocker on a confirmed-root-cause framing, not a footnote. No agent currently owns `docs/issues/` shaping, so this rule also needs a home.

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
