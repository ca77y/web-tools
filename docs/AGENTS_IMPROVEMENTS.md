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
