/**
 * Exercises the real REST `toolHandler` (handler.ts) over a real HTTP
 * round trip — a genuine `express()` app with `express.json()` and the
 * production `toolHandler` wired to a route, listening on a real socket,
 * hit with a real HTTP request. This mirrors how `packages/api/src/index.ts`
 * wires `toolHandler` (`app.post(\`/api/v0/${tool.name}\`, toolHandler(tool.name))`)
 * without importing index.ts itself, which has unguarded side effects
 * (binds the real PORT, requires request auth) unsuitable for import in a
 * test. No production source in this package is modified; only
 * `globalThis.fetch` is stubbed (to fake SearXNG's response) — the test's
 * own HTTP call to the local server uses the *original*, unstubbed fetch,
 * so it is a real network round trip, not a stand-in.
 */
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, test } from 'node:test';
import express from 'express';

import { toolHandler } from './handler.js';

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Stubs globalThis.fetch (consumed by the toolkit's SearXNG client only). */
function stubAllAttempts(responder: () => Response | Promise<Response>): void {
  globalThis.fetch = (async () => responder()) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Spins up a real Express server exposing the real toolHandler on a real port. */
async function withTestServer(
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  app.post('/api/v0/web_search', toolHandler('web_search'));

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as AddressInfo;

  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

/** Posts to the real server using the real (unstubbed) fetch. */
function postSearch(baseUrl: string): Promise<Response> {
  return originalFetch(`${baseUrl}/api/v0/web_search`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query: 'q' }),
  });
}

describe('REST transport reporting - POST /api/v0/web_search', () => {
  test('an all-attempts-failed web_search returns HTTP 500 with an error field', async () => {
    stubAllAttempts(() => jsonResponse({}, 503));

    await withTestServer(async baseUrl => {
      const res = await postSearch(baseUrl);

      assert.equal(res.status, 500);
      const payload = (await res.json()) as { error: string };
      assert.match(payload.error, /search/i);
    });
  });

  test('a genuine empty result returns HTTP 200 with an empty array', async () => {
    stubAllAttempts(() => jsonResponse({ results: [] }));

    await withTestServer(async baseUrl => {
      const res = await postSearch(baseUrl);

      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), []);
    });
  });
});
