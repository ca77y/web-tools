---
type: story
title: Distinguish search provider failure from genuine empty results
---

# Distinguish search provider failure from genuine empty results

- [x] Distinguish search provider failure from genuine empty results #bug 🔺 🆔 distinguish-search-failure-from-empty-results
  - Phase: Phase 1 - Reliable Core
  - **Problem**: `web_search` returns an empty array both when SearXNG legitimately has no matches and when every SearXNG request fails. A total search outage is indistinguishable from a valid zero-match search. This contradicts [`../PRODUCT.md`](../PRODUCT.md) principle 2 ("Failures are data, not empty arrays"), the product promise that failures must not "masquerade as empty success", and [`../ARCHITECTURE.md`](../ARCHITECTURE.md) which states SearXNG-facing code "is responsible for distinguishing valid no-result responses from upstream failure".
  - **Evidence (verified against `packages/toolkit/src/searxng.ts` at commit `04c4e1a`)**:
    - `fetchSearXNG` collapses five distinct outcomes into a single `null` return:
      - Line 39-42: non-2xx HTTP response -> `log(...); return null`
      - Line 44-51: `response.json()` succeeds but `valid.length === 0` -> `return null`. This is the critical conflation: **a successful upstream response with zero matches is reported the same way as a hard failure.**
      - Line 58-61: `catch` block swallows JSON parse errors, network/fetch failures, and `AbortSignal.timeout` aborts -> `return null`
    - `searchSearXNG` (line 65-115) fires `Config.parallelRequests` (3, `config.ts:36`) concurrent requests with `Config.requestTimeout` of 15s (`config.ts:37`), skips every `null` (line 84), then at line 95-97 falls back to an empty array when all attempts produced `null`:
      ```ts
      if (rawResults.length === 0) {
        rawResults = bestNoContent ?? [];
      }
      ```
      and returns `{ data }` at line 114 with `data` empty.
    - `raceAll` (line 118-145) additionally maps any promise rejection to `null` at line 136-140, reinforcing the same collapse.
    - `web_search` in `packages/toolkit/src/functions.ts:103-114` returns `results.data` unchanged, so the empty array reaches every transport as a success.
  - **Observed production behavior** (Railway `Agentic-Search` production, 2026-07-17 to 2026-07-18 UTC): search providers were broadly blocked on the egress path, producing 403s, CAPTCHAs, rate limits, and timeouts across Wikidata, Mojeek, Qwant, Brave, Google CSE, Startpage, DuckDuckGo, and Wikipedia. Callers received successful empty results throughout. The only trace was stderr lines of the form:
    ```
    SearXNG attempt 1: HTTP 429
    SearXNG attempt 2 failed: The operation was aborted due to timeout
    SearXNG attempt 3: 0 valid results
    ```
    These are unstructured stderr writes (`searxng.ts:14-18`) with no query, request ID, or outcome classification, so failures could not be attributed to a specific search after the fact.
  - **Reproduction**:
    1. Point `SEARXNG_URL` at an unreachable host (or a stub returning HTTP 503). Call `web_search` with any query. Observe the result is `[]` with no error indicator.
    2. Point `SEARXNG_URL` at a stub returning HTTP 200 with body `{"results": []}`. Call `web_search` with the same query. Observe the result is also `[]`.
    3. The two responses are byte-identical; a caller cannot tell an outage from a genuine no-match.
  - **Expected behavior**: a total failure of all parallel attempts surfaces as an actionable error naming the failed operation and the upstream cause. A genuine zero-match response from a healthy SearXNG returns an empty array as a success.
  - Scope:
    - Replace the `null` return of `fetchSearXNG` with a discriminated outcome that separates: `ok` (>=1 valid result), `empty` (HTTP 200, well-formed JSON, zero valid results), and `failed` (non-2xx, JSON parse error, network error, timeout abort) carrying a safe reason and, where available, the upstream HTTP status.
    - Change `searchSearXNG` so that when **every** attempt is `failed` it throws a typed error rather than returning `{ data: [] }`; when at least one attempt is `empty` and none produced results, it returns an empty array as a legitimate success.
    - Preserve the existing "first response with content wins, else first response with any results" selection behavior for the success path.
    - Best-effort (covered by its own acceptance criterion below): where SearXNG's JSON response exposes an `unresponsive_engines` field, use it to distinguish "SearXNG answered but every engine failed" from a genuine no-match, and treat the former as a failure. Verify the field is present on the deployed image (`services/searxng/Dockerfile` tracks `searxng/searxng:latest`) before depending on it; if it is absent, fall back to the `ok`/`empty`/`failed` classification above and record that in the code comment.
    - Log one structured outcome line per attempt including the attempt number, classification, and safe upstream reason. Do not log API keys or full secrets.
    - Add regression tests covering each classification and the all-failed case.
    - Out of scope: reducing the 3x parallel request multiplier or engine retry/suspension tuning; the SearXNG client timeout budget; SearXNG engine and proxy configuration; the shallow `GET /health` check; Crawl4AI failure classification; any change to the nine-tool registry in `packages/toolkit/src/tools.ts`.
  - **Coordination — other stories edit the same file.** No duplication (each of the cards below explicitly puts the failure-vs-empty contract out of its own scope, and this card owns it), but merge collisions are likely if they run concurrently:
    - [`search-client-fanout-and-timeout-budget.md`](./search-client-fanout-and-timeout-budget.md) rewrites `fetchSearXNG`/`searchSearXNG` and removes or replaces `raceAll`. Sequence this story against it; the outcome classification introduced here must survive that rewrite.
    - [`request-correlation-logging.md`](./request-correlation-logging.md) redesigns the `searxng.ts` log lines. The structured log requirement in this card must adopt that story's log shape if it lands first, rather than inventing a second format.
  - **Transport contract impact** (verified; no transport code changes are expected, confirm each):
    - MCP (`packages/api/src/mcp.ts:39-45`): a thrown error is caught and returned as `{ content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true }`. This matches how Crawl4AI-backed tools already report failure.
    - REST (`packages/api/src/handler.ts:14-17`): a thrown error becomes HTTP 500 with `{ "error": message }`.
    - CLI (`packages/cli/src/index.ts:22-25`): `parseAsync(...).catch(...)` prints `Error: <message>` and exits 1. The existing `results.length === 0` branch in `packages/cli/src/commands/search.ts` continues to print "No results found." only for genuine empty results.
    - The success-path shape of `web_search` (a bare `SearchResult[]`) is unchanged, so this is not a breaking change for callers that succeed. Error messages must stay free of provider protocol detail per [`../ARCHITECTURE.md`](../ARCHITECTURE.md) ("Do not expose raw provider responses unless the public contract deliberately requires them").
    - Note that MCP reports tool failures in-band with `isError: true` on a 200 JSON-RPC response by protocol design, so this story does not make `/mcp` failures visible to HTTP-status monitoring. See [`../issues/mcp-tool-errors-invisible-to-http-monitoring.md`](../issues/mcp-tool-errors-invisible-to-http-monitoring.md).
  - Acceptance criteria:
    - `fetchSearXNG` returns a discriminated outcome distinguishing `ok`, `empty`, and `failed` instead of `null`.
    - A SearXNG response of HTTP 200 with zero valid results is classified `empty`, not `failed`.
    - Non-2xx responses, JSON parse errors, network errors, and timeout aborts are each classified `failed` with a distinguishable safe reason.
    - When all parallel attempts are `failed`, `web_search` raises an actionable error instead of returning an empty array.
    - When at least one attempt is `empty` and no attempt returned results, `web_search` returns an empty array as a success.
    - An all-attempts-failed `web_search` over MCP returns `isError: true` with a message identifying the failed search operation.
    - An all-attempts-failed `web_search` over REST returns HTTP 500 with an `error` field.
    - An all-attempts-failed `web_search` through the CLI exits non-zero and prints the error, rather than printing "No results found."
    - A genuine empty result over MCP, REST, and CLI is still reported as a success with zero results.
    - Each attempt emits one structured log line carrying attempt number, classification, and safe upstream reason.
    - The `unresponsive_engines` field is either used to classify an all-engines-failed response as `failed`, or a code comment records that the deployed SearXNG image does not expose it. Either outcome satisfies this criterion.
    - Error messages contain no API key, secret, or raw upstream response body.
    - Regression tests cover all-failed, genuine-empty, partial-failure, and all-succeed cases.
    - `pnpm build` and `pnpm typecheck` pass.
  - References: `packages/toolkit/src/searxng.ts`, `packages/toolkit/src/functions.ts`, `packages/toolkit/src/config.ts`, `packages/api/src/mcp.ts`, `packages/api/src/handler.ts`, `packages/cli/src/commands/search.ts`, `packages/cli/src/index.ts`, `services/searxng/Dockerfile`, [`../PRODUCT.md`](../PRODUCT.md), [`../ARCHITECTURE.md`](../ARCHITECTURE.md), [`../issues/mcp-tool-errors-invisible-to-http-monitoring.md`](../issues/mcp-tool-errors-invisible-to-http-monitoring.md)
</content>
