/**
 * Exercises `checkReadiness()` (readiness.ts) directly: the SearXNG
 * verdict rule, the per-probe timeout bound (both probeSearXNG's own
 * AbortSignal-based timeout and readiness.ts's own outer backstop race),
 * the TTL cache / single-flight behaviour, the rollup, and the closed
 * detail set.
 *
 * Crawl4AI is deliberately never reachable in this file: its probe target
 * is a synthetic `fetch` stub that always answers a clean, immediately
 * resolved non-2xx response for anything that isn't the SearXNG health
 * path. This is a deliberate safety choice, not a shortcut — verified
 * against the installed `eventsource` package (the dependency behind the
 * MCP SDK's `SSEClientTransport`): a *rejected* or hung `fetch` (a truly
 * refused connection, or one that never settles) makes the transport
 * schedule an internal reconnect every ~3s *forever*, with no way to stop
 * it from outside `getClient()` (which this story must not restructure).
 * That would leak an unbounded background timer and could keep
 * `node --test` from ever exiting. A synchronous non-200 HTTP response
 * instead hits the transport's permanent-failure path (one error event,
 * no retry): fast, deterministic, and leak-free. The genuinely-reachable
 * ("both dependencies ok") case is covered in
 * `packages/api/src/ready.test.ts` against a real fake MCP SSE server.
 *
 * `checkReadiness()` keeps module-level cache/in-flight state, so each
 * test that needs a cold cache dynamically re-imports readiness.ts with a
 * cache-busting query string rather than sharing state across tests.
 */
import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

import { Config } from './config.js';
import * as crawl4aiModule from './crawl4ai.js';
import * as toolkitIndex from './index.js';
import {
  PROBE_TIMEOUT_MS,
  READINESS_CACHE_TTL_MS,
  type ReadinessReport,
} from './readiness.js';

const originalFetch = globalThis.fetch;

const DETAIL_PATTERN =
  /^(timeout|network_error|protocol_error|http_status:\d{3})$/;

function cleanResponse(status: number): Response {
  return new Response('', { status });
}

/**
 * Routes every `fetch` call: a request to SearXNG's `/healthz` probe path
 * is handed to `searxngResponder`; everything else (Crawl4AI's MCP SSE
 * probe, which also goes through `fetch` via its `eventSourceInit.fetch`
 * hook) gets an immediate, clean 404 — see the file header for why this
 * must never be a rejection or a hang.
 */
function stubFetch(
  searxngResponder: (init?: RequestInit) => Response | Promise<Response>,
): void {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url =
      typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.href
          : (input as Request).url;
    if (url.includes('/healthz')) {
      return searxngResponder(init);
    }
    return cleanResponse(404);
  }) as typeof fetch;
}

/** Like stubFetch, but also counts calls to the SearXNG health path. */
function stubFetchCounting(
  searxngResponder: (init?: RequestInit) => Response | Promise<Response>,
): { count: () => number } {
  let calls = 0;
  stubFetch(init => {
    calls++;
    return searxngResponder(init);
  });
  return { count: () => calls };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Fresh module instance so `cached`/`inFlight` module state starts cold. */
let instance = 0;
async function freshCheckReadiness(): Promise<() => Promise<ReadinessReport>> {
  instance++;
  const mod = (await import(
    `./readiness.js?test-instance=${instance}`
  )) as typeof import('./readiness.js');
  return mod.checkReadiness;
}

// ── SearXNG verdict rule ────────────────────────────────────────────────

test('SearXNG verdict: HTTP 200 is ok', async () => {
  stubFetch(() => cleanResponse(200));
  const checkReadiness = await freshCheckReadiness();

  const report = await checkReadiness();

  assert.equal(report.dependencies.searxng.status, 'ok');
  assert.equal(report.dependencies.searxng.detail, undefined);
  assert.ok(report.dependencies.searxng.latency_ms >= 0);
});

test('SearXNG verdict: HTTP 404 is still ok (server answered, not a version-pinned contract)', async () => {
  stubFetch(() => cleanResponse(404));
  const checkReadiness = await freshCheckReadiness();

  const report = await checkReadiness();

  assert.equal(report.dependencies.searxng.status, 'ok');
  assert.equal(report.dependencies.searxng.detail, undefined);
});

test('SearXNG verdict: HTTP 503 is unhealthy with http_status:503', async () => {
  stubFetch(() => cleanResponse(503));
  const checkReadiness = await freshCheckReadiness();

  const report = await checkReadiness();

  assert.equal(report.dependencies.searxng.status, 'unhealthy');
  assert.equal(report.dependencies.searxng.detail, 'http_status:503');
});

test('SearXNG verdict: a rejected fetch is unhealthy with network_error', async () => {
  stubFetch(() => {
    throw new TypeError('fetch failed');
  });
  const checkReadiness = await freshCheckReadiness();

  const report = await checkReadiness();

  assert.equal(report.dependencies.searxng.status, 'unhealthy');
  assert.equal(report.dependencies.searxng.detail, 'network_error');
});

test('SearXNG verdict: probeSearXNG own AbortSignal.timeout classifies as timeout', async () => {
  // Honours the abort signal (like a real fetch would), so this exercises
  // probeSearXNG's own timeout classification rather than readiness.ts's
  // outer backstop race.
  stubFetch(
    init =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(
            new DOMException('The operation was aborted.', 'TimeoutError'),
          );
        });
      }),
  );
  const checkReadiness = await freshCheckReadiness();

  const start = Date.now();
  const report = await checkReadiness();
  const elapsed = Date.now() - start;

  assert.equal(report.dependencies.searxng.status, 'unhealthy');
  assert.equal(report.dependencies.searxng.detail, 'timeout');
  assert.ok(
    elapsed <= PROBE_TIMEOUT_MS + 1000,
    `expected resolution near PROBE_TIMEOUT_MS, got ${elapsed}ms`,
  );
});

