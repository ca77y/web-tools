/**
 * Exercises `checkReadiness()` (readiness.ts) directly: the SearXNG
 * verdict rule, the per-probe timeout bound (both probeSearXNG's own
 * AbortSignal-based timeout and readiness.ts's own outer backstop race),
 * the TTL cache / single-flight behaviour, the rollup, and the closed
 * detail set.
 *
 * Crawl4AI is never genuinely *reachable* in this file: its probe target
 * is a synthetic `fetch` stub, and building a fake MCP SSE peer that can
 * answer `tools/list` needs a real server (covered in
 * `packages/api/src/ready.test.ts` and
 * `packages/toolkit/src/crawl4ai-probe.test.ts`). Most scenarios here
 * route Crawl4AI to a clean, immediately resolved non-2xx response
 * (`stubFetch`'s default) since they only care that it is *not ok*, not
 * how it failed.
 *
 * The reconnect-loop scenario below is the exception: it deliberately
 * routes Crawl4AI's fetch to a genuine rejection (`stubFetchBoth`), the
 * production path a refused connection actually takes. Before
 * `resetClient()` existed (see `crawl4ai.ts`'s post-integration-review
 * amendment), that path made `eventsource`'s internal reconnect loop run
 * every ~3s *forever* with no way to stop it, so this file avoided it
 * entirely to keep `node --test` from hanging. `resetClient()` now closes
 * the abandoned transport on every `probeCrawl4AI` failure branch,
 * including a connect-level timeout, so this is safe to exercise
 * directly.
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
 * Routes every `fetch` call to one of two independently controllable
 * responders: a request to SearXNG's `/healthz` probe path goes to
 * `searxngResponder`; everything else (Crawl4AI's MCP SSE probe, which
 * also goes through `fetch` via its `eventSourceInit.fetch` hook) goes to
 * `crawl4aiResponder`.
 */
function stubFetchBoth(
  searxngResponder: (init?: RequestInit) => Response | Promise<Response>,
  crawl4aiResponder: (init?: RequestInit) => Response | Promise<Response>,
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
    return crawl4aiResponder(init);
  }) as typeof fetch;
}

/**
 * `stubFetchBoth` with Crawl4AI routed to an immediate, clean 404 — see
 * the file header for why most scenarios here don't care how Crawl4AI
 * fails, just that it isn't `ok`.
 */
function stubFetch(
  searxngResponder: (init?: RequestInit) => Response | Promise<Response>,
): void {
  stubFetchBoth(searxngResponder, () => cleanResponse(404));
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

test('SearXNG probe: a response.body.cancel() failure does not change an already-decided ok verdict', async () => {
  // A hand-built stand-in, not a real Response: probeSearXNG only reads
  // `.status` and calls `.body?.cancel()`, and this needs that call to
  // throw *after* the verdict is already computed from `.status` — a real
  // Response's body.cancel() has no reliable way to be made to throw from
  // a test.
  stubFetch(
    () =>
      ({
        status: 200,
        body: {
          cancel: () => {
            throw new Error('cancel failed');
          },
        },
      }) as unknown as Response,
  );
  const checkReadiness = await freshCheckReadiness();

  const report = await checkReadiness();

  assert.equal(
    report.dependencies.searxng.status,
    'ok',
    'a cancel() failure must not override a verdict already decided from the response status',
  );
  assert.equal(report.dependencies.searxng.detail, undefined);
});

test('SearXNG probe: a response.body.cancel() failure does not change an already-decided unhealthy verdict', async () => {
  stubFetch(
    () =>
      ({
        status: 503,
        body: {
          cancel: () => {
            throw new Error('cancel failed');
          },
        },
      }) as unknown as Response,
  );
  const checkReadiness = await freshCheckReadiness();

  const report = await checkReadiness();

  assert.equal(report.dependencies.searxng.status, 'unhealthy');
  assert.equal(
    report.dependencies.searxng.detail,
    'http_status:503',
    'a cancel() failure must not override the http_status detail already decided',
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

// ── Amendment: an outage does not accumulate reconnect loops ───────────
// (packages/toolkit/src/crawl4ai.ts's `resetClient()`, added after
// integration review — see the spec's post-integration-review amendment)

test('a genuinely refused Crawl4AI connection stays bounded across several expired TTL windows: no accumulating reconnect loop', async () => {
  let crawl4aiAttempts = 0;
  stubFetchBoth(
    () => cleanResponse(200),
    () => {
      crawl4aiAttempts++;
      // A genuine rejection, not a clean HTTP response: the production
      // path a refused connection actually takes, and the one that drove
      // `eventsource`'s reconnect-forever loop before `resetClient()`
      // existed (see the file header).
      return Promise.reject(new TypeError('fetch failed'));
    },
  );
  const checkReadiness = await freshCheckReadiness();

  const rounds = 3;
  for (let i = 0; i < rounds; i++) {
    const report = await checkReadiness();
    assert.equal(report.dependencies.crawl4ai.status, 'unhealthy');
    if (i < rounds - 1) {
      await new Promise(resolve =>
        setTimeout(resolve, READINESS_CACHE_TTL_MS + 250),
      );
    }
  }

  const attemptsAfterRounds = crawl4aiAttempts;
  assert.ok(
    attemptsAfterRounds >= rounds && attemptsAfterRounds <= rounds + 1,
    `expected connection attempts bounded by the number of TTL rounds, not runaway retries; got ${attemptsAfterRounds} for ${rounds} rounds`,
  );

  // eventsource's default reconnect interval is ~3s. If resetClient() had
  // failed to close what a failed connect abandoned, an orphaned client
  // would still be quietly retrying here, growing the count with no
  // further checkReadiness() call from this test.
  await new Promise(resolve => setTimeout(resolve, 3200));
  assert.equal(
    crawl4aiAttempts,
    attemptsAfterRounds,
    'no further connection attempts after the probes stopped: no orphaned reconnect loop',
  );
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
