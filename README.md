# Web Tools

A self-hosted web toolkit providing nine tools for search, content extraction, archival, and lightweight usage inspection. Available as an [MCP](https://modelcontextprotocol.io/) server, REST API, and CLI — powered by [SearXNG](https://github.com/searxng/searxng), [Crawl4AI](https://github.com/unclecode/crawl4ai), and the [Wayback Machine](https://web.archive.org/).

## Architecture

```mermaid
graph LR
    MCP["MCP Client<br/>(Claude, Cursor, etc.)"] -->|POST /mcp| Server["Web Tools Server"]
    API["REST Client"] -->|POST /api/v0/*| Server
    CLI["CLI"] -->|direct call| Toolkit["@web-tools/toolkit"]
    Server --> Toolkit
    Toolkit --> SearXNG
    SearXNG --> Redis
    Toolkit --> Crawl4AI
    Toolkit --> Wayback["Wayback Machine"]
```

The project is structured as a **monorepo** with three packages:

- **`packages/toolkit`** — Core business logic: Zod schemas, tool definitions, SearXNG/Crawl4AI/Wayback clients. Framework-agnostic.
- **`packages/api`** — Express HTTP server exposing MCP (`POST /mcp`) and REST (`POST /api/v0/{tool_name}`) endpoints.
- **`packages/cli`** — Commander.js CLI for terminal usage.

The full stack deploys as **4 services**: Redis, SearXNG, Crawl4AI, and the Web Tools server.

## Project vault

This repository is also a version-controlled [Obsidian](https://obsidian.md/) vault for local planning and research:

- [`docs/`](./docs/README.md) contains durable engineering docs, in-flight specs, and the Markdown story board.
- [`docs/tasks/`](./docs/tasks/CLAUDE.md) stores one Tasks-format story card per file; open the vendored Task Board plugin for the status-based kanban view.
- [`docs/_templates/`](./docs/_templates/CLAUDE.md) contains story and spec scaffolds.
- [`library/`](./library/README.md) is the cited research wiki with raw-source provenance and synthesis.

Open the repository root as the vault. The required Tasks, Task Board, and Templater plugins and the recommended Dataview, Breadcrumbs, and Excalidraw plugins are vendored under `.obsidian/plugins/`.

## Tools

The server exposes nine tools:

### `web_search`

Lightweight web search via SearXNG with parallel request strategy for reliability.

| Parameter | Type              | Description                                  |
| --------- | ----------------- | -------------------------------------------- |
| `query`   | string (required) | The search query                             |
| `limit`   | number (optional) | Max results to return (default: 10, max: 20) |
| `engines` | string (optional) | Comma-separated engines (e.g. "google,brave") |

Returns a JSON array of `{ url, title, description }` results.

### `web_fetch`

Fetch a single URL and return its content as clean markdown via Crawl4AI.

| Parameter | Type              | Description                                                              |
| --------- | ----------------- | ------------------------------------------------------------------------ |
| `url`     | string (required) | URL to fetch                                                             |
| `f`       | enum (optional)   | Content-filter strategy: `raw`, `fit`, `bm25`, or `llm` (default: `fit`) |
| `q`       | string (optional) | Query string for BM25/LLM filters                                        |

Returns the page content as markdown.

Current limitation: the implementation distinguishes `raw` from all other filter values. `bm25`, `llm`, their query/provider options, and the `c` caching option are declared by the schema but are not yet applied by the Crawl4AI request path.

### `web_screenshot`

Capture a full-page PNG screenshot of a URL via Crawl4AI.

| Parameter             | Type              | Description                                 |
| --------------------- | ----------------- | ------------------------------------------- |
| `url`                 | string (required) | URL to screenshot                           |
| `screenshot_wait_for` | number (optional) | Seconds to wait before capture (default: 2) |

Returns a base64-encoded PNG image.

### `web_pdf`

Generate a PDF document of a URL via Crawl4AI.

| Parameter | Type              | Description           |
| --------- | ----------------- | --------------------- |
| `url`     | string (required) | URL to convert to PDF |

Returns a base64-encoded PDF.

### `web_execute_js`

Execute JavaScript snippets on a URL via Crawl4AI and return the full crawl result.

| Parameter | Type                | Description                                     |
| --------- | ------------------- | ----------------------------------------------- |
| `url`     | string (required)   | URL to execute scripts on                       |
| `scripts` | string[] (required) | List of JavaScript snippets to execute in order |

Returns the full CrawlResult JSON including markdown, links, media, and JS execution results.

### `web_crawl`

Crawl one or more URLs and extract their content using Crawl4AI.

| Parameter        | Type                | Description                                                      |
| ---------------- | ------------------- | ---------------------------------------------------------------- |
| `urls`           | string[] (required) | List of URLs to crawl                                            |
| `browser_config` | object (optional)   | Crawl4AI browser configuration; merged over the stealth defaults |
| `crawler_config` | object (optional)   | Crawl4AI crawler configuration                                   |

Returns the extracted content from each URL.

Both config objects may be written flat (`{"css_selector": "main"}`) or wrapped (`{"type": "CrawlerRunConfig", "params": {...}}`); Web Tools normalizes either into the one envelope Crawl4AI is sent. Your keys are merged with the defaults rather than replacing or silently dropping them.

The pinned Crawl4AI image refuses a set of configuration fields from a network caller, including `proxy_config`, `cdp_url`, `cookies`, `headers` and `extra_args` on `browser_config`, and `session_id`, `magic`, `js_code`, `simulate_user` and `override_navigator` on `crawler_config`. Supplying one returns an error naming the field rather than a request Crawl4AI rejects. The full sets are in [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md).

### `web_snapshots`

List Wayback Machine snapshots for a URL.

| Parameter    | Type                | Description                                                             |
| ------------ | ------------------- | ----------------------------------------------------------------------- |
| `url`        | string (required)   | URL to check for snapshots                                              |
| `from`       | string (optional)   | Start date in YYYYMMDD format                                           |
| `to`         | string (optional)   | End date in YYYYMMDD format                                             |
| `limit`      | number (optional)   | Max number of snapshots to return (default: 100)                        |
| `match_type` | enum (optional)     | URL matching: `exact`, `prefix`, `host`, or `domain` (default: `exact`) |
| `filter`     | string[] (optional) | CDX API filters (e.g. `["statuscode:200", "mimetype:text/html"]`)       |

Returns a JSON array of snapshots with timestamps, status codes, and archive URLs.

### `web_archive`

Retrieve an archived page from the Wayback Machine.

| Parameter   | Type               | Description                                                          |
| ----------- | ------------------ | -------------------------------------------------------------------- |
| `url`       | string (required)  | URL of the page to retrieve                                          |
| `timestamp` | string (required)  | Timestamp in YYYYMMDDHHMMSS format                                   |
| `original`  | boolean (optional) | Get original content without Wayback Machine banner (default: false) |

Returns the archived page content.

### `web_usage_stats`

Return process-local tool call counts, approximate proxy bandwidth, and estimated USD cost. The counters reset whenever the Web Tools process restarts; use `started_at` to identify the current statistics epoch. These values are operational estimates, not durable billing records.

This tool accepts no parameters. The same data is available from the authenticated `GET /stats` endpoint.

## Interfaces

### MCP

All MCP-compatible clients can connect via HTTP:

#### Claude Code (CLI)

```bash
claude mcp add web_tools \
  --transport http \
  https://your-server.up.railway.app/mcp \
  --header "Authorization: Bearer your-api-key"
```

#### Project-level config (`.mcp.json`)

```json
{
  "mcpServers": {
    "web_tools": {
      "type": "http",
      "url": "https://your-server.up.railway.app/mcp",
      "headers": {
        "Authorization": "Bearer your-api-key"
      }
    }
  }
}
```

#### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "web_tools": {
      "type": "http",
      "url": "https://your-server.up.railway.app/mcp",
      "headers": {
        "Authorization": "Bearer your-api-key"
      }
    }
  }
}
```

### REST API

Every tool is also available as a REST endpoint:

```bash
# Discovery — list all tools
curl https://your-server.up.railway.app/api/v0 \
  -H "Authorization: Bearer your-api-key"

