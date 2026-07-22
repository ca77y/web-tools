---
type: story
title: Add request correlation IDs and structured operation logging
---

# Add request correlation IDs and structured operation logging

- [x] Add request correlation IDs and structured operation logging #improvement ⏫ 🆔 request-correlation-logging
    - Phase: Phase 3 - Operable Service
    - Problem: production logs cannot be tied back to a request, an input, or an outcome. Every log line in the API and toolkit is a bare `process.stderr.write` string with no request ID, no operation name, no duration, and no upstream status. During a production incident on 2026-07-17/18 several failures could not be reconstructed at all, because the logs recorded that *something* failed but not *what was asked for* or *whether the caller ultimately got an answer*.
    - Evidence - search logs identify only an attempt number:
        - Observed line: `SearXNG attempt 1 failed: The operation was aborted due to timeout`
        - Emitted by `packages/toolkit/src/searxng.ts:59`, with sibling lines at `:40` (`SearXNG attempt N: HTTP <status>`), `:49` (`SearXNG attempt N: 0 valid results`), and `:53-55` (`SearXNG attempt N: X results (Y with content)`).
        - The `attempt` value is not a retry counter. `searchSearXNG` (`packages/toolkit/src/searxng.ts:65-75`) fires `Config.parallelRequests` (default `3`, see `packages/toolkit/src/config.ts:36`) *simultaneous identical* requests and labels them 1..3. So three interleaved lines from one user search look like three sequential retries, and lines from concurrent searches interleave with no way to separate them.
        - Omitted: the query, a request ID, the elapsed duration, the SearXNG base URL, the HTTP status on the throw path, and whether a sibling parallel request ultimately succeeded. A logged failure therefore does not tell an operator whether the caller saw a degraded result or a good one.
    - Evidence - Crawl4AI logs omit the target URL:
        - Observed line: `Crawl4AI crawl threw: MCP error -32001: Request timed out`
        - Emitted by `packages/toolkit/src/functions.ts:93` inside `proxyCrawl4AI`, with sibling lines at `:66` (`Crawl4AI <tool> error response: <text>`) and `:78` (`Crawl4AI <tool> returned empty content`).
        - Current signature carries only the tool name, not the arguments:

          ```ts
          async function proxyCrawl4AI(
            toolName: string,
            fn: () => Promise<unknown>,
          ): Promise<ToolResult> {
          ```

        - Omitted: the target URL, a request ID, and the duration. Two Tools-to-Crawl4AI timeouts in the incident window could not be attributed to a specific target URL after the fact.
    - Evidence - three independent duplicate `log` helpers, all unstructured:
        - `packages/api/src/index.ts:17-21`, `packages/toolkit/src/searxng.ts:14-18`, and `packages/toolkit/src/functions.ts:46-50` each define the identical helper:

          ```ts
          const log = (...args: unknown[]) => {
            process.stderr.write(
              args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n',
            );
          };
          ```

    - Scope:
        - Add a single shared logging helper in `packages/toolkit` that emits one structured JSON object per line, and replace the three duplicate `log` definitions above with it.
        - Generate a request ID per inbound API request (honour an inbound `X-Request-Id` header when present, otherwise generate one) and make it available to toolkit calls without threading a parameter through every public tool signature.
        - Attach to every operation log line at minimum: request ID, operation/tool name, outcome (`ok` / `error` / `empty`), duration in milliseconds, and the upstream identifier (SearXNG base URL, or the Crawl4AI target URL).
        - Log the search query and target URL. These are the caller's own inputs, not secrets.
        - For `searchSearXNG`, label the parallel fan-out lines so the three concurrent copies of one search are distinguishable from three separate searches, and log a single summary line per search stating which copy won and whether the caller received results.
        - For `proxyCrawl4AI`, carry the target URL into the log context so the three failure paths (`:66`, `:78`, `:93`) all name the URL.
        - Log a safe summary of the outgoing Crawl4AI argument shape (top-level key names and value types only, never values) on the Crawl4AI call path in `packages/toolkit/src/crawl4ai.ts:46-55`. Crawl4AI rejected 72 requests with a bare `POST http://127.0.0.1:11235/crawl "HTTP/1.1 400 Bad Request"` during the 2026-07-18 incident; that line is emitted by the pinned upstream image's own MCP-to-REST bridge and carries no URL, no validation detail, and no correlation ID, so a shape summary on our side is the only way a recurrence becomes attributable. See [`../issues/crawl4ai-400-burst-root-cause-unrecoverable.md`](../issues/crawl4ai-400-burst-root-cause-unrecoverable.md).
        - Include the request ID in the error text returned to the caller on a Crawl4AI failure, so a user-reported failure can be located in the logs.
        - Log the request's user agent on the API request line. This is what makes the unexplained `GET /mcp` 405 traffic recorded in [`../issues/get-mcp-405-probing.md`](../issues/get-mcp-405-probing.md) attributable to a source.
        - Provision a test runner if none exists yet. The repository currently has **no test framework**: there is no `test` script in the root `package.json` or any package `package.json`, no `*.test.ts` files anywhere under `packages/`, and no `vitest`/`jest` dependency. The secret-redaction acceptance criterion below requires a test, so adding a runner and a `test` script is part of this story unless a sibling story has already landed one.
        - Out of scope: shipping logs to an external aggregator; adding a metrics/tracing backend (OpenTelemetry, Prometheus); changing the `web_*` tool response contracts; changing the parallel-request fan-out count or the SearXNG retry configuration (that is story `searxng-log-volume`); the `res.on('close')` lifecycle bug (that is story `request-lifecycle-abort-propagation`).
    - Constraints:
        - `CLAUDE.md` and [`../ARCHITECTURE.md`](../ARCHITECTURE.md) require provider behavior to stay in `packages/toolkit`; `packages/api` and `packages/cli` remain transport adapters. The shared logger belongs in the toolkit, and the API must not grow its own provider-facing logging.
        - [`../ARCHITECTURE.md`](../ARCHITECTURE.md) "Authentication And Trust": do not log API keys, full secrets, or sensitive target content. The API key arrives via the `Authorization` header and the `api_key` query parameter (`packages/api/src/index.ts:33-35`) - the request logger must redact both, and must not log full response bodies.
        - The CLI writes tool output to stdout (`packages/cli/src/commands/*.ts`). Operation logs must stay on stderr so CLI stdout output remains machine-parseable.
    - Acceptance criteria:
        - A single shared structured-logging helper exists in `packages/toolkit`, and the duplicate `log` definitions at `packages/api/src/index.ts:17-21`, `packages/toolkit/src/searxng.ts:14-18`, and `packages/toolkit/src/functions.ts:46-50` are removed in favour of it.
        - Every emitted operation log line is a single line of valid JSON that parses without error.
        - Each operation log line carries a request ID, an operation name, an outcome, and a duration in milliseconds.
        - An inbound `X-Request-Id` header is reused as the request ID; when the header is absent a unique ID is generated.
        - All log lines produced while serving one API request share that request's ID.
        - A SearXNG failure line names the query, the SearXNG base URL, and the HTTP status when a response was received.
        - The three parallel SearXNG copies of a single search are individually distinguishable in the logs, and are distinguishable from copies belonging to a different concurrent search.
        - One summary line per `web_search` records whether the caller ultimately received results, even when one or more parallel copies failed.
        - All three Crawl4AI failure paths (`packages/toolkit/src/functions.ts:66`, `:78`, `:93`) name the target URL.
        - The API logs each inbound request with method, path, status, duration, and user agent.
        - Neither the `Authorization` header value nor the `api_key` query parameter value appears in any log line, verified by a test that issues an authenticated request and asserts the configured key is absent from captured stderr.
        - Every Crawl4AI call logs a safe summary of its outgoing argument shape recording top-level key names and value types only, verified by a test asserting that no target URL query string, no script body, and neither the configured proxy username nor password appears in any captured log line.
        - The request ID appears in the error text returned to the caller on a Crawl4AI failure.
        - Given a Crawl4AI failure timestamp, the originating tool call and target host are identifiable from the Web Tools log, asserted by a test that issues three concurrent `web_crawl` calls and attributes each Crawl4AI record to exactly one originating call.
        - CLI tool output on stdout contains no operation log lines.
        - A test runner and a `test` script exist and run green (added by this story if no sibling story has already landed one).
        - `pnpm build` and `pnpm typecheck` pass.
    - References: [`../ARCHITECTURE.md`](../ARCHITECTURE.md) (Package Boundaries, Authentication And Trust, Failure Model), [`../PRODUCT.md`](../PRODUCT.md) (Phase 3 exit condition "Logs identify operation, provider, duration, outcome, and safe error context"; Principle 5 "Operational truth is explicit"), `packages/api/src/index.ts`, `packages/toolkit/src/searxng.ts`, `packages/toolkit/src/functions.ts`, `packages/toolkit/src/crawl4ai.ts`, `packages/toolkit/src/config.ts`
