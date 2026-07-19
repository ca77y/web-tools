import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { SearchProviderError, searchSearXNG } from './searxng.js';

const originalFetch = globalThis.fetch;

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

  test('non-empty unresponsive_engines with no explicit engines requested cannot be verified, stays empty', async () => {
    // No `engines` option is passed below, and `Config` is read once at
    // module load, so this test's premise depends on SEARXNG_ENGINES being
    // unset/empty in the environment `pnpm test` runs in (pinned via
    // `SEARXNG_ENGINES=` in this package's `test` script alongside
    // `API_KEY=test-key`, precisely so a developer's ambient shell env
    // can't flip this test red on correct code). With no requested-engine
    // roster known, the signal is unverifiable and must not promote to
    // `failed`.
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

    const { data } = await searchSearXNG('q');

    assert.deepEqual(data, []);
  });

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