// ── Timeout bound (readiness.ts's own backstop) ─────────────────────────

test('a hung dependency that ignores its abort signal does not hang the response, and resolves rather than rejects', async () => {
  // Never settles, never honours init.signal — only readiness.ts's own
  // outer Promise.race bound can rescue this. Also exercises "a timeout
  // is a verdict, not an error": checkReadiness() must resolve (not
  // reject) with the unhealthy verdict.
  stubFetch(() => new Promise<Response>(() => {}));
  const checkReadiness = await freshCheckReadiness();

  const start = Date.now();
  await assert.doesNotReject(() => checkReadiness());
  const report = await checkReadiness();
  const elapsed = Date.now() - start;

  assert.ok(
    elapsed <= PROBE_TIMEOUT_MS + 1000,
    `expected resolution within PROBE_TIMEOUT_MS + margin, got ${elapsed}ms`,
  );
  assert.equal(report.dependencies.searxng.status, 'unhealthy');
  assert.equal(report.dependencies.searxng.detail, 'timeout');
});

test('the probe budget is short and strictly less than the search budget', () => {
  assert.ok(PROBE_TIMEOUT_MS <= 5000);
  assert.ok(PROBE_TIMEOUT_MS < Config.requestTimeout * 1000);
});

// ── Cache TTL and single-flight ──────────────────────────────────────────

test('repeated polling inside the TTL issues no upstream requests, then the cache expires', async () => {
  const { count } = stubFetchCounting(() => cleanResponse(200));
  const checkReadiness = await freshCheckReadiness();

  const first = await checkReadiness();
  const callsAfterFirst = count();
  assert.equal(callsAfterFirst, 1);

  for (let i = 0; i < 5; i++) {
    const again = await checkReadiness();
    assert.equal(
      count(),
      callsAfterFirst,
      'no new upstream request within the TTL',
    );
    assert.equal(again.checked_at, first.checked_at);
  }

  await new Promise(resolve =>
    setTimeout(resolve, READINESS_CACHE_TTL_MS + 250),
  );

  const afterExpiry = await checkReadiness();
  assert.ok(
    count() > callsAfterFirst,
    'a new probe round ran after the TTL elapsed',
  );
  assert.notEqual(afterExpiry.checked_at, first.checked_at);
});

test('the TTL is within the card bound', () => {
  assert.ok(READINESS_CACHE_TTL_MS > 0);
  assert.ok(READINESS_CACHE_TTL_MS <= 5000);
});

test('concurrent callers from a cold cache share exactly one probe round', async () => {
  const { count } = stubFetchCounting(() => cleanResponse(200));
  const checkReadiness = await freshCheckReadiness();

  const reports = await Promise.all(
    Array.from({ length: 6 }, () => checkReadiness()),
  );

  assert.equal(
    count(),
    1,
    'exactly one upstream round for six concurrent callers',
  );
  const checkedAts = new Set(reports.map(r => r.checked_at));
  assert.equal(checkedAts.size, 1, 'all six callers see the same report');
});

// ── Rollup values (crawl4ai unreachable throughout this file) ───────────

test('rollup is degraded when exactly one dependency is unhealthy', async () => {
  stubFetch(() => cleanResponse(200));
  const checkReadiness = await freshCheckReadiness();

  const report = await checkReadiness();

  assert.equal(report.dependencies.searxng.status, 'ok');
  assert.equal(report.dependencies.crawl4ai.status, 'unhealthy');
  assert.equal(report.status, 'degraded');
});

test('rollup is unhealthy when no dependency is reachable', async () => {
  stubFetch(() => cleanResponse(503));
  const checkReadiness = await freshCheckReadiness();

  const report = await checkReadiness();

  assert.equal(report.dependencies.searxng.status, 'unhealthy');
  assert.equal(report.dependencies.crawl4ai.status, 'unhealthy');
  assert.equal(report.status, 'unhealthy');
});

// ── Closed detail set ─────────────────────────────────────────────────

test('every unhealthy detail matches the closed set', async () => {
  stubFetch(() => cleanResponse(503));
  const checkReadiness = await freshCheckReadiness();

  const report = await checkReadiness();

  for (const dep of Object.values(report.dependencies)) {
    if (dep.status === 'unhealthy') {
      assert.match(dep.detail ?? '', DETAIL_PATTERN);
    } else {
      assert.equal(dep.detail, undefined);
    }
  }
});

test('checked_at parses as a valid ISO-8601 date and latency_ms is a non-negative integer', async () => {
  stubFetch(() => cleanResponse(200));
  const checkReadiness = await freshCheckReadiness();

  const report = await checkReadiness();

  assert.ok(!Number.isNaN(Date.parse(report.checked_at)));
  for (const dep of Object.values(report.dependencies)) {
    assert.ok(Number.isInteger(dep.latency_ms));
    assert.ok(dep.latency_ms >= 0);
  }
});

// ── The raw MCP client stays private ─────────────────────────────────

test('getClient and the raw Client are never part of the toolkit public exports', () => {
  const indexKeys = Object.keys(toolkitIndex);
  assert.ok(!indexKeys.includes('getClient'));
  assert.ok(!indexKeys.includes('Client'));

  const crawl4aiKeys = Object.keys(crawl4aiModule);
  assert.ok(!crawl4aiKeys.includes('getClient'));
  assert.ok(!crawl4aiKeys.includes('Client'));
  assert.ok(crawl4aiKeys.includes('probeCrawl4AI'));
  assert.ok(indexKeys.includes('checkReadiness'));
});
