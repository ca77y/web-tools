# Distinguish search provider failure from genuine empty results

- **Status**: Draft
- **Task**: distinguish-search-failure-from-empty-results
- **Last Updated**: 2026-07-19
- **Document Scope**: One unit of work: classify each SearXNG attempt outcome in the toolkit search client so a total upstream failure raises an actionable error instead of returning an empty success.

---

## Goal

`web_search` returns `[]` both when SearXNG legitimately matches nothing and when every SearXNG attempt fails. `fetchSearXNG` collapses non-2xx responses, JSON parse errors, network errors, timeout aborts, and successful zero-result responses into a single `null`; `searchSearXNG` then falls back to `rawResults = bestNoContent ?? []` and returns `{ data: [] }` as a success. A total search outage is byte-identical to a valid no-match.

This violates `docs/PRODUCT.md` principle 2 ("Failures are data, not empty arrays"), `docs/ARCHITECTURE.md` (SearXNG-facing code "is responsible for distinguishing valid no-result responses from upstream failure"), and `packages/AGENTS.md` ("Do not turn provider failures into successful empty results").

**Change**: replace the nullable return of `fetchSearXNG` with a discriminated outcome (`ok` / `empty` / `failed`), and make `searchSearXNG` throw a typed error when every attempt is `failed` while still returning an empty array when at least one attempt genuinely answered with zero results.

**User value**: a caller — MCP client, REST consumer, or CLI user — can tell "the web has nothing for this query" from "our search provider is down", and gets an actionable reason for the latter. Production evidence (Railway `Agentic-Search`, 2026-07-17/18) showed a multi-day provider blockage during which every caller received successful empty results.

**Non-goals** (explicitly out of scope):

- Reducing the `Config.parallelRequests` multiplier of 3, or any retry/suspension tuning.
- Changing `Config.requestTimeout` or the client timeout budget.
- SearXNG engine or proxy configuration (`services/searxng/settings.yml`).
- The shallow `GET /health` check.
- Crawl4AI failure classification.
- Any change to the nine-tool registry in `packages/toolkit/src/tools.ts`, including the `web_search` input schema.
- Any change to the **success-path** response shape of `web_search` (a bare `SearchResult[]`).

## Design

### Boundary

All changes to production behavior are confined to `packages/toolkit/src/searxng.ts`, plus a type/error export surfaced through the toolkit's existing entry point. The **production source** of `packages/api` and `packages/cli` must not be modified: they are transport adapters and already propagate thrown errors correctly (verified below). MCP and REST continue to share the same handler path.

Adding *test* files and a `test` script to `packages/api` and `packages/cli` is in scope and expected — that is where the transport scenarios below are executed. Extending test infrastructure into a package is not "modifying the adapter"; changing its runtime behavior is.

### Outcome classification

`fetchSearXNG` returns a discriminated union instead of `... | null`:

- `{ kind: 'ok', results, hasContent }` — HTTP 2xx, well-formed JSON, at least one valid result (a result with both `title` and `url`).
- `{ kind: 'empty' }` — HTTP 2xx, well-formed JSON, zero valid results, and SearXNG did not report a total engine failure.
- `{ kind: 'failed', reason }` — any of: non-2xx HTTP status; response body that is not valid JSON; JSON that does not match the expected shape (e.g. `results` absent or not an array); network/fetch error; `AbortSignal.timeout` abort.

`reason` is a **safe, structured** value carrying a machine-readable cause plus, where available, the upstream HTTP status. It must never carry an API key, a secret, or a raw upstream response body. Distinguishable causes are required: at minimum `http_status`, `invalid_response`, `timeout`, and `network_error`.

Distinguishing a timeout from a generic network error: `AbortSignal.timeout` rejects with a `DOMException` whose `name` is `TimeoutError`. Classify on `err.name`, not on message text.

### `unresponsive_engines` (best-effort, its own acceptance criterion)

SearXNG's JSON response format may expose `unresponsive_engines`. When present and non-empty on a response that produced **zero** valid results, that response means "SearXNG answered but every engine that ran failed" — classify it `failed`, not `empty`, with a reason naming the condition (engine names may be included; engine error strings are upstream protocol detail and must be summarized, not pasted).

**The coder must verify** whether the deployed image (`services/searxng/Dockerfile`, tracking `searxng/searxng:latest`) actually exposes this field before depending on it — by consulting the SearXNG JSON API for the tracked version, not by assumption. Both outcomes satisfy the story:

- Present: implement the classification above, and record in a code comment how presence was verified.
- Absent: fall back to the plain `ok`/`empty`/`failed` classification and record in a code comment that the deployed image does not expose the field, with the evidence.

