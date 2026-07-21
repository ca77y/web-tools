---
type: story
title: Normalize Crawl4AI browser_config and crawler_config payload shapes
---

# Normalize Crawl4AI browser_config and crawler_config payload shapes

- [/] Normalize Crawl4AI browser_config and crawler_config payload shapes #bug 🔺 🆔 normalize-crawl4ai-config-payloads
  - Phase: Phase 1 - Reliable Core
  - Problem (proven): Web Tools sends **two different, mutually incompatible** `crawler_config` / `browser_config` wire shapes to the same Crawl4AI `crawl` tool depending on which entry point the caller used. `web_fetch` sends the **wrapped** `{ type, params }` form. The CLI `crawl` command and any REST caller following our published Zod schema send a **flat, unwrapped** object. Separately and independently, `web_crawl` **silently discards** a caller's unwrapped `browser_config` keys — the caller gets no error and a different browser configuration than requested. Both defects are proven by the code citations below and justify this story on their own.
  - Hypothesis (unconfirmed): the flat form is what Crawl4AI rejects with `HTTP/1.1 400 Bad Request`. This is **plausible but not established** — it is inferred from the fact that the wrapped `web_fetch` path is known to work in production while the flat path is the only other shape we emit. It is **not** confirmed as the cause of the 2026-07-18 burst, and this story must not be treated as closing that incident. See [`../issues/crawl4ai-400-burst-root-cause-unrecoverable.md`](../issues/crawl4ai-400-burst-root-cause-unrecoverable.md) for why attribution is impossible from the retained logs. Confirming or refuting the hypothesis is the first scope item below.
  - Evidence - production logs (Railway, service `Crawl4AI`, 2026-07-12 and 2026-07-18 UTC). 72 retained lines of exactly this form, with no URL, validation detail, or correlation id:
    ```text
    HTTP Request: POST http://127.0.0.1:11235/crawl "HTTP/1.1 400 Bad Request"
    ```
    - 1 occurrence at `2026-07-12 11:48:40,553`
    - 51 occurrences between `2026-07-18 18:56:01,062` and `19:05:06,280`
    - 19 occurrences between `2026-07-18 20:48:37,369` and `21:13:37,025`
    - The densest part of the burst shows multiple rejections inside a single second, consistent with a caller repeating one malformed request shape rather than a per-URL content failure:
      ```text
      2026-07-18 18:58:04,384 ... 400 Bad Request
      2026-07-18 18:58:04,416 ... 400 Bad Request
      2026-07-18 18:58:04,921 ... 400 Bad Request
      2026-07-18 18:58:04,927 ... 400 Bad Request
      ```
    - The address is loopback (`127.0.0.1:11235`), so these lines are emitted **inside the Crawl4AI container** by its own MCP-to-REST bridge, not by Web Tools. Web Tools reaches Crawl4AI over MCP/SSE (`packages/toolkit/src/crawl4ai.ts:13` builds `new URL('/mcp/sse', Config.crawl4ai.url)`). A 400 therefore means the bridge translated our MCP `crawl` tool arguments into a REST body that its own request model rejected.
  - Evidence - code at HEAD (line numbers verified against the current working tree):
    - `packages/toolkit/src/functions.ts:158-167` - `web_fetch` sends the **wrapped** shape, and this path is known to work in production:
      ```ts
      browser_config: { type: 'BrowserConfig', params: browserParams },
      crawler_config: {
        type: 'CrawlerRunConfig',
        params: { wait_until: 'load', page_timeout: 120000, delay_before_return_html: delay },
      },
      ```
    - `packages/cli/src/commands/crawl.ts:27-38` - the CLI builds a **flat** `crawler_config` and passes it straight through:
      ```ts
      const crawlerConfig: Record<string, unknown> = {};
      if (opts.screenshot) crawlerConfig.screenshot = true;
      if (opts.selector) crawlerConfig.css_selector = opts.selector;
      const params: Record<string, unknown> = { urls };
      if (Object.keys(crawlerConfig).length > 0) params.crawler_config = crawlerConfig;
      ```
    - `packages/toolkit/src/functions.ts:215-250` - `web_crawl` rewrites **only** `browser_config` and forwards `crawler_config` verbatim to `callCrawlTool(params)` at line 247. Nothing ever wraps it.
    - `packages/toolkit/src/schemas.ts:70-144` - `WebCrawlInput.crawler_config` publishes the **flat** shape as the contract: `word_count_threshold`, `css_selector`, `wait_until`, `page_timeout` and ~50 more keys are declared at the top level, with no `type` / `params` envelope. Any caller obeying the documented schema produces a payload `web_fetch` would never send.
    - `packages/toolkit/src/schemas.ts:66-69` - `browser_config` is typed `z.record(z.unknown())`, so both shapes validate.
    - `packages/toolkit/src/functions.ts:218-219` - `web_crawl` nevertheless **assumes the wrapped shape** when reading it:
      ```ts
      const bc = (params.browser_config as { params?: Record<string, unknown> } | undefined) ?? {};
      const bcParams = bc.params ?? {};
      ```
      Given an unwrapped `browser_config: { headless: false }`, `bc.params` is `undefined`, so `bcParams` is `{}`, and lines 222-245 rebuild a wrapped config from defaults. The caller's `headless: false` is **silently dropped** with no error.
  - Reproduction steps:
    1. Run the pinned Crawl4AI image locally (`services/crawl4ai/Dockerfile`, `FROM unclecode/crawl4ai:0.9.1`) and point `CRAWL4AI_URL` at it.
    2. Run `web-tools crawl --screenshot https://example.com`. The CLI sends a flat `crawler_config`; observe the Crawl4AI container log emit `POST http://127.0.0.1:11235/crawl "HTTP/1.1 400 Bad Request"`, and observe the CLI surface only a generic Crawl4AI error with no validation detail.
    3. Run `web_fetch` against the same URL. It sends the wrapped shape and succeeds. The only difference between the two requests is the config envelope.
    4. `POST /api/v0/web_crawl` with `{"urls":["https://example.com"],"browser_config":{"headless":false}}`. Observe that the crawl runs headless anyway, because the unwrapped key was discarded rather than rejected.
  - Scope:
    - First, **empirically confirm the exact request shape the pinned `unclecode/crawl4ai:0.9.1` MCP `crawl` tool accepts** for `browser_config` and `crawler_config`, by sending both envelopes against a local instance and recording which are accepted and which return 400. Record the finding in the story's spec; do not assume the wrapped form is correct merely because `web_fetch` uses it. If running the image locally is not possible in the implementer's environment, fall back to reading the pinned image's own server source for the `/crawl` request model and the MCP-to-REST bridge, and say in the spec which method was used.
    - Introduce a test runner for the packages this story touches if none exists. At HEAD the repository has **no test framework, no `*.test.ts` files, and no `test` script** in the root `package.json`, `packages/toolkit/package.json`, or `packages/api/package.json`. Node's built-in `node:test` is sufficient and adds no dependency. Add a `test` script so the suite is runnable.
    - Introduce a single normalization helper in `packages/toolkit/src/crawl4ai.ts` that converts either accepted caller form (flat or wrapped) into the one shape Crawl4AI accepts, and route **every** Crawl4AI config payload through it.
    - Make `web_crawl` in `packages/toolkit/src/functions.ts` merge caller-supplied `browser_config` keys regardless of whether the caller wrapped them, so no caller key is silently dropped.
    - Make `packages/toolkit/src/schemas.ts` and the wire format agree. Whichever caller-facing shape is chosen, the published schema must describe it accurately, and both `web_fetch` and `web_crawl` must produce identical envelopes for equivalent input.
    - Keep the CLI's flag-to-config mapping working unchanged from the user's point of view.
  - Out of scope:
    - Adding Zod validation to the REST transport - tracked by `validate-tool-inputs-at-transport-boundary`, which depends on this story so it validates against the corrected shape.
    - Structured request logging and correlation ids - tracked by `request-correlation-logging`.
    - Any change to the Crawl4AI image or a fork of its MCP-to-REST bridge.
    - Crawl4AI HTTP 500 responses, which are content and anti-bot failures with a different signature.
  - Expected behavior after the fix: equivalent input through `web_fetch`, `web_crawl`, the REST route, and the CLI produces the **same** Crawl4AI request envelope. No Web Tools code path can emit a config shape that Crawl4AI rejects with a 400, and no caller-supplied config key is discarded without an error.
  - Acceptance criteria:
    - The shape accepted by the pinned `unclecode/crawl4ai:0.9.1` `crawl` tool is confirmed empirically for both `browser_config` and `crawler_config`, and the result is written down in the spec.
    - `web-tools crawl --screenshot <url>` completes successfully against a live Crawl4AI instance and produces zero `400 Bad Request` lines in the Crawl4AI container log.
    - `web_fetch` and `web_crawl` produce byte-identical `browser_config` and `crawler_config` envelopes for equivalent input, asserted by a test that captures the outgoing tool arguments.
    - A flat caller-supplied `crawler_config` (for example `{"css_selector":"main"}`) is normalized and reaches Crawl4AI in the accepted form, asserted against captured tool arguments.
    - A caller-supplied `browser_config` key is honored whether wrapped or unwrapped: `{"headless":false}` and `{"type":"BrowserConfig","params":{"headless":false}}` both result in `headless: false` in the outgoing payload.
    - The default stealth and proxy `browser_config` behavior is preserved when the caller supplies no `browser_config`.
    - `WebCrawlInput` in `packages/toolkit/src/schemas.ts` describes the shape callers are actually expected to send, with no key documented at a nesting level the implementation does not accept.
    - `pnpm build` and `pnpm typecheck` pass, and the new tests run via the toolkit `test` script and pass.
  - References:
    - `packages/toolkit/src/crawl4ai.ts` - MCP/SSE client and the `callCrawlTool` entry point
    - `packages/toolkit/src/functions.ts` - `web_fetch`, `web_crawl`, and `proxyCrawl4AI`
    - `packages/toolkit/src/schemas.ts` - `WebCrawlInput`
    - `packages/cli/src/commands/crawl.ts` - flat `crawler_config` construction
    - `services/crawl4ai/Dockerfile` - the pinned Crawl4AI image
    - [`../ARCHITECTURE.md`](../ARCHITECTURE.md) - "Provider protocol changes should be absorbed here"; Crawl4AI protocol is encapsulated by the toolkit client
    - [`../PRODUCT.md`](../PRODUCT.md) - Principle 1 "One contract, multiple interfaces"; Phase 1 exit condition on crawl and fetch failure classification
