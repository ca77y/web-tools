import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { Config } from './config.js';
import { MAX_ARRAY_ITEMS } from './logging.js';
import { SearchProviderError, searchSearXNG } from './searxng.js';

const originalFetch = globalThis.fetch;
const originalStderrWrite = process.stderr.write.bind(process.stderr);

/** Captures every line written to stderr while `fn` runs. */
async function captureStderr<T>(
  fn: () => Promise<T>,
): Promise<{ lines: string[]; error?: unknown }> {
  const chunks: string[] = [];
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  let error: unknown;
  try {
    await fn();
  } catch (err) {
    error = err;
  } finally {
    process.stderr.write = originalStderrWrite;
  }
  return { lines: chunks.join('').split('\n').filter(Boolean), error };
}

/** Parses every captured line as JSON. */
function parseAll(lines: string[]): Record<string, unknown>[] {
  return lines.map(line => JSON.parse(line) as Record<string, unknown>);
}

/** A minimal, well-formed SearXNG-shaped result. */
function result(url: string, title = 'Title', content = '') {
  return { url, title, content };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Asserts a caught rejection is the toolkit's typed error and returns it typed. */
function assertSearchProviderError(err: unknown): SearchProviderError {
  assert.ok(
    err instanceof SearchProviderError,
    'expected a SearchProviderError',
  );
  return err as SearchProviderError;
}

/**
 * Stubs `globalThis.fetch` so the Nth call (0-indexed, one per parallel
 * SearXNG attempt) is served by the Nth responder. All three attempts fire
 * near-simultaneously and, since every responder here settles synchronously
 * with no injected delay, they resolve in call order — matching the
 * previous implicit ordering the aggregation logic already relied on.
 */
function stubFetch(
  responders: Array<() => Response | Promise<Response>>,
): void {
  let call = 0;
  globalThis.fetch = (async () => {
    const responder = responders[call] ?? responders[responders.length - 1];
    call++;
    if (!responder) throw new Error('no responder configured');
    return responder();
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.stderr.write = originalStderrWrite;
});

describe('searchSearXNG - per-attempt outcome classification', () => {
  test('successful response with results resolves with those results', async () => {
    stubFetch([
      () =>
        jsonResponse({ results: [result('https://a.example', 'A', 'body')] }),
      () =>
        jsonResponse({ results: [result('https://a.example', 'A', 'body')] }),
      () =>
        jsonResponse({ results: [result('https://a.example', 'A', 'body')] }),
    ]);

    const { data } = await searchSearXNG('q');

    assert.equal(data.length, 1);
    assert.equal(data[0]?.url, 'https://a.example');
  });

  test('genuine empty result (HTTP 200, empty results array) classified empty', async () => {
    stubFetch([
      () => jsonResponse({ results: [] }),
      () => jsonResponse({ results: [] }),
      () => jsonResponse({ results: [] }),
    ]);

    const { data } = await searchSearXNG('q');

    assert.deepEqual(data, []);
  });

  test('entries missing title or url do not count as valid, still classified empty', async () => {
    stubFetch([
      () =>
        jsonResponse({
          results: [{ url: 'https://missing-title.example', title: '' }],
        }),
      () => jsonResponse({ results: [{ title: 'missing-url', url: '' }] }),
      () => jsonResponse({ results: [] }),
    ]);

    const { data } = await searchSearXNG('q');

    assert.deepEqual(data, []);
  });

  test('non-2xx upstream status (all attempts) is classified failed with http_status reason and throws', async () => {
    stubFetch([
      () => jsonResponse({}, 503),
      () => jsonResponse({}, 429),
      () => jsonResponse({}, 503),
    ]);

    await assert.rejects(searchSearXNG('q'), (err: unknown) => {
      const spErr = assertSearchProviderError(err);
      assert.equal(spErr.reasons.length, 3);
      for (const reason of spErr.reasons) {
        assert.equal(reason.cause, 'http_status');
      }
      const statuses = spErr.reasons.map(r =>
        r.cause === 'http_status' ? r.status : undefined,
      );
      assert.ok(statuses.includes(503));
      assert.ok(statuses.includes(429));
      return true;
    });
  });

  test('unparseable response body (all attempts) is classified failed, distinguishable from an HTTP-status failure', async () => {
    stubFetch([
      () => new Response('not json', { status: 200 }),
      () => new Response('not json', { status: 200 }),
      () => new Response('not json', { status: 200 }),
    ]);

    await assert.rejects(searchSearXNG('q'), (err: unknown) => {
      const spErr = assertSearchProviderError(err);
      for (const reason of spErr.reasons) {
        assert.equal(reason.cause, 'invalid_response');
        assert.notEqual(reason.cause, 'http_status');
      }
      return true;
    });
  });

  test('well-formed JSON with an unexpected shape (results absent or not an array) is classified failed, not empty', async () => {
    stubFetch([
      () => jsonResponse({ notResults: true }),
      () => jsonResponse({ results: 'not-an-array' }),
      () => jsonResponse({}),
    ]);

    await assert.rejects(searchSearXNG('q'), (err: unknown) => {
      const spErr = assertSearchProviderError(err);
      for (const reason of spErr.reasons) {
        assert.equal(reason.cause, 'invalid_response');
      }
      return true;
    });
  });

  test('network error (all attempts) is classified failed, distinguishable from a timeout', async () => {
    stubFetch([
      () => Promise.reject(new TypeError('fetch failed')),
      () => Promise.reject(new TypeError('fetch failed')),
      () => Promise.reject(new TypeError('fetch failed')),
    ]);

    await assert.rejects(searchSearXNG('q'), (err: unknown) => {
      const spErr = assertSearchProviderError(err);
      for (const reason of spErr.reasons) {
        assert.equal(reason.cause, 'network_error');
        assert.notEqual(reason.cause, 'timeout');
      }
      return true;
    });
  });

  test('timeout abort (all attempts) is classified failed as a timeout, distinguishable from a generic network error', async () => {
    stubFetch([
      () =>
        Promise.reject(
          new DOMException('The operation was aborted', 'TimeoutError'),
        ),
      () =>
        Promise.reject(
          new DOMException('The operation was aborted', 'TimeoutError'),
        ),
      () =>
        Promise.reject(
          new DOMException('The operation was aborted', 'TimeoutError'),
        ),
    ]);

    await assert.rejects(searchSearXNG('q'), (err: unknown) => {
      const spErr = assertSearchProviderError(err);
      for (const reason of spErr.reasons) {
        assert.equal(reason.cause, 'timeout');
        assert.notEqual(reason.cause, 'network_error');
      }
      return true;
    });
  });
});

describe('searchSearXNG - all-engines-failed detection (unresponsive_engines)', () => {
  test('zero valid results plus every requested engine unresponsive classifies failed, not empty', async () => {
    // All three attempts report BOTH requested engines (google, bing) as
    // unresponsive, so "every engine that ran" is fully explained by
    // failure for each attempt.
    stubFetch([
      () =>
        jsonResponse({
          results: [],
          unresponsive_engines: [
            ['google', 'HTTP error'],
            ['bing', 'Timeout'],
          ],
        }),
      () =>
        jsonResponse({
          results: [],
          unresponsive_engines: [
            ['bing', 'Timeout'],
            ['google', 'HTTP error'],
          ],
        }),
      () =>
        jsonResponse({
          results: [],
          unresponsive_engines: [
            ['google', 'HTTP error'],
            ['bing', 'Timeout'],
          ],
        }),
    ]);

    await assert.rejects(
      searchSearXNG('q', { engines: 'google,bing' }),
      (err: unknown) => {
        const spErr = assertSearchProviderError(err);
        for (const reason of spErr.reasons) {
          assert.equal(reason.cause, 'all_engines_unresponsive');
        }
        return true;
      },
    );
  });

  test('only SOME requested engines unresponsive (others simply matched nothing) stays empty, not failed', async () => {
    // Only "bing" is reported unresponsive on every attempt; "google" was
    // requested too but isn't listed, meaning it ran and genuinely found
    // nothing. Zero results here is not fully explained by failure, so
    // this must not be promoted to `failed`.
    stubFetch([
      () =>
        jsonResponse({
          results: [],
          unresponsive_engines: [['bing', 'Timeout']],
        }),
      () =>
        jsonResponse({
          results: [],
          unresponsive_engines: [['bing', 'Timeout']],
        }),
      () =>
        jsonResponse({
          results: [],
          unresponsive_engines: [['bing', 'Timeout']],
        }),
    ]);

    const { data } = await searchSearXNG('q', { engines: 'google,bing' });

    assert.deepEqual(data, []);
  });

  test('non-empty unresponsive_engines with no explicit engine list requested classifies failed (default-deployment outage detection)', async () => {
    // No `engines` option is passed below, and `Config` is read once at
    // module load, so this test's premise depends on SEARXNG_ENGINES being
    // unset/empty in the environment `pnpm test` runs in (pinned via
    // `SEARXNG_ENGINES=` in this package's `test` script alongside
    // `API_KEY=test-key`, precisely so a developer's ambient shell env
    // can't flip this test red on correct code). With no requested-engine
    // roster known, the full "every requested engine unresponsive" rule
    // can never fire, so per the amended spec any non-empty
    // unresponsive_engines is treated as sufficient evidence of failure —
    // this is the exact shape of the Railway 2026-07-17/18 incident.
    stubFetch([
      () =>
        jsonResponse({
          results: [],
          unresponsive_engines: [['google', 'HTTP error']],
        }),
      () =>
        jsonResponse({
          results: [],
          unresponsive_engines: [['google', 'HTTP error']],
        }),
      () =>
        jsonResponse({
          results: [],
          unresponsive_engines: [['google', 'HTTP error']],
        }),
    ]);

    await assert.rejects(searchSearXNG('q'), (err: unknown) => {
      const spErr = assertSearchProviderError(err);
      for (const reason of spErr.reasons) {
        assert.equal(reason.cause, 'all_engines_unresponsive');
      }
      return true;
    });
  });

  // The spec's "Partial engine failure with an explicit engine list"
  // scenario (empty, not failed, when only some requested engines are
  // unresponsive) is already covered above by "only SOME requested
  // engines unresponsive (others simply matched nothing) stays empty, not
  // failed" — no separate test needed.

  test('missing unresponsive_engines field falls back to empty classification without error', async () => {
    stubFetch([
      () => jsonResponse({ results: [] }),
      () => jsonResponse({ results: [] }),
      () => jsonResponse({ results: [] }),
    ]);

    const { data } = await searchSearXNG('q');

    assert.deepEqual(data, []);
  });

  test('malformed unresponsive_engines field is treated as not-reported, not an error', async () => {
    stubFetch([
      () => jsonResponse({ results: [], unresponsive_engines: 'not-an-array' }),
      () =>
        jsonResponse({ results: [], unresponsive_engines: [123, null, {}] }),
      () => jsonResponse({ results: [], unresponsive_engines: [] }),
    ]);

    const { data } = await searchSearXNG('q');

    assert.deepEqual(data, []);
  });
});

describe('searchSearXNG - total-failure error propagation', () => {
  test('every attempt failed raises the typed error with an actionable, summarized message', async () => {
    stubFetch([
      () => jsonResponse({}, 503),
      () => Promise.reject(new TypeError('fetch failed')),
      () => Promise.reject(new DOMException('aborted', 'TimeoutError')),
    ]);

    await assert.rejects(searchSearXNG('q'), (err: unknown) => {
      const spErr = assertSearchProviderError(err);
      assert.match(spErr.message, /SearXNG search failed/i);
      assert.match(spErr.message, /3/);
      const causes = new Set(spErr.reasons.map(r => r.cause));
      assert.equal(causes.size, 3);
      assert.ok(causes.has('http_status'));
      assert.ok(causes.has('network_error'));
      assert.ok(causes.has('timeout'));
      return true;
    });
  });

  test('all attempts empty resolves successfully with an empty array and raises no error', async () => {
    stubFetch([
      () => jsonResponse({ results: [] }),
      () => jsonResponse({ results: [] }),
      () => jsonResponse({ results: [] }),
    ]);

    const { data } = await searchSearXNG('q');

    assert.deepEqual(data, []);
  });

  test('mixed empty and failed (no success) resolves successfully with an empty array', async () => {
    stubFetch([
      () => jsonResponse({ results: [] }),
      () => jsonResponse({}, 500),
      () => Promise.reject(new DOMException('aborted', 'TimeoutError')),
    ]);

    const { data } = await searchSearXNG('q');

    assert.deepEqual(data, []);
  });

  test('partial failure with one success resolves successfully with the ok results', async () => {
    stubFetch([
      () => jsonResponse({}, 500),
      () => jsonResponse({ results: [result('https://b.example', 'B')] }),
      () => Promise.reject(new TypeError('fetch failed')),
    ]);

    const { data } = await searchSearXNG('q');

    assert.equal(data.length, 1);
    assert.equal(data[0]?.url, 'https://b.example');
  });

  test('existing selection behavior preserved: content-bearing attempt wins over a no-content attempt', async () => {
    stubFetch([
      () =>
        jsonResponse({
          results: [result('https://no-content.example', 'NoContent', '')],
        }),
      () =>
        jsonResponse({
          results: [
            result(
              'https://with-content.example',
              'WithContent',
              'has body text',
            ),
          ],
        }),
      () => jsonResponse({ results: [] }),
    ]);

    const { data } = await searchSearXNG('q');

    assert.equal(data.length, 1);
    assert.equal(data[0]?.url, 'https://with-content.example');
  });

  test('existing selection behavior preserved: first attempt with any results wins when none have content', async () => {
    stubFetch([
      () =>
        jsonResponse({
          results: [result('https://first-no-content.example', 'First', '')],
        }),
      () => jsonResponse({}, 500),
      () =>
        jsonResponse({
          results: [result('https://second-no-content.example', 'Second', '')],
        }),
    ]);

    const { data } = await searchSearXNG('q');

    assert.equal(data.length, 1);
    assert.equal(data[0]?.url, 'https://first-no-content.example');
  });

  test('deduplication by URL and limit truncation are unchanged', async () => {
    stubFetch([
      () =>
        jsonResponse({
          results: [
            result('https://dup.example', 'Dup', 'c1'),
            result('https://dup.example', 'Dup again', 'c2'),
            result('https://c.example', 'C', 'c3'),
            result('https://d.example', 'D', 'c4'),
          ],
        }),
      () => jsonResponse({}, 500),
      () => Promise.reject(new TypeError('fetch failed')),
    ]);

    const { data } = await searchSearXNG('q', { limit: 2 });

    assert.equal(data.length, 2);
    assert.deepEqual(
      data.map(r => r.url),
      ['https://dup.example', 'https://c.example'],
    );
  });
});

describe('searchSearXNG - safe error content', () => {
  test('total-failure error message and reasons contain no secrets or raw upstream bodies', async () => {
    const sensitiveBody =
      'sk-super-secret-api-key-should-never-leak-in-error-text';
    stubFetch([
      () => new Response(sensitiveBody, { status: 500 }),
      () => new Response(sensitiveBody, { status: 502 }),
      () => new Response(sensitiveBody, { status: 503 }),
    ]);

    await assert.rejects(searchSearXNG('q'), (err: unknown) => {
      const spErr = assertSearchProviderError(err);
      assert.ok(!spErr.message.includes(sensitiveBody));
      assert.ok(!JSON.stringify(spErr.reasons).includes(sensitiveBody));
      return true;
    });
  });
});

describe('searchSearXNG - attribution: query, base URL, and status', () => {
  test('a failing attempt names the query, the configured base URL, and the HTTP status', async () => {
    stubFetch([
      () => jsonResponse({}, 503),
      () => jsonResponse({}, 503),
      () => jsonResponse({}, 503),
    ]);

    const { lines } = await captureStderr(() =>
      searchSearXNG('spec-probe-query').catch(() => undefined),
    );
    const attempts = parseAll(lines).filter(
      r => r.event === 'searxng_attempt_outcome',
    );

    assert.equal(attempts.length, Config.parallelRequests);
    for (const record of attempts) {
      assert.equal(record.query, 'spec-probe-query');
      assert.equal(record.baseUrl, Config.searxng.url);
      assert.equal(record.outcome, 'error');
      assert.equal(typeof record.durationMs, 'number');
      assert.equal(record.status, 503);
    }
  });

  test('a timeout omits status rather than inventing one, and carries cause "timeout"', async () => {
    stubFetch([
      () => Promise.reject(new DOMException('aborted', 'TimeoutError')),
      () => Promise.reject(new DOMException('aborted', 'TimeoutError')),
      () => Promise.reject(new DOMException('aborted', 'TimeoutError')),
    ]);

    const { lines } = await captureStderr(() =>
      searchSearXNG('q').catch(() => undefined),
    );
    const attempts = parseAll(lines).filter(
      r => r.event === 'searxng_attempt_outcome',
    );

    assert.equal(attempts.length, Config.parallelRequests);
    for (const record of attempts) {
      assert.equal(record.outcome, 'error');
      assert.equal(record.cause, 'timeout');
      assert.equal(
        'status' in record,
        false,
        'a timeout must not carry a status field',
      );
    }
  });
});

describe('searchSearXNG - the flattened `engines` and the nested `reason.engines` are both sanitized', () => {
  test('a large, secret-bearing unresponsive_engines list is capped and redacted identically in both places it is logged', async () => {
    // logAttemptOutcome deliberately surfaces the classification's engines
    // list twice: once flattened at the top level (record.engines) and
    // once nested inside the preserved `reason` object
    // (record.reason.engines) — the same underlying array, referenced from
    // two fields. Both must be capped to MAX_ARRAY_ITEMS and have any
    // embedded secret redacted; a fix that only touches the top-level copy
    // and skips values nested one level down leaves the nested copy raw
    // and uncapped.
    const manyEngines: Array<[string, string]> = Array.from(
      { length: 60 },
      (_, i) => [`engine-${i}`, 'HTTP error'],
    );
    manyEngines[10] = ['https://u:p@ex.com/x?token=SECRET0', 'HTTP error'];

    stubFetch([
      () => jsonResponse({ results: [], unresponsive_engines: manyEngines }),
      () => jsonResponse({ results: [], unresponsive_engines: manyEngines }),
      () => jsonResponse({ results: [], unresponsive_engines: manyEngines }),
    ]);

    const { lines } = await captureStderr(() =>
      searchSearXNG('q').catch(() => undefined),
    );

    for (const line of lines) {
      assert.ok(!line.includes('SECRET0'), `secret leaked: ${line}`);
      assert.ok(!line.includes('u:p@'), `credentials leaked: ${line}`);
    }

    const attempts = parseAll(lines).filter(
      r => r.event === 'searxng_attempt_outcome',
    );
    assert.ok(attempts.length > 0);
    for (const record of attempts) {
      const flatEngines = record.engines as string[];
      const nestedEngines = (record.reason as { engines: string[] }).engines;
      assert.ok(
        flatEngines.length <= MAX_ARRAY_ITEMS,
        `flattened engines not capped: ${flatEngines.length}`,
      );
      assert.ok(
        nestedEngines.length <= MAX_ARRAY_ITEMS,
        `nested reason.engines not capped: ${nestedEngines.length}`,
      );
    }
  });
});

describe('searchSearXNG - fan-out labelling', () => {
  test('the Config.parallelRequests copies of one search share a searchId and carry pairwise distinct attempts', async () => {
    stubFetch([
      () => jsonResponse({}, 500),
      () => jsonResponse({}, 500),
      () => jsonResponse({}, 500),
    ]);

    const { lines } = await captureStderr(() =>
      searchSearXNG('q').catch(() => undefined),
    );
    const attempts = parseAll(lines).filter(
      r => r.event === 'searxng_attempt_outcome',
    );

    assert.equal(attempts.length, Config.parallelRequests);
    const searchIds = new Set(attempts.map(r => r.searchId));
    assert.equal(
      searchIds.size,
      1,
      'all attempts of one search share one searchId',
    );
    const attemptNumbers = attempts.map(r => r.attempt).sort();
    assert.deepEqual(attemptNumbers, [1, 2, 3]);
  });

  test('two concurrent searches produce two distinct searchId groups, each with its own query', async () => {
    // Every attempt of every search fails identically; attribution here
    // relies purely on searchId grouping, not on response content, so the
    // outcome is deliberately order-independent.
    globalThis.fetch = (async () => jsonResponse({}, 500)) as typeof fetch;

    const { lines } = await captureStderr(async () => {
      await Promise.all([
        searchSearXNG('query-one').catch(() => undefined),
        searchSearXNG('query-two').catch(() => undefined),
      ]);
    });
    const attempts = parseAll(lines).filter(
      r => r.event === 'searxng_attempt_outcome',
    );

    assert.equal(attempts.length, Config.parallelRequests * 2);
    const bySearchId = new Map<string, Record<string, unknown>[]>();
    for (const record of attempts) {
      const id = record.searchId as string;
      const group = bySearchId.get(id) ?? [];
      group.push(record);
      bySearchId.set(id, group);
    }
    assert.equal(bySearchId.size, 2, 'exactly two distinct searchId groups');
    for (const group of bySearchId.values()) {
      assert.equal(group.length, Config.parallelRequests);
      const queries = new Set(group.map(r => r.query));
      assert.equal(queries.size, 1, 'each group carries one distinct query');
    }
    const groupQueries = new Set(
      [...bySearchId.values()].map(group => group[0]!.query),
    );
    assert.equal(groupQueries.size, 2);
  });
});

describe('searchSearXNG - search_complete summary', () => {
  test('one summary line per search states what the caller received, with the winning attempt and failed count', async () => {
    stubFetch([
      () =>
        jsonResponse({ results: [result('https://a.example', 'A', 'body')] }),
      () => jsonResponse({}, 500),
      () => jsonResponse({}, 502),
    ]);

    const { lines } = await captureStderr(() => searchSearXNG('q'));
    const summaries = parseAll(lines).filter(
      r => r.event === 'search_complete',
    );

    assert.equal(summaries.length, 1);
    const summary = summaries[0]!;
    assert.equal(summary.outcome, 'ok');
    assert.ok((summary.resultCount as number) > 0);
    assert.equal(summary.winningAttempt, 1);
    assert.equal(summary.failedAttempts, 2);
    assert.equal(typeof summary.durationMs, 'number');
  });

  test('a genuine empty search (HTTP 200, zero results, no unresponsive engines) summarizes as empty, not a failure', async () => {
    stubFetch([
      () => jsonResponse({ results: [] }),
      () => jsonResponse({ results: [] }),
      () => jsonResponse({ results: [] }),
    ]);

    const { lines } = await captureStderr(() => searchSearXNG('q'));
    const summaries = parseAll(lines).filter(
      r => r.event === 'search_complete',
    );

    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]!.outcome, 'empty');
    assert.equal(summaries[0]!.resultCount, 0);
  });

  test('a total search outage summarizes as an error and searchSearXNG still throws SearchProviderError unchanged', async () => {
    stubFetch([
      () => jsonResponse({}, 503),
      () => jsonResponse({}, 503),
      () => jsonResponse({}, 503),
    ]);

    const { lines, error } = await captureStderr(() => searchSearXNG('q'));
    const summaries = parseAll(lines).filter(
      r => r.event === 'search_complete',
    );

    assert.equal(summaries.length, 1);
    assert.equal(summaries[0]!.outcome, 'error');
    const spErr = assertSearchProviderError(error);
    assert.match(spErr.message, /SearXNG search failed/i);
    assert.equal(spErr.reasons.length, 3);
  });
});