Parse the field defensively — treat a missing or malformed `unresponsive_engines` as "not reported" rather than an error, so its absence never turns a genuine `empty` into a `failed`.

#### When no explicit engine list was requested

`SEARXNG_ENGINES` is **optional and blank in the default deployment** (`config.ts`, `.env.example`, `README.md`), and the `engines` tool argument is optional, so the common production case requests no explicit engine list. SearXNG's JSON response carries no field enumerating the full engine roster that ran, only `unresponsive_engines`.

Restricting the `failed` classification to "every engine in the explicitly-requested list is unresponsive" therefore makes the detection **unreachable in the default deployment** — which is precisely the configuration of the Railway incident this story exists to fix. That is not acceptable: it satisfies the letter of the acceptance criterion while missing the motivating scenario.

Required behavior when **no** explicit engine list was requested: a response with HTTP 2xx, **zero** valid results, and a **non-empty** `unresponsive_engines` is classified `failed`.

This is a deliberate, documented trade-off. The ambiguous case is a genuine no-match where one engine happened to be unresponsive while others answered normally with zero results — that will now be reported as a failure rather than an empty success. We accept that direction of error because:

- Zero results means no engine produced positive evidence the search actually worked, while a non-empty `unresponsive_engines` is concrete evidence that something did break.
- `docs/PRODUCT.md` principle 2 makes a failure reported as empty success the more damaging error; a failure surfaced on an ambiguous no-match is recoverable and visible, whereas a silent empty is neither.

Record this trade-off and its reasoning in a code comment so a future reader does not "simplify" it back. When an explicit engine list **is** requested, keep the existing, more precise "every requested engine is unresponsive" rule.

### Aggregation in `searchSearXNG`

Consume outcomes in resolution order, preserving the **existing selection behavior**: the first `ok` outcome with content wins and short-circuits; otherwise the first `ok` outcome with any results is used. Dedup-by-URL and `limit` truncation are unchanged.

When no `ok` outcome was observed after all attempts settle:

- If at least one outcome was `empty` → return `{ data: [] }` as a legitimate success.
- If **every** outcome was `failed` → throw a typed error.

The typed error is a named `Error` subclass exported from the toolkit so callers can discriminate it. Its `message` must be actionable and must name the failed operation and summarize the distinct upstream causes across attempts — for example, naming the SearXNG search operation and the set of observed causes with counts. It must contain no API key, no secret, and no raw upstream response body. Attach the per-attempt safe reasons as a structured property on the error for programmatic use.

`raceAll` currently maps a promise rejection to `null as T`, which reinforces the collapse. Since `fetchSearXNG` catches its own errors, a rejection is not expected; `raceAll` must nonetheless map any rejection to a `failed` outcome rather than to `null`, so an unexpected throw can never be silently counted as a non-failure. `raceAll`'s generic signature may be narrowed or specialized to make this type-safe.

Note for the coder: the existing early `break` on the first content-bearing result is correct and must be preserved — it only fires on a success, and the all-failed determination is only needed when no success occurred, at which point the loop has consumed every outcome.

### Structured logging

Replace the current free-text stderr writes with **one structured line per attempt**, emitted through the existing stderr `log` helper, carrying at least: the attempt number, the classification (`ok` / `empty` / `failed`), and the safe upstream reason (for `failed`) or result counts (for `ok`). Emit it as a single-line JSON object so the line is machine-parseable, and include a stable event name identifying it as a SearXNG attempt outcome.

The sibling story `docs/tasks/request-correlation-logging.md` will redesign these log lines and introduce a request ID; it has **not** landed. Do not invent a correlation-ID mechanism here — emit the per-attempt outcome line in the shape above and leave room for that story to add correlation fields.

### Transport contract (verify, do not change)

Each of these was verified against the current source and must be confirmed by test, not by editing transport code:

- MCP — `packages/api/src/mcp.ts:39-45` catches a thrown error and returns `{ content: [{ type: 'text', text: JSON.stringify({ error: message }) }], isError: true }`.
- REST — `packages/api/src/handler.ts:14-17` turns a thrown error into HTTP 500 with `{ "error": message }`.
- CLI — `packages/cli/src/index.ts:22-25` catches via `parseAsync(...).catch(...)`, prints `Error: <message>`, exits 1. The `results.length === 0` branch in `packages/cli/src/commands/search.ts` must keep printing "No results found." for genuine empty results only.

Per `docs/ARCHITECTURE.md`, error messages must not expose raw provider responses.

### Test infrastructure

**The repository currently has no test runner, no test script, and no test files.** This unit introduces the minimum viable one:

