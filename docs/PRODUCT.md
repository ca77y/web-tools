# Web Tools Product

## Purpose

Web Tools gives agents and developers one self-hostable system for common web-retrieval work: search, browser-grade extraction, screenshots, PDFs, JavaScript execution, multi-URL crawling, and historical retrieval. MCP and REST expose the complete registry; CLI commands invoke the same toolkit directly for the operational tools they expose.

## Problem

Web-capable agents otherwise depend on a patchwork of hosted search APIs, browser automation, scraping code, and archival services. Those integrations differ in authentication, request schemas, output shape, failure handling, and deployment model. They are difficult to operate privately and easy for separate interfaces to implement inconsistently.

Web Tools addresses that problem by owning a small, explicit tool contract and adapting a focused provider stack behind it:

- SearXNG for metasearch
- Crawl4AI for browser extraction and generated artifacts
- Wayback Machine APIs for historical discovery and retrieval
- Redis for SearXNG runtime support

## Users

The current interfaces serve three practical roles:

- Agent operators connecting an MCP client to a private web capability
- Developers integrating the same tools over REST or directly through the toolkit package
- Self-hosting operators deploying and diagnosing the four-service stack

These roles are inferred from the shipped interfaces and deployment material. They are working product assumptions, not validated market segmentation.

## Product Promise

Web Tools should make a web operation:

- **Consistent**: an operation behaves the same through every interface that exposes it.
- **Actionable**: failures identify the failed operation and preserve safe upstream context instead of masquerading as empty success.
- **Self-hostable**: operators control the service boundary, API key, provider configuration, and deployment.
- **Composable**: normalized responses are useful to agents and programs without exposing incidental provider protocol details.
- **Observable**: operators can distinguish application health, provider failure, traffic, and process-local resource usage.

## Product Boundary

Web Tools is:

- A framework-agnostic TypeScript toolkit and a set of transport adapters
- An integration layer over search, browser extraction, and web archives
- A self-hosted service with API-key protection for non-health routes
- A focused utility for retrieval and capture, not a general agent runtime

Web Tools is not:

- A search engine, browser engine, or archive of record
- A durable billing, analytics, or usage-ledger platform
- A credential vault or identity provider
- A workflow orchestrator, autonomous research product, or content-management system
- A guarantee that arbitrary third-party websites can be fetched or rendered successfully

## Principles

1. **One contract, multiple interfaces.** Tool schemas and implementations live in the toolkit; transports adapt them.
2. **Failures are data, not empty arrays.** Provider and transport failures remain distinguishable from valid no-result responses.
3. **Provider details stay behind clients.** Public contracts expose intentional fields, not accidental upstream response shapes.
4. **Safe defaults beat maximum configurability.** Advanced browser options remain available where needed, but common operations have bounded defaults.
5. **Operational truth is explicit.** Health, logs, errors, and statistics state what they do and do not prove.
6. **The deployment stays understandable.** New capabilities should not add a service unless the boundary is necessary.

## Current Capabilities

The authoritative registry in `packages/toolkit/src/tools.ts` currently defines nine tools:

- `web_search`
- `web_fetch`
- `web_screenshot`
- `web_pdf`
- `web_execute_js`
- `web_crawl`
- `web_snapshots`
- `web_archive`
- `web_usage_stats`

MCP and REST expose the full registry through the API package. The CLI consumes the toolkit directly and currently exposes the eight operational tools, but not `web_usage_stats`. Usage statistics are process-local and reset whenever the process restarts.

## Delivery Phases

The phases describe delivery order, not release dates. A story may cite one phase using the format defined in [`tasks/CLAUDE.md`](./tasks/CLAUDE.md).

### Phase 1 - Reliable Core

Make every existing tool fail predictably and distinguish legitimate empty results from provider, proxy, timeout, cancellation, and content-classification failures.

Exit conditions:

- Search retry and deduplication behavior is bounded and testable.
- Crawl and fetch correctly classify upstream status, downloads, binary content, and browser failures.
- MCP and REST preserve actionable errors.
- Known production failure modes in [`../PROBLEMS.md`](../PROBLEMS.md) have a disposition and regression coverage where practical.

### Phase 2 - Contract Consistency

Make the tool registry, schemas, response contracts, documentation, and all three interfaces agree.

Exit conditions:

- Each registered tool has a documented stable input and output contract.
- MCP, REST, and CLI exercise the same toolkit implementation.
- Public documentation accurately lists all supported tools and material limitations.
- Contract tests cover interface-level validation and error mapping.

### Phase 3 - Operable Service

Give self-hosting operators enough evidence to deploy, monitor, and diagnose the service without treating process-local counters as durable telemetry.

Exit conditions:

- Health semantics distinguish liveness from any documented dependency readiness checks.
- Logs identify operation, provider, duration, outcome, and safe error context.
- Deployment guidance covers configuration, service dependencies, and common recovery paths.
- Metrics and usage-statistics limitations are explicit.

### Phase 4 - Deliberate Expansion

Add providers or tools only in response to a demonstrated job that the existing contract cannot satisfy.

Entry conditions:

- Phases 1 through 3 have no unresolved foundational blocker.
- The new capability has a defined user, contract, provider boundary, operating cost, and failure model.
- The capability fits the retrieval-and-capture product boundary.

## Success Signals

Until product analytics are introduced, success is evaluated through engineering and operator evidence:

- Existing tools complete reliably under their documented constraints.
- The same request has equivalent behavior across supported interfaces.
- Production failures are attributable to a specific layer and are reproducible.
- Operators can deploy and recover the stack from maintained documentation.
- New tools do not duplicate existing capabilities or leak provider-specific contracts.
