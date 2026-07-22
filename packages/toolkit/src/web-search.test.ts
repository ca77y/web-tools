/**
 * QA gap-filling tests for the search failure/empty distinction.
 *
 * The coder's `searxng.test.ts` covers `searchSearXNG` scenario-by-scenario.
 * This file covers what those tests do not:
 *   - the actual tool entrypoint (`web_search` / `functionMap.web_search`),
 *     which is the code path MCP, REST, and the CLI all call;
 *   - the public entry point export surface (`./index.js`);
 *   - the structured per-attempt logging requirement (untested until now);
 *   - request-shape and secret-safety checks;
 *   - edge cases the spec implies (default limit, whitespace-only content,
 *     a genuine runtime-produced timeout rejection).
 *
 * Transport adapters (`packages/api`, `packages/cli`) are not imported
 * here: this file covers the toolkit-side contract (the error/empty shape
 * every transport consumes), while `packages/api/src/{mcp,handler}.test.ts`
 * and `packages/cli/src/search.test.ts` exercise the adapters themselves
 * against their own real registration/handler code.
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import { afterEach, describe, test } from 'node:test';

import { functionMap, web_search } from './functions.js';
import { SearchProviderError as SearchProviderErrorFromEntry } from './index.js';
import { SearchProviderError } from './searxng.js';
import { getStats } from './stats.js';

const originalFetch = globalThis.fetch;
const originalStderrWrite = process.stderr.write.bind(process.stderr);

function result(url: string, title = 'Title', content = '') {
  return { url, title, content };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Per-attempt fetch stub; the responder receives the real (url, init) args. */
function stubFetch(
  responders: Array<
    (url: string, init?: RequestInit) => Response | Promise<Response>
  >,
): void {
  let call = 0;
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const responder = responders[call] ?? responders[responders.length - 1];
    call++;
    if (!responder) throw new Error('no responder configured');
    return responder(String(input), init);
  }) as typeof fetch;
}

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

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.stderr.write = originalStderrWrite;
});

describe('web_search tool entrypoint - error and success propagation', () => {
  test('returns a bare SearchResult[] (not a {data} envelope) on success', async () => {
    stubFetch([
      () =>
        jsonResponse({ results: [result('https://a.example', 'A', 'body')] }),
    ]);

    const results = await web_search({ query: 'q' });

    assert.ok(Array.isArray(results), 'web_search must resolve a bare array');
    assert.equal(results.length, 1);
    assert.deepEqual(results[0], {
      url: 'https://a.example',
      title: 'A',
      description: 'body',
    });
  });

  test('propagates SearchProviderError unmodified when every attempt fails', async () => {
    stubFetch([
      () => jsonResponse({}, 503),
      () => Promise.reject(new TypeError('fetch failed')),
      () => Promise.reject(new DOMException('aborted', 'TimeoutError')),
    ]);

    await assert.rejects(web_search({ query: 'q' }), (err: unknown) => {
      assert.ok(
        err instanceof SearchProviderError,
        'web_search must not swallow or rewrap',
      );
      assert.equal((err as Error).name, 'SearchProviderError');
      assert.equal((err as SearchProviderError).reasons.length, 3);
      return true;
    });
  });

  test('resolves an empty array (no error) on a genuine empty result', async () => {
    stubFetch([() => jsonResponse({ results: [] })]);

    const results = await web_search({ query: 'q' });

    assert.deepEqual(results, []);
  });

  test('functionMap.web_search - the path MCP and REST both call - propagates the error', async () => {
    const handler = functionMap.web_search;
    assert.ok(handler, 'functionMap must expose web_search');

    stubFetch([() => jsonResponse({}, 503)]);

    await assert.rejects(handler({ query: 'q' }), (err: unknown) => {
      assert.ok(err instanceof SearchProviderError);
      return true;
    });
  });

  test('functionMap.web_search resolves an empty array on a genuine empty result', async () => {
    const handler = functionMap.web_search;
    assert.ok(handler);
    stubFetch([() => jsonResponse({ results: [] })]);

    assert.deepEqual(await handler({ query: 'q' }), []);
  });

  test('a total failure is still recorded in /stats before the error is rethrown', async () => {
    const before = getStats();
    const webSearchBefore = before.by_tool.web_search;
    assert.ok(webSearchBefore, 'getStats must report a web_search entry');
    const callsBefore = webSearchBefore.calls;
    const errorsBefore = webSearchBefore.errors;

    stubFetch([
      () => jsonResponse({}, 503),
      () => jsonResponse({}, 503),
      () => jsonResponse({}, 503),
    ]);

    await assert.rejects(web_search({ query: 'q' }), SearchProviderError);

    const after = getStats();
    const webSearchAfter = after.by_tool.web_search;
    assert.ok(webSearchAfter, 'getStats must report a web_search entry');
    assert.equal(
      webSearchAfter.calls,
      callsBefore + 1,
      'a total failure must still count as a call, not vanish from /stats',
    );
    assert.equal(
      webSearchAfter.errors,
      errorsBefore + 1,
      'a total failure must be recorded as an error',
    );
    assert.equal(
      after.total_errors,
      before.total_errors + 1,
      'total_errors must reflect the failed search',
    );
  });
});

