/**
 * Exercises the real application (`packages/api/src/index.ts`) end to
 * end over real HTTP: `/health` liveness and no-I/O, `/ready` auth
 * (missing / wrong / valid key), the both-reachable aggregate, each
 * dependency-down transition, and the no-secret assertion.
 *
 * `index.ts` binds `PORT` and registers a SIGINT handler at module load,
 * so it cannot be imported normally in a test. Per the spec's testability
 * seam, this file sets `PORT=0` and `API_KEY`/`SEARXNG_URL`/
 * `CRAWL4AI_URL`/proxy vars, then dynamically imports `./index.js`,
 * reads the ephemeral port off the exported `server`, and closes it in
 * teardown — production wiring runs exactly as it ships.
 *
 * Config (and therefore SEARXNG_URL/CRAWL4AI_URL) is frozen the first
 * time anything pulls in `@web-tools/toolkit`, which happens exactly once
 * per test-file process. So this file imports `index.ts` exactly once,
 * pointed at two long-lived local fake upstreams, and drives the
 * different dependency states by toggling those fakes' *behaviour* over
 * time — the same shape as the story card's manual reproduction steps
 * (stop SearXNG, confirm degraded; restart it, stop Crawl4AI, confirm
 * degraded differently) — rather than by re-importing with different env
 * vars.
 *
 * Both fakes stay listening for the whole file; "down" is simulated by
 * changing what they answer, never by unbinding the port:
 *   - the SearXNG fake destroys the underlying socket when "down",
 *     giving a genuine client-side network error (safe: a plain `fetch`
 *     never auto-retries);
 *   - the Crawl4AI fake answers a clean, immediate HTTP 503 (never
 *     starting the SSE handshake) when "down". This is deliberate, not
 *     arbitrary: verified against the installed `eventsource` package
 *     (the dependency behind the MCP SDK's `SSEClientTransport`), a
 *     *rejected or hung* fetch (a truly refused connection) makes the
 *     transport schedule an internal reconnect every ~3s *forever*, with
 *     no way to stop it from outside `getClient()` (which this story must
 *     not restructure) — an unbounded background timer that would leak
 *     across tests and could keep `node --test` from ever exiting. A
 *     clean non-200 HTTP response instead hits the transport's
 *     permanent-failure path (one error event, no retry).
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import express, { Response as ExpressResponse, Request } from 'express';

const originalFetch = globalThis.fetch;

const FAKE_API_KEY = 'ready-test-api-key';
const FAKE_CRAWL4AI_TOKEN = 'crawl4ai-secret-token-should-never-leak';
const FAKE_PROXY_USERNAME = 'proxy-user-should-never-leak';
const FAKE_PROXY_PASSWORD = 'proxy-pass-should-never-leak';

// ── Fake SearXNG: a plain HTTP responder toggled up/down ────────────────

let searxngUp = true;
const searxngApp = express();
searxngApp.get('/healthz', (req: Request, res: ExpressResponse) => {
  if (!searxngUp) {
    // A genuine client-side network failure, not an HTTP error response.
    req.socket.destroy();
    return;
  }
  res.status(200).end();
});

// ── Fake Crawl4AI: a real (minimal) MCP SSE server toggled up/down ──────

let crawl4aiUp = true;
const crawl4aiApp = express();
crawl4aiApp.use(express.json());
const crawl4aiTransports = new Map<string, SSEServerTransport>();

crawl4aiApp.get('/mcp/sse', async (req: Request, res: ExpressResponse) => {
  if (!crawl4aiUp) {
    // A clean non-200 response — see file header for why this must never
    // be a hang or a rejected connection.
    res.status(503).end();
    return;
  }

  const transport = new SSEServerTransport('/messages', res);
  crawl4aiTransports.set(transport.sessionId, transport);
  res.on('close', () => crawl4aiTransports.delete(transport.sessionId));

  const server = new McpServer({ name: 'fake-crawl4ai', version: '0.0.0' });
  server.tool('ping', 'no-op probe target', {}, async () => ({
    content: [],
  }));
  await server.connect(transport);
});

crawl4aiApp.post('/messages', async (req: Request, res: ExpressResponse) => {
  const sessionId = req.query.sessionId as string | undefined;
  const transport = sessionId ? crawl4aiTransports.get(sessionId) : undefined;
  if (!transport) {
    res.status(400).end('unknown session');
    return;
  }
  await transport.handlePostMessage(req, res, req.body);
});

/**
 * Toggles the fake Crawl4AI's availability. Going down actively closes any
 * already-open SSE session: the toolkit's `getClient()` memoises its
 * connection, so merely flipping the flag would leave an existing
 * "reachable" probe reusing its already-open connection forever — the
 * flag only affects a *new* connection attempt at GET /mcp/sse, and a new
 * attempt only happens once the client notices its current one closed.
 */
