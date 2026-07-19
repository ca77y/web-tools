# Packages

The pnpm workspace contains the framework-agnostic toolkit and two interface adapters.

## Boundaries

- Keep tool schemas, provider clients, implementations, normalized results, and statistics in `toolkit/`.
- Treat `toolkit/src/tools.ts` and its Zod schemas as the authoritative tool registry and intended input contract.
- Keep `api/` and `cli/` as adapters; do not reimplement provider or tool behavior in either package.
- Keep MCP and REST aligned through the same toolkit function map.
- Keep the CLI as a direct toolkit consumer; it does not call the HTTP API.
- Keep provider-specific SearXNG, Crawl4AI, and Wayback protocol details inside toolkit clients.
- Do not leak raw provider response shapes unless a tool deliberately promises them.

## Engineering

- Use Node.js 22 and pnpm.
- Keep ESM imports explicit with `.js` suffixes in TypeScript source.
- Validate untrusted input with the registered Zod schema at interface boundaries. Existing REST and CLI validation gaps are documented debt, not a second contract.
- Return actionable errors with safe upstream context. Do not turn provider failures into successful empty results.
- Treat usage statistics as process-local estimates that reset on restart, never as durable billing records.
- Build `toolkit` before packages that consume it.