# Search
curl -X POST https://your-server.up.railway.app/api/v0/web_search \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"query": "railway deployment"}'

# Fetch
curl -X POST https://your-server.up.railway.app/api/v0/web_fetch \
  -H "Authorization: Bearer your-api-key" \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com"}'
```

### Operational Endpoints

Three endpoints exist alongside the tools. They answer three different questions — do not substitute one for another.

```bash
# Liveness — unauthenticated, no API key needed
curl https://your-server.up.railway.app/health

# Readiness — requires the API key
curl https://your-server.up.railway.app/ready \
  -H "Authorization: Bearer your-api-key"

# Usage counters — requires the API key
curl https://your-server.up.railway.app/stats \
  -H "Authorization: Bearer your-api-key"
```

#### `GET /health` — is the process alive?

**Unauthenticated.** Always returns HTTP 200 with `{"status":"ok"}` while the process is running, does no network I/O, and never carries dependency state.

It proves only that the server can answer an HTTP request. It proves **nothing** about SearXNG, Crawl4AI, Redis, target sites, or the Wayback Machine — a fully broken stack still returns 200 here.

That is deliberate: `/health` is the platform health check path on the deployed service. If it went red during an upstream outage, the platform would restart healthy containers in a loop and block deploys exactly when a fix needs to ship. Point your platform health check here, and never point it at `/ready`.

#### `GET /ready` — are the dependencies usable?

**Requires the API key**, because it exposes internal topology and dependency failure detail.

**Always returns HTTP 200**, even when everything is down — read the verdict from the body, never from the status code:

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

- `status` rolls up the dependencies: `ok` (all healthy), `degraded` (some healthy), `unhealthy` (none healthy).
- Each dependency is `ok` or `unhealthy`. `detail` appears only when `unhealthy`, and is one of `timeout`, `network_error`, `protocol_error`, or `http_status:<code>` — never upstream text, so no URL or credential can leak into the response.
- SearXNG is probed with a cheap reachability request; Crawl4AI with a cheap MCP `tools/list` call. Both run concurrently, each bounded by a 3-second timeout.
- Results are cached for up to 5 seconds, so polling this endpoint cannot flood your own upstreams. `checked_at` is when the probes actually ran — a repeated value means you got a cached report.

It proves SearXNG is reachable and Crawl4AI answers MCP. It does **not** prove that a search will return results, that a browser can launch, that a given target site is reachable, or that the Wayback Machine is up.

#### `GET /stats` — how much has been used?

**Requires the API key.** Returns the same process-local counters as the `web_usage_stats` tool. They reset on restart; they are operational estimates, not durable billing records.

### CLI

```bash
# Search
web-tools search "railway deployment" --limit 5