function setCrawl4aiUp(up: boolean): void {
  crawl4aiUp = up;
  if (!up) {
    for (const transport of crawl4aiTransports.values()) {
      void transport.close();
    }
    crawl4aiTransports.clear();
  }
}

// ── Test app: the real application, imported once ────────────────────

let baseUrl: string;
let closeApp: () => Promise<void>;
let closeSearxng: () => Promise<void>;
let closeCrawl4ai: () => Promise<void>;

async function listen(
  app: express.Express,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () =>
      new Promise<void>(resolve => {
        // Force-close any still-open sockets (e.g. a live SSE stream) so
        // teardown can't hang waiting for a connection that never ends on
        // its own.
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

before(async () => {
  const searxng = await listen(searxngApp);
  closeSearxng = searxng.close;
  const crawl4ai = await listen(crawl4aiApp);
  closeCrawl4ai = crawl4ai.close;

  process.env.PORT = '0';
  process.env.API_KEY = FAKE_API_KEY;
  process.env.SEARXNG_URL = searxng.url;
  process.env.SEARXNG_ENGINES = '';
  process.env.CRAWL4AI_URL = crawl4ai.url;
  process.env.CRAWL4AI_API_TOKEN = FAKE_CRAWL4AI_TOKEN;
  process.env.PROXY_SERVER = 'socks5://proxy.example.invalid:1080';
  process.env.PROXY_USERNAME = FAKE_PROXY_USERNAME;
  process.env.PROXY_PASSWORD = FAKE_PROXY_PASSWORD;

  const mod = (await import('./index.js')) as typeof import('./index.js');
  const address = mod.server.address() as AddressInfo | null;
  if (!address) {
    await new Promise<void>(resolve => mod.server.once('listening', resolve));
  }
  const port = (mod.server.address() as AddressInfo).port;
  baseUrl = `http://127.0.0.1:${port}`;
  closeApp = () =>
    new Promise<void>(resolve => {
      mod.server.closeAllConnections?.();
      mod.server.close(() => resolve());
    });
});

after(async () => {
  setCrawl4aiUp(false); // closes any still-open SSE session before teardown
  await closeApp();
  await closeSearxng();
  await closeCrawl4ai();
});

function authedGet(path: string, apiKey?: string): Promise<Response> {
  return originalFetch(`${baseUrl}${path}`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
}

const READINESS_CACHE_TTL_MARGIN_MS = 250;
// Mirrors readiness.ts's own constant without importing toolkit test-only
// internals — a fixed 5000ms upper bound from the story card, asserted
// again below via the response document itself.
const CACHE_TTL_MS = 5000;

function waitPastCacheTtl(): Promise<void> {
  return new Promise(resolve =>
    setTimeout(resolve, CACHE_TTL_MS + READINESS_CACHE_TTL_MARGIN_MS),
  );
}

// ── /health: pure liveness ───────────────────────────────────────────

test('GET /health returns 200 with body exactly {"status":"ok"}, no auth required', async () => {
  const res = await originalFetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
  const text = await res.text();
  assert.equal(text, '{"status":"ok"}');
});

test('GET /health performs no network I/O', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    throw new Error('should never be called');
  }) as typeof fetch;

  try {
    const res = await originalFetch(`${baseUrl}/health`);
    assert.equal(res.status, 200);
  } finally {
    globalThis.fetch = originalFetch;
  }
  assert.equal(calls, 0);
});

// ── /ready: auth ──────────────────────────────────────────────────────

test('GET /ready without an API key is rejected with 403 forbidden and no dependency info', async () => {
  const res = await originalFetch(`${baseUrl}/ready`);
  assert.equal(res.status, 403);
  const body = (await res.json()) as Record<string, unknown>;
  assert.equal(body.error, 'forbidden');
  assert.ok(!('dependencies' in body));
});

test('GET /ready with a wrong API key is rejected with 403', async () => {
  const res = await authedGet('/ready', 'not-the-configured-key');
  assert.equal(res.status, 403);
});

test('GET /ready with the configured API key returns 200 with the readiness document', async () => {
  const res = await authedGet('/ready', FAKE_API_KEY);
  assert.equal(res.status, 200);
  const body = (await res.json()) as { status: string; dependencies: unknown };
  assert.ok(['ok', 'degraded', 'unhealthy'].includes(body.status));
  assert.ok(body.dependencies);
});

test('the /health bypass is not widened: /health succeeds without a key while /ready does not', async () => {
  const [health, ready] = await Promise.all([
    originalFetch(`${baseUrl}/health`),
    originalFetch(`${baseUrl}/ready`),
  ]);
  assert.equal(health.status, 200);
  assert.equal(ready.status, 403);
});

// ── /ready: dependency states (sequential, mirrors the manual repro) ────

test('both dependencies reachable: aggregate ok, both deps ok with no detail', async () => {
  searxngUp = true;
  setCrawl4aiUp(true);

  const res = await authedGet('/ready', FAKE_API_KEY);
  assert.equal(res.status, 200);
  const body = (await res.json()) as {
    status: string;
    checked_at: string;
    dependencies: {
      searxng: { status: string; latency_ms: number; detail?: string };
      crawl4ai: { status: string; latency_ms: number; detail?: string };
    };
  };

  assert.equal(body.status, 'ok');
  assert.equal(body.dependencies.searxng.status, 'ok');
  assert.equal(body.dependencies.searxng.detail, undefined);
  assert.ok(Number.isInteger(body.dependencies.searxng.latency_ms));
  assert.ok(body.dependencies.searxng.latency_ms >= 0);
  assert.equal(body.dependencies.crawl4ai.status, 'ok');
  assert.equal(body.dependencies.crawl4ai.detail, undefined);
  assert.ok(Number.isInteger(body.dependencies.crawl4ai.latency_ms));
  assert.ok(body.dependencies.crawl4ai.latency_ms >= 0);
  assert.ok(!Number.isNaN(Date.parse(body.checked_at)));
});

test('SearXNG unreachable, Crawl4AI reachable: degraded, searxng unhealthy network_error', async () => {
  searxngUp = false;
  setCrawl4aiUp(true);
  await waitPastCacheTtl();

  const res = await authedGet('/ready', FAKE_API_KEY);
  const body = (await res.json()) as {
    status: string;
    dependencies: {
      searxng: { status: string; detail?: string };
      crawl4ai: { status: string; detail?: string };
    };
  };

  assert.equal(res.status, 200);
  assert.equal(body.dependencies.searxng.status, 'unhealthy');
  assert.equal(body.dependencies.searxng.detail, 'network_error');
  assert.equal(body.dependencies.crawl4ai.status, 'ok');
  assert.equal(body.status, 'degraded');

  // /health stays a clean 200 while a dependency is genuinely down.
  const health = await originalFetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), '{"status":"ok"}');
});