- Use the Node.js 22 built-in `node:test` runner and `node:assert/strict`. **Do not add any new runtime or dev dependency** — the repo's toolchain is deliberately `typescript` + `prettier` only.
- Write tests in TypeScript alongside the source (e.g. `packages/toolkit/src/searxng.test.ts`), compiled by each package's existing `tsc` build, and execute the compiled output with `node --test`.
- Add a `test` script to `packages/toolkit/package.json`, and also to `packages/api/package.json` and `packages/cli/package.json` for the transport scenarios, plus a root `test` script that runs them, following the existing script conventions (root scripts delegate via `pnpm --filter`).
- The transport scenarios are executed against the real adapter code with the toolkit's `web_search` stubbed (or its underlying `fetch` stubbed) to force the total-failure and genuine-empty cases: call the MCP tool registration and the REST `toolHandler` directly, and exercise the CLI command via its exported registration rather than by spawning a process, asserting the documented failure and empty behavior. If a scenario genuinely cannot be executed against a given adapter without changing its production source, say so explicitly in your report rather than silently downgrading it to inspection.
- Ensure the compiled test files do not break the package's public entry point — `packages/toolkit/src/index.ts` must not export test modules.

Tests stub `globalThis.fetch` to simulate upstream behavior, restoring the original in teardown. This requires **no production seam or dependency injection** — do not add a fetch-injection parameter to `fetchSearXNG` or `searchSearXNG` purely for testability.

Because the parallel attempt count is `Config.parallelRequests` (3), a stub must be able to serve a different outcome per attempt in order to exercise partial failure.

## Requirements

### Requirement: Per-attempt outcome classification

#### Scenario: Successful response with results

- **WHEN** SearXNG returns HTTP 200 with well-formed JSON containing at least one result having both `title` and `url`
- **THEN** the attempt is classified `ok` and carries the valid results and whether any of them has non-empty `content`

#### Scenario: Genuine empty result

- **WHEN** SearXNG returns HTTP 200 with well-formed JSON whose `results` array is empty, or contains only entries missing `title` or `url`, and no total engine failure is reported
- **THEN** the attempt is classified `empty`, not `failed`

#### Scenario: Non-2xx upstream status

- **WHEN** SearXNG returns a non-2xx HTTP response such as 429 or 503
- **THEN** the attempt is classified `failed` with a reason identifying an HTTP status cause and carrying that status code

#### Scenario: Unparseable response body

- **WHEN** the SearXNG response body is not valid JSON
- **THEN** the attempt is classified `failed` with a reason distinguishable from an HTTP-status failure

#### Scenario: Well-formed JSON of an unexpected shape

- **WHEN** the SearXNG response is HTTP 200 with valid JSON whose `results` field is absent or is not an array
- **THEN** the attempt is classified `failed`, not `empty`

#### Scenario: Network error

- **WHEN** the underlying `fetch` rejects with a network error
- **THEN** the attempt is classified `failed` with a reason distinguishable from a timeout

#### Scenario: Timeout abort

- **WHEN** the request exceeds the configured timeout and `AbortSignal.timeout` aborts it
- **THEN** the attempt is classified `failed` with a reason identifying a timeout, distinguishable from a generic network error

### Requirement: Total-failure error propagation

#### Scenario: Every attempt fails

- **WHEN** `web_search` runs and every parallel SearXNG attempt is classified `failed`
- **THEN** it raises the toolkit's typed search-provider error rather than returning an array, the error message names the failed search operation and summarizes the observed upstream causes, and the error exposes the per-attempt safe reasons as a structured property for programmatic use

#### Scenario: All attempts empty

- **WHEN** every attempt is classified `empty`
- **THEN** `web_search` resolves successfully with an empty array and raises no error

#### Scenario: Mixed empty and failed

- **WHEN** at least one attempt is `empty`, no attempt is `ok`, and the remaining attempts are `failed`
- **THEN** `web_search` resolves successfully with an empty array

#### Scenario: Partial failure with one success

- **WHEN** some attempts are `failed` and at least one attempt is `ok`
- **THEN** `web_search` resolves successfully with the results from the `ok` attempt and raises no error

#### Scenario: Existing selection behavior preserved

- **WHEN** one `ok` attempt has results with content and another `ok` attempt has results without content
- **THEN** the results from the content-bearing attempt are returned, and when no attempt has content the first attempt with any results is returned

#### Scenario: Deduplication and limit unchanged

- **WHEN** the winning attempt returns duplicate URLs or more results than the requested `limit`
- **THEN** results are deduplicated by URL and truncated to `limit`, exactly as before this change

### Requirement: Safe error content

