# Crawl4AI's MCP endpoint is unreachable from the local Compose stack

**Status:** open — root cause observed directly in the container's own startup logs while running the story's manual reproduction against the local Compose stack; no fix identified on our side
**First recorded:** 2026-07-21
**Component:** `docker-compose.yml` (the `crawl4ai` service) and `packages/toolkit/src/crawl4ai.ts` (the MCP/SSE client)

## Problem

Web Tools reaches Crawl4AI over MCP/SSE — `packages/toolkit/src/crawl4ai.ts:23` builds `new URL('/mcp/sse', Config.crawl4ai.url)` from `packages/toolkit/src/config.ts:8,24-25`, and `docker-compose.yml:33` sets `CRAWL4AI_URL=http://crawl4ai:11235`. From another container on the Compose network, that MCP endpoint cannot be reached at all.

`docker-compose.yml:19` pins the `crawl4ai` service to `unclecode/crawl4ai:latest`, which currently resolves to 0.9.2. Running that service and reading its startup output showed, verbatim:

```text
MCP server running on 127.0.0.1:11235
```

Two things follow, and either alone is sufficient to block the connection:

1. **MCP is bound to container-loopback.** `127.0.0.1` inside the container is not reachable from the `web_tools` container, regardless of the published port mapping at `docker-compose.yml:20-21`, so no MCP/SSE connect from another service can succeed.
2. **The MCP endpoint requires a token the container generates at startup.** It is not derivable from repository configuration. `docker-compose.yml:22-23` passes only `CRAWL4AI_API_TOKEN` from the environment, which is unset by default and is not the generated value.

Crawl4AI's REST surface on the same port is reachable; only the MCP endpoint is affected.

## Impact

Anything that depends on real Crawl4AI MCP connectivity in the local stack cannot be exercised there. Concretely, the manual reproduction steps on the `health-liveness-readiness-split` story — bring the Compose stack up and confirm `GET /ready` reports `crawl4ai` healthy, then stop the container and confirm it reports unhealthy — cannot distinguish "Crawl4AI is down" from "Crawl4AI's MCP endpoint was never reachable from this stack". A reader re-running those steps will see `crawl4ai` reported `unhealthy` on a stack where every container is running, and should read that as this issue rather than as a readiness-probe defect.

The same limitation means the local stack cannot be used to exercise the upstream SSE hazards recorded in [`eventsource-refused-connection-reconnect-leak.md`](./eventsource-refused-connection-reconnect-leak.md) against a real Crawl4AI. Those are covered instead by in-process fake MCP servers in the automated suite.

## Why no fix could be identified on our side

The bind address and the startup-generated token are decisions made inside third-party image code. Nothing in this repository configures either. The available levers are all uncertain or out of scope here:

- **Changing the image the Compose stack runs** is owned by the separate story [`../tasks/align-compose-stack-with-deployed-images.md`](../tasks/align-compose-stack-with-deployed-images.md), which points `crawl4ai` at the repository's own `services/crawl4ai/Dockerfile` (pinned `FROM unclecode/crawl4ai:0.9.1`) instead of the unpinned upstream `:latest`. **Whether 0.9.1 binds MCP differently, or requires the same startup token, has not been verified.** That story fixes an unrelated Playwright browser-path defect and does not claim to fix this one, so pinning it may or may not resolve this — it is the first thing to test, not a known remedy.
- **Overriding the bind address or supplying the token from Compose** would require an upstream-supported configuration surface for both. None was identified.

Because both remaining paths depend on facts not established from this repository, no change is proposed here.

## What would unblock this

1. Land [`../tasks/align-compose-stack-with-deployed-images.md`](../tasks/align-compose-stack-with-deployed-images.md) so the Compose stack runs the repository's pinned Crawl4AI image.
2. Re-read that container's startup log for the MCP bind address, and check whether it still prints a loopback bind and still demands a generated token.
3. If the bind is still loopback, raise a story for a supported way to configure it — or record that local MCP reproduction is not achievable and that the in-process fake MCP server in the test suite is the substitute.

This note should be closed or replaced with an implementation story at that point.

## References

- `docker-compose.yml:18-23` — the `crawl4ai` service (`image: unclecode/crawl4ai:latest`, the `11235:11235` port mapping, the `CRAWL4AI_API_TOKEN` passthrough); `:33` — `CRAWL4AI_URL=http://crawl4ai:11235`
- `services/crawl4ai/Dockerfile:14` — the repository's own image, pinned to `FROM unclecode/crawl4ai:0.9.1`
- `packages/toolkit/src/crawl4ai.ts:23` — the `/mcp/sse` URL the client builds; `packages/toolkit/src/config.ts:8,24-25` — the `CRAWL4AI_URL` default and binding
- [`../tasks/align-compose-stack-with-deployed-images.md`](../tasks/align-compose-stack-with-deployed-images.md) — the story that owns `docker-compose.yml`
- [`eventsource-refused-connection-reconnect-leak.md`](./eventsource-refused-connection-reconnect-leak.md) — the probe hazards this stack cannot currently reproduce
- [`../ARCHITECTURE.md`](../ARCHITECTURE.md) — Health And Statistics, Deployment Model