describe('public entry point export surface', () => {
  test('SearchProviderError exported from ./index.js is the same class thrown by web_search', async () => {
    assert.equal(SearchProviderErrorFromEntry, SearchProviderError);

    stubFetch([() => jsonResponse({}, 503)]);

    await assert.rejects(web_search({ query: 'q' }), (err: unknown) => {
      assert.ok(
        err instanceof SearchProviderErrorFromEntry,
        'a consumer importing from the package entry point must be able to discriminate',
      );
      assert.ok(err instanceof Error, 'must remain a real Error subclass');
      return true;
    });
  });

  test('index.ts does not re-export test modules', async () => {
    const entry = (await import('./index.js')) as Record<string, unknown>;
    for (const name of Object.keys(entry)) {
      assert.ok(
        !/test/i.test(name),
        `unexpected test-ish export from entry point: ${name}`,
      );
    }
  });
});

describe('structured per-attempt logging', () => {
  test('emits exactly one single-line JSON outcome record per attempt', async () => {
    stubFetch([
      () =>
        jsonResponse({ results: [result('https://a.example', 'A', 'body')] }),
      () => jsonResponse({ results: [] }),
      () => jsonResponse({}, 503),
    ]);

    const { lines } = await captureStderr(() => web_search({ query: 'q' }));
    const records = lines
      .map(line => JSON.parse(line) as Record<string, unknown>)
      .filter(r => r.event === 'searxng_attempt_outcome');

    assert.equal(records.length, 3, 'one record per parallel attempt');
    assert.deepEqual(
      records.map(r => r.attempt).sort(),
      [1, 2, 3],
      'each attempt is numbered exactly once',
    );
    assert.deepEqual(
      new Set(records.map(r => r.outcome)),
      new Set(['ok', 'empty', 'error']),
    );
  });

  test('ok records carry result counts; failed records carry the safe reason', async () => {
    stubFetch([
      () =>
        jsonResponse({
          results: [
            result('https://a.example', 'A', 'body'),
            result('https://b.example', 'B', 'x'),
          ],
        }),
      () => jsonResponse({}, 429),
      () => jsonResponse({}, 429),
    ]);

    const { lines } = await captureStderr(() => web_search({ query: 'q' }));
    const records = lines.map(
      line => JSON.parse(line) as Record<string, unknown>,
    );

    const ok = records.find(r => r.outcome === 'ok');
    assert.ok(ok, 'expected an ok record');
    assert.equal(ok.results, 2);
    assert.equal(ok.hasContent, true);

    const failed = records.find(r => r.outcome === 'error');
    assert.ok(failed, 'expected a failed record');
    assert.deepEqual(failed.reason, { cause: 'http_status', status: 429 });
  });

  test('every emitted line is valid single-line JSON (machine-parseable)', async () => {
    stubFetch([() => jsonResponse({ results: [] })]);

    const { lines } = await captureStderr(() => web_search({ query: 'q' }));

    assert.ok(lines.length > 0);
    for (const line of lines) {
      assert.doesNotThrow(() => JSON.parse(line), `not valid JSON: ${line}`);
      assert.ok(!line.includes('\n'), 'records must be single-line');
    }
  });

  test('log lines contain no API key and no raw upstream response body', async () => {
    const secretBody = 'sk-super-secret-should-never-be-logged';
    stubFetch([
      () => new Response(secretBody, { status: 500 }),
      () => new Response(secretBody, { status: 500 }),
      () => new Response(secretBody, { status: 500 }),
    ]);

    const { lines, error } = await captureStderr(() =>
      web_search({ query: 'q' }),
    );

    assert.ok(
      error instanceof SearchProviderError,
      'expected the total-failure error',
    );
    const joined = lines.join('\n');
    assert.ok(
      !joined.includes(secretBody),
      'raw upstream body leaked into logs',
    );
    assert.ok(!joined.includes('test-key'), 'API key leaked into logs');
  });
});