describe('searchSearXNG - context-free correlation', () => {
  test('every record for a context-free call shares one requestId, and a second call gets a different one', async () => {
    stubFetch([
      () => jsonResponse({}, 500),
      () => jsonResponse({}, 500),
      () => jsonResponse({}, 500),
    ]);
    const { lines: firstLines } = await captureStderr(() =>
      searchSearXNG('q').catch(() => undefined),
    );
    const first = parseAll(firstLines);
    const firstIds = new Set(first.map(r => r.requestId));
    assert.equal(
      firstIds.size,
      1,
      'one call correlates all of its own records under one id',
    );

    stubFetch([
      () => jsonResponse({}, 500),
      () => jsonResponse({}, 500),
      () => jsonResponse({}, 500),
    ]);
    const { lines: secondLines } = await captureStderr(() =>
      searchSearXNG('q').catch(() => undefined),
    );
    const second = parseAll(secondLines);
    const secondIds = new Set(second.map(r => r.requestId));
    assert.equal(secondIds.size, 1);

    assert.notEqual([...firstIds][0], [...secondIds][0]);
  });
});

describe('client timeout budget vs the SearXNG service config', () => {
  /**
   * Mirrors `outgoing.max_request_timeout: 20.0` in
   * `services/searxng/settings.yml`, whose own `settings.test.mjs` asserts
   * that value is unchanged. Both sides are pinned so this pairing cannot
   * drift silently in either file.
   */
  const SEARXNG_MAX_REQUEST_TIMEOUT_SECONDS = 20;

  test("the per-search client budget outlives SearXNG's slowest permitted engine", () => {
    // SearXNG waits for its slowest engine before aggregating and returning
    // partial results. If this client aborts first, results that healthy
    // engines already produced are thrown away. Observed in production at
    // the previous value of 15, which exactly matched the service's
    // `outgoing.request_timeout: 15.0`: a `bing,duckduckgo` search returned
    // nothing while `bing` alone returned ten results.
    assert.ok(
      Config.requestTimeout > SEARXNG_MAX_REQUEST_TIMEOUT_SECONDS,
      `Config.requestTimeout (${Config.requestTimeout}s) must exceed SearXNG's ` +
        `max_request_timeout (${SEARXNG_MAX_REQUEST_TIMEOUT_SECONDS}s), or a single ` +
        'slow engine aborts the whole search client-side',
    );
  });
});
