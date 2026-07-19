# Web Tools Agent Guide

Web Tools is a self-hosted web toolkit for search, browser extraction, screenshots, PDFs, JavaScript execution, crawling, Wayback access, and process-local usage statistics through MCP, REST, and a CLI.

## Start Here

- [`docs/PRODUCT.md`](docs/PRODUCT.md) defines product intent, boundaries, and delivery phases.
- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) defines system boundaries and request flow.
- [`README.md`](README.md) is the user-facing setup and usage guide.

## Repository Structure

```text
packages/        # Toolkit, API, and CLI; see packages/AGENTS.md
services/        # Crawl4AI and SearXNG; see services/AGENTS.md
docs/            # Product and engineering docs; see docs/AGENTS.md
library/         # Research wiki; see library/AGENTS.md
```

## Global Rules

- Preserve package boundaries and the four-service deployment model documented in `docs/ARCHITECTURE.md`.
- Product decisions belong in `docs/PRODUCT.md`; architecture decisions belong in `docs/ARCHITECTURE.md` or focused design documents.
- Make the smallest correct change. Add tests for changed behavior; never weaken checks to make a change pass.
- Never inspect, output, or commit secrets or `.env` files.
- Follow the nearest scoped `AGENTS.md` for directory-specific rules.

## Validation

- Build all packages: `pnpm build`
- Type-check all packages: `pnpm typecheck`
- Run all tests: `pnpm test` (Node's built-in `node:test` runner; per-package `pnpm --filter <pkg> test`)
- Format TypeScript: `pnpm format`
- Run package-specific checks for isolated changes, but run the root build before declaring cross-package work complete.

## Git

- Use Conventional Commits and keep commits scoped to one coherent change.
- Never branch, commit, push, or open a pull request unless explicitly asked.
- Never discard unrelated worktree changes.