# Fetch page as markdown
web-tools fetch https://example.com

# Screenshot
web-tools screenshot https://example.com

# Crawl multiple URLs
web-tools crawl https://a.com https://b.com --selector main

# Note: --magic maps to the Crawl4AI `magic` field, which the pinned
# Crawl4AI image refuses from a network caller. The command now fails
# fast with an error naming the field instead of appearing to succeed.

# Wayback Machine
web-tools snapshots https://example.com --from 20200101
web-tools archive https://example.com --timestamp 20200101120000
```

### Replace Claude Code's Built-in Web Search & Web Fetch (Optional)

**1. Add the MCP server globally:**

```bash
claude mcp add web_tools --scope user \
  --transport http \
  https://your-server.up.railway.app/mcp \
  --header "Authorization: Bearer your-api-key"
```

**2. Disable the built-in tools** by editing `~/.claude/settings.json`:

```json
{
  "permissions": {
    "deny": ["WebSearch", "WebFetch"]
  }
}
```

**3. Guide Claude via `~/.claude/CLAUDE.md`** so it uses your tools:

```markdown
## Search & Fetch

- Use the web_search MCP tool for all web searches
- Use the web_fetch MCP tool to fetch and read web pages
- Do not attempt to use the built-in WebSearch or WebFetch tools
```

## Deployment (Railway)

[![Deploy on Railway](https://railway.com/button.svg)](https://railway.com/deploy/web-tools?referralCode=zMTz_F&utm_medium=integration&utm_source=template&utm_campaign=generic)

- Click **Deploy on Railway**: you'll see all 4 services listed (Redis, SearXNG, Crawl4AI, Web Tools Server)
- Click **Deploy**: Railway provisions everything and wires the services together automatically
- An `API_KEY` is **auto-generated** during deployment. Find it in your Web Tools service's **Variables** tab and use it as your Bearer token

### Railway Configuration

The **Web Tools Server** service uses the root `Dockerfile` — no config changes needed.

The **SearXNG** service should build from the repo instead of a Docker image:
- **Source**: same GitHub repo
- **Root Directory**: `services/searxng`
- **Optional env var**: `PROXY_URL` — proxy for outgoing search requests (e.g. `socks5://user:pass@host:port`)