test('SearXNG restored, Crawl4AI unreachable: degraded, crawl4ai unhealthy with a closed-set detail', async () => {
  searxngUp = true;
  setCrawl4aiUp(false);
  await waitPastCacheTtl();

  const res = await authedGet('/ready', FAKE_API_KEY);
  const body = (await res.json()) as {
    status: string;
    dependencies: {
      searxng: { status: string };
      crawl4ai: { status: string; detail?: string };
    };
  };

  assert.equal(res.status, 200);
  assert.equal(body.dependencies.searxng.status, 'ok');
  assert.equal(body.dependencies.crawl4ai.status, 'unhealthy');
  assert.match(
    body.dependencies.crawl4ai.detail ?? '',
    /^(timeout|network_error|protocol_error|http_status:\d{3})$/,
  );
  assert.equal(body.status, 'degraded');
});

test('no dependency reachable: aggregate unhealthy, still HTTP 200, no secret in the body', async () => {
  searxngUp = false;
  setCrawl4aiUp(false);
  await waitPastCacheTtl();

  const res = await authedGet('/ready', FAKE_API_KEY);
  assert.equal(res.status, 200);
  const rawText = await res.text();
  const body = JSON.parse(rawText) as {
    status: string;
    dependencies: {
      searxng: { status: string; detail?: string };
      crawl4ai: { status: string; detail?: string };
    };
  };

  assert.equal(body.dependencies.searxng.status, 'unhealthy');
  assert.equal(body.dependencies.crawl4ai.status, 'unhealthy');
  assert.equal(body.status, 'unhealthy');

  for (const dep of Object.values(body.dependencies)) {
    assert.match(
      dep.detail ?? '',
      /^(timeout|network_error|protocol_error|http_status:\d{3})$/,
    );
  }

  assert.ok(!rawText.includes(FAKE_API_KEY));
  assert.ok(!rawText.includes(FAKE_CRAWL4AI_TOKEN));
  assert.ok(!rawText.includes(FAKE_PROXY_USERNAME));
  assert.ok(!rawText.includes(FAKE_PROXY_PASSWORD));
  assert.ok(!rawText.includes('Bearer'));
});
