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

### Validation gates must cover the container build when build scripts change

**Area**: flow

**Observed**: On `distinguish-search-failure-from-empty-results`, the story changed every package's `build` script from `tsc` to `tsc -p tsconfig.build.json` and added the new `tsconfig.build.json` files, but the root `Dockerfile` copies only `packages/*/tsconfig.json` into the builder stage. `pnpm build` and `pnpm typecheck` — the story's only stated Validation scenario — both pass locally, while `docker build` fails with `error TS5058: The specified path does not exist: 'tsconfig.build.json'`. The spec's Validation requirement names only the two root scripts, so nothing in the story's definition of done could have caught a broken production image.

**Suggested change**: when a story touches a package's `build` script, its `tsconfig*`, or any file the `Dockerfile` copies by name, require a Validation scenario that builds the image (`docker build .` / `docker compose build`) rather than only the root `build`/`typecheck` scripts. The spec author should add that scenario, and the reviewer should treat a build-script change with an unchanged `Dockerfile` as a finding by default.
