/**
 * Covers the unauthenticated local-stack mode: when `API_KEY` is unset, the
 * auth middleware is bypassed and every route answers without credentials.
 *
 * This exists so the local Compose stack needs no `.env.local` and no
 * generated key. The complementary case — `API_KEY` set, so a missing or
 * wrong key is rejected — is covered by `ready-routing.test.ts`, which boots
 * the same app with a key configured.
 *
 * Same testability seam as `ready.test.ts` / `ready-routing.test.ts`:
 * `PORT=0` plus a dynamic `import()` of the real `index.ts`, with fake
 * upstreams that answer cleanly rather than refusing a connection (a refused
 * Crawl4AI connect makes the `eventsource` reconnect loop leak a timer that
 * can keep `node --test` alive).
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import express, { Response as ExpressResponse, Request } from 'express';

const searxngApp = express();
searxngApp.get('/healthz', (_req: Request, res: ExpressResponse) => {
  res.status(200).end();
});

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
  // The subject of this file: no key configured at all.
  delete process.env.API_KEY;
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

test('the app boots with no API_KEY instead of refusing to start', () => {
  // Before this change the Zod schema declared API_KEY required, so importing
  // the app without one threw at config-parse time and the stack could not
  // come up without a generated key.
  assert.ok(baseUrl, 'server did not start without API_KEY');
});

test('routes that require a key when one is configured answer without credentials', async () => {
  for (const path of ['/api/v0', '/stats', '/ready']) {
    const res = await fetch(`${baseUrl}${path}`);
    assert.notEqual(
      res.status,
      403,
      `${path} rejected an unauthenticated request while API_KEY is unset`,
    );
    assert.ok(
      res.status < 500,
      `${path} returned ${res.status} for an unauthenticated request`,
    );
  }
});

test('/health stays open, as it is when a key is configured', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.equal(res.status, 200);
});

test('a bogus bearer token is accepted rather than rejected, since no key is configured', async () => {
  // Guards against a partial implementation that skips the *lookup* but still
  // compares against an empty expected key and rejects everything.
  const res = await fetch(`${baseUrl}/api/v0`, {
    headers: { Authorization: 'Bearer not-the-configured-key' },
  });
  assert.notEqual(res.status, 403);
});