#### Scenario: No secrets or raw bodies in the error

- **WHEN** a total-failure error is raised after upstream responses containing body text
- **THEN** the error message contains no API key, no secret, and no raw upstream response body

### Requirement: Transport reporting

#### Scenario: Total failure over MCP

- **WHEN** an all-attempts-failed `web_search` is invoked through the MCP tool path
- **THEN** the response has `isError: true` and its text payload carries an `error` message identifying the failed search operation

#### Scenario: Total failure over REST

- **WHEN** an all-attempts-failed `web_search` is invoked through the REST tool handler
- **THEN** the response is HTTP 500 with an `error` field carrying the message

#### Scenario: Total failure through the CLI

- **WHEN** an all-attempts-failed `web_search` is invoked through the CLI `search` command
- **THEN** the CLI exits non-zero and prints the error, and does not print "No results found."

#### Scenario: Genuine empty across transports

- **WHEN** a genuine empty result is returned through MCP, REST, and the CLI
- **THEN** each reports success with zero results — MCP without `isError`, REST with HTTP 200 and an empty array, and the CLI printing "No results found." and exiting zero

### Requirement: Structured per-attempt logging

#### Scenario: One outcome line per attempt

- **WHEN** any attempt completes with any classification
- **THEN** exactly one structured single-line JSON record is written to stderr for that attempt, carrying a stable event name identifying it as a SearXNG attempt outcome, the attempt number, the classification, and the safe upstream reason or result counts

#### Scenario: Logs carry no secrets

- **WHEN** attempt outcome lines are emitted
- **THEN** no line contains an API key, a secret, or a raw upstream response body

### Requirement: All-engines-failed detection

#### Scenario: SearXNG reports every engine unresponsive

- **WHEN** SearXNG returns HTTP 200 with zero valid results and reports every engine as unresponsive via `unresponsive_engines`, **and** the deployed image exposes that field
- **THEN** the attempt is classified `failed` rather than `empty`

#### Scenario: Every engine unresponsive with no explicit engine list requested

- **WHEN** no explicit engine list was requested (neither the `engines` argument nor `SEARXNG_ENGINES` is set) and SearXNG returns HTTP 200 with zero valid results and a non-empty `unresponsive_engines`
- **THEN** the attempt is classified `failed`, so the default-deployment outage case is detected rather than reported as an empty success

#### Scenario: Partial engine failure with an explicit engine list

- **WHEN** an explicit engine list is requested, SearXNG returns HTTP 200 with zero valid results, and only some of the requested engines appear in `unresponsive_engines`
- **THEN** the attempt is classified `empty`, because the engines that did run genuinely found nothing

#### Scenario: Field unavailable or unreported

- **WHEN** the deployed SearXNG image does not expose `unresponsive_engines`, or the field is absent or malformed on a given response
- **THEN** classification falls back to `ok`/`empty`/`failed` without error, and a code comment records the verification result and its evidence

### Requirement: Validation

#### Scenario: Repository checks pass

- **WHEN** `pnpm build` and `pnpm typecheck` are run at the repository root
- **THEN** both succeed with no new errors or warnings, and the new test script passes

## Tasks

- [ ] Verify whether the tracked `searxng/searxng:latest` JSON response exposes `unresponsive_engines`; record the finding and its evidence as a code comment.
- [ ] Introduce the discriminated attempt-outcome type and the exported typed search-provider error in `packages/toolkit/src/searxng.ts`, exported through the toolkit entry point.
- [ ] Rewrite `fetchSearXNG` to return the outcome union, classifying non-2xx, invalid JSON, unexpected shape, network error, and timeout abort as `failed` with distinguishable safe reasons, and HTTP 200 with zero valid results as `empty`.
- [ ] Apply the `unresponsive_engines` classification if the field is available.
- [ ] Replace the free-text stderr writes with one structured single-line JSON outcome record per attempt.
- [ ] Update `raceAll` so a rejection maps to a `failed` outcome instead of `null`.
- [ ] Rewrite the aggregation in `searchSearXNG` to preserve the existing selection behavior, return an empty array when any attempt is `empty` and none is `ok`, and throw the typed error when every attempt is `failed`.
- [ ] Add the `node:test` infrastructure: a `test` script in `packages/toolkit/package.json`, a delegating root `test` script, and no new dependencies.
- [ ] Add regression tests covering every scenario above, including all-failed, genuine-empty, partial-failure, and all-succeed.
- [ ] Confirm — without editing transport code — that MCP, REST, and CLI report total failure and genuine empty correctly.
- [ ] Run `pnpm build`, `pnpm typecheck`, and the new test script.
