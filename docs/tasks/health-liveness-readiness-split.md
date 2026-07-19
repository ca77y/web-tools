---
type: story
title: Split liveness from dependency readiness in health reporting
---

# Split liveness from dependency readiness in health reporting

- [ ] Split liveness from dependency readiness in health reporting #improvement ⏫ 🆔 health-liveness-readiness-split
    - Phase: Phase 3 - Operable Service
    - Problem: `GET /health` proves only that the Express process can answer an HTTP request. It reports green during a near-total upstream outage, so an operator (and Railway) cannot tell a healthy stack from one where every SearXNG call times out and Crawl4AI MCP calls fail. Observed in production on the `Agentic-Search` Railway project: the public `/health` endpoint returned HTTP 200 throughout an incident window in which all three application SearXNG requests timed out and multiple Crawl4AI MCP calls failed.
    - Current implementation, `packages/api/src/index.ts:113-115` (verbatim at HEAD):

        ```ts
        app.get('/health', (_req: Request, res: Response) => {
          res.json({ status: 'ok' });
        });
        ```

      Response body today:

        ```json
        {"status":"ok"}
        ```

      `/health` is exempt from the API-key middleware (`packages/api/src/index.ts:30-31`, `if (req.path === '/health') return next();`).
    - Critical constraint - do NOT make `/health` itself deep. The Railway service `Tools` (project `Agentic-Search`, environment `production`) has its platform **health check path configured as `/health`**. Railway uses that path both as a deploy gate and as an ongoing container check. If `/health` returned non-2xx whenever a dependency was down, then: (a) a SearXNG or Crawl4AI outage would kill and restart a perfectly healthy Tools container in a loop, and (b) every deploy would fail to go live during an upstream outage - exactly when shipping a fix matters most. Liveness must stay independent of dependency state. This is the standard liveness-vs-readiness split.
    - Scope:
        - Keep `GET /health` as a pure, dependency-free liveness probe that always returns 200 while the process is alive. Its body may gain a `service`/`uptime` field but MUST NOT gain dependency state and MUST NOT perform network I/O.
        - Add a separate dependency readiness endpoint at `GET /ready` that probes dependencies and reports per-dependency status plus an aggregate rollup of `ok` / `degraded` / `unhealthy`.
        - Probe SearXNG reachability with a cheap, bounded HTTP request to the configured `Config.searxng.url` (`packages/toolkit/src/config.ts:19-23`, default `http://searxng.railway.internal:8080`). A lightweight endpoint check is sufficient; do not run a real user query on every poll.
        - Probe Crawl4AI MCP connectivity by establishing/reusing the shared MCP client and issuing a cheap protocol call such as `tools/list`. The client already exists and is memoised at `packages/toolkit/src/crawl4ai.ts:5-44` (`getClient()`), and it already nulls itself out on transport error/close, so a readiness probe should reuse that machinery rather than adding a second connection path. Note: `getClient()` is **not currently exported** - `crawl4ai.ts:57-61` exports only `callCrawlTool`, `callMdTool`, `callScreenshotTool`, `callPdfTool`, and `callExecuteJsTool`. This story must add a small, purpose-named export (e.g. `probeCrawl4AI()`) from the toolkit rather than exporting the raw client, keeping provider details behind the client per `docs/PRODUCT.md` principle 3 ("Provider details stay behind clients").
        - Every probe must be individually bounded by an explicit timeout so the readiness endpoint cannot hang. `Config.requestTimeout` is `15` seconds (`packages/toolkit/src/config.ts:37`) - that is a per-search budget and is too long for a health probe; pick a short, explicit probe timeout (a few seconds) and treat timeout as a failed probe, not an error response.
        - Run the probes concurrently, and cache the result for a bounded TTL of **no more than 5 seconds** so that polling the endpoint cannot itself become a load amplifier against SearXNG and Crawl4AI.
        - `GET /ready` returns **HTTP 200 with the status document even when dependencies are unhealthy**, so that monitors read dependency state from the body rather than from the status code. This deliberately keeps the endpoint safe to point any tool at, and keeps degraded-state semantics out of status-code space where a future misconfiguration could wire it to a platform restart trigger. It must never be set as Railway's health check path.
        - Require authentication on `/ready`, using the existing API-key middleware (i.e. do NOT add it to the `/health` bypass at `packages/api/src/index.ts:30-31`). It exposes internal topology and dependency failure detail, so it follows `/stats`, not `/health`. The response must not leak the API key, proxy credentials, or upstream URLs containing credentials.
        - Update `docs/ARCHITECTURE.md` ("Health And Statistics" and the `packages/api` bullet list, which currently documents only "Unauthenticated liveness response at `GET /health`") and the root `README.md` to describe both endpoints and state plainly what each does and does not prove.
    - Example target response shape for the readiness endpoint (illustrative, not binding):

        ```json
        {
          "status": "degraded",
          "checked_at": "2026-07-19T12:00:00.000Z",
          "dependencies": {
            "searxng":  { "status": "unhealthy", "latency_ms": 3001, "detail": "timeout" },
            "crawl4ai": { "status": "ok", "latency_ms": 42 }
          }
        }
        ```

    - Explicitly out of scope, with rationale:
        - **Redis connectivity.** Web Tools has no Redis client and no Redis configuration; Redis exists solely to support SearXNG (`docs/ARCHITECTURE.md`, "Redis": *"Redis supports the SearXNG service. Web Tools does not expose Redis as a public dependency or tool."*). Adding a Redis client to Tools purely for a health probe would violate that boundary. Redis failure is observable transitively through the SearXNG probe.
        - **Proxy connectivity / exit-IP health.** No meaningful check exists on our side; see [`../issues/proxy-exit-ip-health-unverifiable.md`](../issues/proxy-exit-ip-health-unverifiable.md).
        - **Crawl4AI browser readiness.** MCP connectivity does not prove a browser can launch. A cheap browser probe is conceivable (rendering `about:blank` or a `data:` URL launches a browser without external egress or billed proxy bandwidth), but it is slower and heavier than a protocol check. If the lead pursues it, it must be opt-in behind an explicit query parameter (e.g. `?deep=1`) and never run on the default polling path. Shipping without it is acceptable.
        - **Changing Crawl4AI's own `/health`.** Crawl4AI returning 200 while individual requests fail with input-specific 400/500s is correct behaviour, not a defect: per-request failures caused by a specific target URL are not service-health signals, and a health endpoint that went red on them would be unusable.
        - **Changing the Railway health check path away from `/health`.** Out of scope and undesirable.
        - **Standing up a test framework.** At HEAD this repository has no test infrastructure: no `test` script in the root or package `package.json` files, no test-runner dependency, and no `*.test.ts` / `*.spec.ts` files anywhere. `CLAUDE.md` requires tests "where test infrastructure exists", so this story is verified by the manual reproduction below plus `pnpm build` and `pnpm typecheck` (validation commands in `CLAUDE.md`). Choosing and wiring a test runner is a separate story; if one lands first, add the equivalent automated coverage here.
    - Manual reproduction / verification steps (runnable against a local Docker Compose stack):
        1. Bring the stack up, confirm `GET /health` returns 200 and `GET /ready` (with a valid API key) reports both dependencies healthy.
        2. Stop the SearXNG container. Confirm `GET /health` still returns 200 and `GET /ready` reports `searxng` unhealthy with the aggregate degraded or unhealthy.
        3. Restart SearXNG, then stop the Crawl4AI container. Confirm `GET /health` still returns 200 and `GET /ready` reports `crawl4ai` unhealthy.
        4. Confirm the process is never restarted by the platform in steps 2-3 - liveness is unaffected by dependency state.
        5. Simulate a hung dependency (e.g. block the port with a listener that never responds) and confirm `GET /ready` returns within the probe timeout bound rather than hanging.
        6. Poll `GET /ready` rapidly and confirm upstream request volume is bounded by the cache TTL, not by poll rate.
        7. Confirm `GET /ready` without an API key is rejected, and that no secret appears in any response body.
    - Acceptance criteria:
        - `GET /health` performs no network I/O and returns 200 whenever the process is alive, including when SearXNG and Crawl4AI are both unreachable.
        - A separate readiness endpoint exists and reports per-dependency status for SearXNG and Crawl4AI MCP connectivity, plus an aggregate rollup.
        - With SearXNG unreachable and the API process alive, `/health` returns 200 and the readiness endpoint reports SearXNG as unhealthy.
        - With Crawl4AI MCP unreachable, `/health` returns 200 and the readiness endpoint reports Crawl4AI as unhealthy.
        - With both dependencies reachable, the readiness endpoint reports an aggregate healthy status.
        - Each dependency probe is bounded by an explicit timeout, and a hung dependency yields a timeout verdict within that bound rather than hanging the response.
        - Probe results are cached with a TTL of no more than 5 seconds, so repeated polling within the TTL issues no additional upstream requests.
        - The readiness response never contains the API key, proxy credentials, or any secret.
        - `GET /ready` requires authentication and is rejected without a valid API key.
        - The manual reproduction steps above have been executed and each produced the stated result.
        - `docs/ARCHITECTURE.md` and `README.md` describe both endpoints and what each does and does not prove.
        - `pnpm build` and `pnpm typecheck` pass.
    - References: `packages/api/src/index.ts` (health route, auth middleware), `packages/toolkit/src/crawl4ai.ts` (shared MCP client), `packages/toolkit/src/searxng.ts` (SearXNG request path), `packages/toolkit/src/config.ts` (dependency URLs and timeout), [`../ARCHITECTURE.md`](../ARCHITECTURE.md), [`../PRODUCT.md`](../PRODUCT.md) (Phase 3 - Operable Service), [`../issues/proxy-exit-ip-health-unverifiable.md`](../issues/proxy-exit-ip-health-unverifiable.md), [`../issues/mcp-tool-errors-invisible-to-http-monitoring.md`](../issues/mcp-tool-errors-invisible-to-http-monitoring.md) (related: HTTP-status monitoring of `/mcp` also stays green during an outage - this story gives operators the dependency signal that transport-level monitoring cannot provide).
