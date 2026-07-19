# Web Tools

A self-hosted web toolkit exposing search, browser-grade extraction, screenshots, PDFs, JavaScript execution, crawling, Wayback access, and process-local usage statistics through MCP, REST, and a CLI. This file carries the complete repository rules; follow the nearest scoped `CLAUDE.md` for directory-specific rules.

## Product Context

- [`docs/PRODUCT.md`](./docs/PRODUCT.md) - intent, boundaries, and delivery phases
- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) - components, contracts, and request flow
- [`README.md`](./README.md) - setup and user-facing usage

## Structure

```text
packages/        # TypeScript toolkit, API server, and CLI
services/        # SearXNG and Crawl4AI service images/configuration
docs/            # Product direction, architecture, known issues, in-flight specs, and story cards
library/         # Markdown research wiki: raw sources, synthesis, and metadata
```

## Architecture Rules

- Make the smallest correct change. Add tests for changed behavior; never weaken checks to make a change pass.
- Preserve package boundaries and the four-service deployment model documented in `docs/ARCHITECTURE.md`.
- Keep tool schemas, provider clients, implementations, and the registry in `packages/toolkit`.
- Keep `packages/api` and `packages/cli` as transport adapters; do not duplicate toolkit behavior.
- Treat `packages/toolkit/src/tools.ts` as the authoritative nine-tool registry.
- Preserve the four-service boundary: Web Tools, Crawl4AI, SearXNG, and Redis.
- Keep MCP and REST on the same handler path. The CLI calls the toolkit directly.
- Do not represent process-local usage statistics as durable billing data.

## Documentation rules

- Product direction belongs in `docs/PRODUCT.md`; user-facing setup belongs in `README.md`.
- System architecture, shipped behavior, and operational design all belong in `docs/ARCHITECTURE.md`.
- Problems that are real but have no identified fix on our side belong in `docs/issues/`.
- In-flight implementation contracts belong in `docs/specs/` and are removed after durable content is folded into the permanent docs.
- Stories live in `docs/tasks/`, one story per Markdown file and one card per story.
- Story states are `[ ]` Todo, `[<]` Ready to start, `[/]` In Progress, `[?]` In Review, `[x]` Done, `[X]` Completed, and `[-]` Cancelled. Todo is unrefined; Ready to start is refined and unblocked.
- Research is evidence, not implementation authority. Keep raw sources and synthesis in `library/`; decisions belong in docs.
- Use lowercase kebab-case for documentation filenames. Keep landmark files such as `README.md`, `CLAUDE.md`, and `AGENTS_IMPROVEMENTS.md` uppercase.
- Never inspect, output, or commit secrets or `.env` files.

## Library routing

Every `library/` lookup, ingest, synthesis, index/taxonomy/log update, or audit goes through the library agents (`librarian`, `scribe`, or `clerk`). Read `library/_meta/librarian.md` before library work. Preserve raw notes and cite durable claims.

## Validation

- Build all packages: `pnpm build`
- Type-check all packages: `pnpm typecheck`
- Run all tests: `pnpm test` (Node's built-in `node:test` runner; per-package `pnpm --filter <pkg> test`)
- Format TypeScript: `pnpm format`
- Run package-specific checks for isolated changes, but run the root build before declaring cross-package work complete.
- Keep code and documentation changes scoped; do not weaken checks to make them pass.

## Git

- Use Conventional Commits and keep commits scoped to one coherent change.
- Never branch, commit, push, or open a pull request unless explicitly asked.
- Never discard unrelated worktree changes.
- Create story worktrees under `.worktrees/<slug>/`, which is gitignored so the root checkout stays clean for the board.
