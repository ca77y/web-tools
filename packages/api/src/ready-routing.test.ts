/**
 * Complements `ready.test.ts` by covering what adding `GET /ready`
 * changes *about the rest of the application*, and the load-amplification
 * bound at the HTTP layer rather than inside `checkReadiness()`:
 *
 *   - a burst of concurrent `/ready` requests issues exactly one upstream
 *     probe round (the card's manual step 6: "poll /ready rapidly and
 *     confirm upstream request volume is bounded by the cache TTL, not by
 *     poll rate"), and every caller sees the same document;
 *   - a rejected (unauthenticated) `/ready` request probes nothing, so an
 *     unauthenticated caller cannot drive upstream load at all;
 *   - `/ready` authenticates through the `api_key` query parameter too,
 *     not only a bearer token;
 *   - the pre-existing routes (`/mcp`, `/api/v0`, `/stats`, `/health`)
 *     still behave exactly as before, `/ready` shadows none of them, and
 *     none of them triggers a dependency probe.
 *
 * Same testability seam and same fake-upstream discipline as
 * `ready.test.ts`: `PORT=0` plus a dynamic `import()` of the real
 * `index.ts`, and fakes that answer cleanly rather than refusing a
 * connection (a refused Crawl4AI connect makes the `eventsource`
 * reconnect loop leak a timer that can keep `node --test` alive). Here
 * Crawl4AI is *always* a clean 503 — this file is about caching and
 * routing, and `ready.test.ts` already owns the Crawl4AI verdicts — so
 * the expected aggregate throughout is `degraded`.
 *
 * No cache-TTL waits: every assertion is relative to a hit count sampled
 * in the same test, so nothing here depends on wall-clock timing.
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import express, { Response as ExpressResponse, Request } from 'express';

const FAKE_API_KEY = 'ready-routing-test-api-key';

// ── Fake upstreams ───────────────────────────────────────────────────

let searxngHits = 0;
const searxngApp = express();
searxngApp.get('/healthz', (_req: Request, res: ExpressResponse) => {
  searxngHits++;
  res.status(200).end();
});

// Always a clean, immediate 503 — never a refused connection. See header.
const crawl4aiApp = express();
crawl4aiApp.get('/mcp/sse', (_req: Request, res: ExpressResponse) => {
  res.status(503).end();
});

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

  const mod = (await import('./index.js')) as typeof import('./index.js');
  if (!mod.server.address()) {
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
  await closeApp();
  await closeSearxng();
  await closeCrawl4ai();
});

function get(path: string, apiKey?: string): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
  });
}

type ReadyBody = {
  status: string;
  checked_at: string;
  dependencies: Record<string, { status: string; detail?: string }>;
};

// ── Cache bound at the HTTP layer ────────────────────────────────────
// This test must run first: it needs a cold readiness cache.

test('a burst of concurrent /ready requests issues exactly one upstream probe round', async () => {
  assert.equal(searxngHits, 0, 'precondition: no probe has run yet');

  const responses = await Promise.all(
    Array.from({ length: 12 }, () => get('/ready', FAKE_API_KEY)),
  );
  const bodies = (await Promise.all(
    responses.map(r => r.json()),
  )) as ReadyBody[];

  for (const res of responses) assert.equal(res.status, 200);
  assert.equal(
    searxngHits,
    1,
    `12 concurrent /ready requests must produce one upstream round, saw ${searxngHits}`,
  );
  assert.equal(
    new Set(bodies.map(b => b.checked_at)).size,
    1,
    'every caller in the burst sees the same report',
  );
  // SearXNG up, Crawl4AI answering 503 on connect: a partial outage.
  assert.equal(bodies[0]?.status, 'degraded');
  assert.equal(bodies[0]?.dependencies.searxng?.status, 'ok');
  assert.equal(bodies[0]?.dependencies.crawl4ai?.status, 'unhealthy');
});

test('a second burst inside the TTL is served entirely from cache', async () => {
  const before = searxngHits;

  const bodies = (await Promise.all(
    Array.from({ length: 8 }, () =>
      get('/ready', FAKE_API_KEY).then(r => r.json()),
    ),
  )) as ReadyBody[];

  assert.equal(searxngHits, before, 'no additional upstream request');
  assert.equal(
    new Set(bodies.map(b => b.checked_at)).size,
    1,
    'a cached response carries the older checked_at — that is how staleness is visible',
  );
});

test('a rejected /ready request never reaches a dependency', async () => {
  const before = searxngHits;

  const [missing, wrong] = await Promise.all([
    get('/ready'),
    get('/ready', 'not-the-configured-key'),
  ]);

  assert.equal(missing.status, 403);
  assert.equal(wrong.status, 403);
  assert.equal(
    searxngHits,
    before,
    'auth runs before the probe, so an unauthenticated caller cannot drive upstream load',
  );
});

test('/ready also authenticates through the api_key query parameter', async () => {
  const res = await fetch(
    `${baseUrl}/ready?api_key=${encodeURIComponent(FAKE_API_KEY)}`,
  );
  assert.equal(res.status, 200);
  const body = (await res.json()) as ReadyBody;
  assert.ok(['ok', 'degraded', 'unhealthy'].includes(body.status));
});

// ── The new route disturbs nothing else ──────────────────────────────

test('the pre-existing routes are unchanged by the /ready addition, and none of them probes', async () => {
  const before = searxngHits;

  const health = await fetch(`${baseUrl}/health`);
  assert.equal(health.status, 200);
  assert.equal(await health.text(), '{"status":"ok"}');

  const catalogue = await get('/api/v0', FAKE_API_KEY);
  assert.equal(catalogue.status, 200);
  const catalogueBody = (await catalogue.json()) as {
    tools: { name: string }[];
  };
  assert.ok(catalogueBody.tools.length > 0);
  assert.ok(catalogueBody.tools.some(t => t.name === 'web_search'));
  assert.ok(
    !catalogueBody.tools.some(t => t.name === 'ready'),
    'readiness is an operational route, not a registered tool',
  );

  const stats = await get('/stats', FAKE_API_KEY);
  assert.equal(stats.status, 200);
  const statsBody = (await stats.json()) as Record<string, unknown>;
  assert.ok('started_at' in statsBody);
  assert.ok('total_calls' in statsBody);
  assert.ok(
    !('dependencies' in statsBody),
    '/stats must not have absorbed readiness state',
  );

  const mcp = await get('/mcp', FAKE_API_KEY);
  assert.equal(mcp.status, 405, 'GET /mcp still answers method-not-allowed');

  assert.equal(
    searxngHits,
    before,
    'no non-readiness route triggers a dependency probe',
  );
});

test('/ready is an exact path and shadows no neighbouring route', async () => {
  const [readyz, readySlash, readyPost] = await Promise.all([
    get('/readyz', FAKE_API_KEY),
    get('/ready/deps', FAKE_API_KEY),
    fetch(`${baseUrl}/ready`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${FAKE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    }),
  ]);

  assert.equal(readyz.status, 404);
  assert.equal(readySlash.status, 404);
  assert.equal(
    readyPost.status,
    404,
    '/ready is a GET-only read; POST must not be silently accepted',
  );
});