The **Crawl4AI** service should also build from the repo instead of a Docker image:
- **Source**: same GitHub repo
- **Root Directory**: `services/crawl4ai`
- **Why**: the custom image repairs the upstream Playwright browser path and pins the Crawl4AI version

## Quick Start (Local)

### 1. Clone and install

```bash
git clone https://github.com/arnaudjnn/web-tools
cd web-tools
pnpm install
```

### 2. Configure environment

```bash
cp .env.example .env.local
```

### 3. Start the local stack

```bash
docker compose up -d redis searxng crawl4ai
```

This starts Redis, SearXNG, and Crawl4AI.

**Before the stack is usable for crawls:** export `CRAWL4AI_API_TOKEN` in your shell before the command above, e.g. `export CRAWL4AI_API_TOKEN=<token>` — setting it only in `.env.local` does not reach the `crawl4ai` service (Compose interpolates `${CRAWL4AI_API_TOKEN}` from your shell environment or a default `.env` file, never from `.env.local`; the host-run server below does read `.env.local`, so the shell export is needed for the container, not for it). Without a token, Crawl4AI binds `127.0.0.1` inside its own container and its published port refuses connections from the host, so `pnpm run start` below still boots, but every `web_fetch`, crawl, screenshot, PDF, and JavaScript-execution request fails.

**First run only:** the SearXNG and Crawl4AI images build locally instead of pulling, so it takes noticeably longer than a pull — this is expected, not a hang.

The Crawl4AI image is amd64-only (its Playwright browser-binary check only resolves on amd64). `docker-compose.yml` pins the `crawl4ai` service to `platform: linux/amd64`, so Compose builds and runs it under emulation automatically on Apple Silicon or other arm64 hosts — no extra configuration needed, though emulated builds and requests run slower than native.

Then run the server:

```bash
SEARXNG_URL=http://localhost:8080 CRAWL4AI_URL=http://localhost:11235 pnpm run start
```

The server is available at `http://localhost:3000`.

### 4. Or run everything in Docker

```bash
docker compose up
```

As in step 3, the first run builds the images locally before starting, so expect several minutes on a cold cache. Unlike step 3, `web_tools` now runs in its own container, which reads `CRAWL4AI_API_TOKEN` only from `.env.local` (via `env_file`), not from your shell — while Crawl4AI itself still reads the token only from your shell. So before this command, set the same value in **both** places: uncomment and set `CRAWL4AI_API_TOKEN` in `.env.local`, and also `export CRAWL4AI_API_TOKEN=<token>` in your shell. Skipping either leaves `web_tools` unable to authenticate with Crawl4AI, or Crawl4AI unreachable altogether. Apple Silicon and other arm64 hosts need no extra configuration — see step 3 for why.

## Environment Variables

| Variable | Required | Description |
| --- | --- | --- |
| `API_KEY` | Yes | Bearer token for authentication (auto-generated on Railway) |
| `SEARXNG_URL` | No | SearXNG URL (default: `http://searxng.railway.internal:8080`) |
| `CRAWL4AI_URL` | No | Crawl4AI URL (default: `http://crawl4ai.railway.internal:11235`) |
| `CRAWL4AI_API_TOKEN` | No | API token for Crawl4AI authentication |
| `SEARXNG_ENGINES` | No | Default engines (e.g. `"google,brave,duckduckgo"`) |
| `PROXY_URL` | No | Proxy for SearXNG outgoing requests (set on SearXNG service) |

## Authentication

The `API_KEY` environment variable is **required**.

On Railway, the key is auto-generated at deploy time (via `${{secret()}}`). For local development, set it in your `.env.local` file.

Clients provide the key as a `Bearer` token in the `Authorization` header or as an `?api_key=` query parameter.

Only `/health` is unauthenticated. Everything else — MCP, REST discovery, REST tool execution, `/ready`, and `/stats` — requires the key. See [Operational Endpoints](#operational-endpoints).

## License

MIT