describe('outbound request shape', () => {
  test('requests JSON format, carries the query, and forwards the engines option', async () => {
    const seen: string[] = [];
    stubFetch([
      url => {
        seen.push(url);
        return jsonResponse({ results: [] });
      },
    ]);

    await web_search({ query: 'hello world', engines: 'duckduckgo,brave' });

    assert.equal(seen.length, 3, 'one request per parallel attempt');
    for (const url of seen) {
      const parsed = new URL(url);
      assert.equal(parsed.pathname, '/search');
      assert.equal(parsed.searchParams.get('format'), 'json');
      assert.equal(parsed.searchParams.get('q'), 'hello world');
      assert.equal(parsed.searchParams.get('engines'), 'duckduckgo,brave');
    }
  });

  test('outbound URL never carries the API key', async () => {
    const seen: string[] = [];
    stubFetch([
      url => {
        seen.push(url);
        return jsonResponse({ results: [] });
      },
    ]);

    await web_search({ query: 'q' });

    for (const url of seen) {
      assert.ok(
        !url.includes('test-key'),
        'API key must not be sent to SearXNG',
      );
    }
  });
});

describe('edge cases', () => {
  test('default limit of 10 truncates a larger result set', async () => {
    const many = Array.from({ length: 25 }, (_, i) =>
      result(`https://r${i}.example`, `R${i}`, 'body'),
    );
    stubFetch([() => jsonResponse({ results: many })]);

    const results = await web_search({ query: 'q' });

    assert.equal(results.length, 10);
    assert.equal(results[0]?.url, 'https://r0.example');
    assert.equal(results[9]?.url, 'https://r9.example');
  });

  test('a limit larger than the result set returns everything without padding', async () => {
    stubFetch([
      () =>
        jsonResponse({
          results: [
            result('https://a.example', 'A', 'x'),
            result('https://b.example', 'B', 'y'),
          ],
        }),
    ]);

    const results = await web_search({ query: 'q', limit: 50 });

    assert.equal(results.length, 2);
  });

  test('whitespace-only content does not count as content-bearing', async () => {
    stubFetch([
      () =>
        jsonResponse({
          results: [result('https://whitespace.example', 'WS', '   \n\t ')],
        }),
      () =>
        jsonResponse({
          results: [result('https://real-content.example', 'Real', 'body')],
        }),
      () => jsonResponse({ results: [] }),
    ]);

    const results = await web_search({ query: 'q' });

    assert.equal(
      results[0]?.url,
      'https://real-content.example',
      'the whitespace-only attempt must not short-circuit as content-bearing',
    );
  });

  test('results with content but a missing url are dropped by dedup/validation', async () => {
    stubFetch([
      () =>
        jsonResponse({
          results: [
            result('https://good.example', 'Good', 'body'),
            { title: 'No URL', url: '', content: 'body' },
          ],
        }),
    ]);

    const results = await web_search({ query: 'q' });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.url, 'https://good.example');
  });

  test('a genuinely runtime-produced timeout rejection is classified as a timeout', async () => {
    // Exercise the real rejection object `fetch` + AbortSignal.timeout produce
    // against a socket that never responds, rather than a hand-constructed
    // DOMException — this is what proves the `instanceof DOMException &&
    // name === 'TimeoutError'` check holds against the runtime.
    const server = http.createServer(() => {
      /* deliberately never responds */
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address && typeof address === 'object');
    const port = address.port;

    globalThis.fetch = (async () =>
      originalFetch(`http://127.0.0.1:${port}/`, {
        signal: AbortSignal.timeout(150),
      })) as typeof fetch;

    try {
      await assert.rejects(web_search({ query: 'q' }), (err: unknown) => {
        assert.ok(err instanceof SearchProviderError);
        for (const reason of (err as SearchProviderError).reasons) {
          assert.equal(reason.cause, 'timeout');
        }
        return true;
      });
    } finally {
      server.close();
    }
  });
});

describe('transport payload safety (toolkit-side contract)', () => {
  test('the error message survives the JSON envelope MCP and REST build, secret-free', async () => {
    const secretBody = 'sk-secret-body-that-must-not-reach-a-client';
    stubFetch([
      () => new Response(secretBody, { status: 502 }),
      () => new Response(secretBody, { status: 502 }),
      () => new Response(secretBody, { status: 502 }),
    ]);

    await assert.rejects(web_search({ query: 'q' }), (err: unknown) => {
      assert.ok(err instanceof SearchProviderError);
      const message = (err as Error).message;

      // MCP does JSON.stringify({ error: message }); REST does res.json({ error: message }).
      const envelope = JSON.stringify({ error: message });
      assert.ok(
        message.length > 0,
        'message must be non-empty for the transports to report',
      );
      assert.match(
        message,
        /search/i,
        'message must name the failed search operation',
      );
      assert.ok(
        !envelope.includes(secretBody),
        'raw upstream body must not reach a client',
      );
      assert.ok(
        !envelope.includes('test-key'),
        'API key must not reach a client',
      );
      return true;
    });
  });
});
