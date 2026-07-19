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
