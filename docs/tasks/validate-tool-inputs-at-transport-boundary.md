---
type: story
title: Validate tool inputs at the REST and toolkit boundary
---

# Validate tool inputs at the REST and toolkit boundary

- [ ] Validate tool inputs at the REST and toolkit boundary #improvement ⏫ 🆔 validate-tool-inputs-at-transport-boundary ⛔ normalize-crawl4ai-config-payloads
  - Phase: Phase 2 - Contract Consistency
  - Problem: the REST transport hands the raw request body straight to a toolkit function without parsing it against the tool's registered Zod schema. Invalid input is therefore not rejected locally with a useful message; it is forwarded to Crawl4AI, which rejects it with a bare `HTTP/1.1 400 Bad Request` carrying no validation detail back to the caller. The same input rejected by MCP with a precise schema error is accepted by REST and turned into an opaque upstream failure. This also makes every malformed request cost a network round trip to a provider service.
  - Evidence - production logs (Railway, service `Crawl4AI`, 2026-07-12 and 2026-07-18 UTC). 72 retained lines with no validation detail attached:
    ```text
    HTTP Request: POST http://127.0.0.1:11235/crawl "HTTP/1.1 400 Bad Request"
    ```
    - 1 occurrence at `2026-07-12 11:48:40,553`; 51 between `2026-07-18 18:56:01,062` and `19:05:06,280`; 19 between `20:48:37,369` and `21:13:37,025`.
    - Nothing in the Web Tools logs records which tool call produced any of them, because Web Tools logs no request id, no tool arguments, and no target URL.
  - Evidence - code at HEAD (line numbers verified against the current working tree):
    - `packages/api/src/handler.ts:12` - the entire REST validation story is a raw pass-through:
      ```ts
      const result = await handler(req.body);
      ```
      There is no `parse`, no `safeParse`, and no reference to the tool's schema anywhere in the file. A body of `{}` reaches the toolkit unchanged.
    - `packages/api/src/mcp.ts:25` - MCP, by contrast, registers `tool.parameters.shape ?? {}` with the SDK, so the SDK validates MCP arguments. The two transports therefore disagree on what input is acceptable.
    - `packages/toolkit/src/functions.ts:199-213` - `web_screenshot`, `web_pdf`, and `web_execute_js` perform **no** defensive checks and forward `params` verbatim:
      ```ts
      export async function web_screenshot(params: Record<string, unknown>): Promise<ToolResult> {
        return proxyCrawl4AI('screenshot', () => callScreenshotTool(params)).then(...)
      }
      ```
      `POST /api/v0/web_screenshot` with `{}` reaches Crawl4AI with no `url` at all.
    - `packages/toolkit/src/functions.ts:120-126` - `web_fetch` is the **only** Crawl4AI tool with a hand-written guard, and it checks presence but not URL validity:
      ```ts
      const url = params.url as string | undefined;
      if (!url) { return { content: [{ type: 'text', text: 'web_fetch error: missing required `url`' }], isError: true }; }
      ```
    - `packages/toolkit/src/schemas.ts:44-62` - correct schemas already exist and are unused by REST: `WebScreenshotInput` requires `url: z.string().url()`, `WebExecuteJsInput` requires `scripts: z.array(z.string()).min(1)`, `WebCrawlInput` requires `urls: z.array(z.string().url()).min(1)`.
    - `packages/toolkit/src/tools.ts` - each registry entry already carries its schema on `parameters`, so the schema is available at the point where the REST route is generated (`packages/api/src/index.ts:108`).
    - [`../ARCHITECTURE.md`](../ARCHITECTURE.md) documents this as known debt: "REST currently does not parse request bodies with the registered Zod schemas before execution. Toolkit functions perform uneven defensive checks, so invalid-input behavior can differ from MCP until Phase 2 validation work is complete."
  - Reproduction steps:
    1. Start the API with a reachable Crawl4AI and a valid API key.
    2. `POST /api/v0/web_screenshot` with body `{}` and a valid bearer token. Observe the request is forwarded to Crawl4AI, that the Crawl4AI container logs a `400 Bad Request` on `127.0.0.1:11235`, and that the caller receives an opaque Crawl4AI error rather than "missing required field `url`".
    3. `POST /api/v0/web_crawl` with `{"urls":[]}`. Observe the empty list is forwarded rather than rejected by the `min(1)` constraint the schema already declares.
    4. `POST /api/v0/web_crawl` with `{"urls":["not-a-url"]}`. Observe the invalid URL is forwarded rather than rejected by the `z.string().url()` constraint.
    5. Issue the same three inputs over MCP. Observe MCP rejects each with a schema error, proving the two transports disagree.
  - Scope:
    - Parse the request body with the registered tool schema in the REST handler before dispatching to the toolkit, using `safeParse`, and return HTTP 400 with a structured, field-level validation error on failure.
    - Ensure the validated and coerced value is what gets passed to the toolkit function, so REST and MCP execute on identical parsed input.
    - Give the REST validation error a stable JSON body shape covering the failing field paths and messages. Do not leak internal stack traces or configuration.
    - Remove the now-redundant ad-hoc `url` guard in `web_fetch` only if the schema-based path fully covers it through every interface that can reach the function, including the CLI. The CLI calls toolkit functions directly and bypasses both transports, so either keep a toolkit-level guard or add validation inside the toolkit functions themselves.
    - Cover all nine registered tools, not just the Crawl4AI-backed ones.
    - Introduce a test runner for `packages/api` if none exists. At HEAD the repository has **no test framework, no `*.test.ts` files, and no `test` script** in the root `package.json`, `packages/toolkit/package.json`, or `packages/api/package.json`. This story's acceptance criteria require REST-level tests, so a runner and a `test` script for `packages/api` must be part of the work. Node's built-in `node:test` is sufficient and adds no dependency.
  - Out of scope:
    - Correcting the Crawl4AI config envelope, which this story depends on. Validation must encode the shape settled by `normalize-crawl4ai-config-payloads`.
    - Request logging and correlation ids - tracked by `request-correlation-logging`.
    - Changing any tool's schema contents, other than what the dependency story settles.
    - Adding validation to the MCP path, which the SDK already handles.
  - Expected behavior after the fix: an invalid REST body is rejected locally with HTTP 400 and a field-level message, before any provider request is made. The same input produces equivalent rejection over MCP and REST. No malformed Web Tools request reaches Crawl4AI.
  - Acceptance criteria:
    - `POST /api/v0/web_screenshot` with `{}` returns HTTP 400 naming the missing `url` field, and makes zero requests to Crawl4AI, asserted against a stub that records inbound calls.
    - `POST /api/v0/web_crawl` with `{"urls":[]}` returns HTTP 400 citing the `min(1)` constraint, and makes zero Crawl4AI requests.
    - `POST /api/v0/web_crawl` with `{"urls":["not-a-url"]}` returns HTTP 400 citing the invalid URL, and makes zero Crawl4AI requests.
    - `POST /api/v0/web_execute_js` with a valid `url` but no `scripts` returns HTTP 400, and makes zero Crawl4AI requests.
    - A valid body for each of the nine registered tools still succeeds, asserted per tool, so validation introduces no regression.
    - The toolkit function receives the parsed result of `safeParse` rather than the raw body, asserted by a test where a schema default or coercion is observable in the value the function receives.
    - The REST validation error body has a documented, stable shape with field paths and messages, and contains no stack trace, no configuration value, and no API key.
    - Equivalent invalid input is rejected by both MCP and REST, asserted by a paired test per transport for at least three tools.
    - Invoking a toolkit function directly with invalid input (the CLI path) fails with a clear error rather than forwarding it to a provider.
    - `pnpm build` and `pnpm typecheck` pass, and the new tests run via the `test` script and pass.
  - References:
    - `packages/api/src/handler.ts` - the raw `req.body` pass-through
    - `packages/api/src/index.ts` - REST route generation from the registry
    - `packages/api/src/mcp.ts` - the MCP path that already validates
    - `packages/toolkit/src/schemas.ts` - the existing unused Zod schemas
    - `packages/toolkit/src/tools.ts` - the authoritative registry carrying each schema
    - [`../ARCHITECTURE.md`](../ARCHITECTURE.md) - "Authoritative Contracts"; the documented REST validation gap
    - [`../PRODUCT.md`](../PRODUCT.md) - Phase 2 exit condition "Contract tests cover interface-level validation and error mapping"
