/**
 * Covers the spec scenario "A context-free search still correlates":
 * `web_search` — the wrapped, exported tool function, not the bare
 * `searchSearXNG` — is called directly with no HTTP request in flight, and
 * every record it emits (each `searxng_attempt_outcome`, the
 * `search_complete` summary, and the `web_search` operation record itself)
 * must carry the same requestId. This lives in its own file, separate from
 * `web-search.test.ts`, because that file's assertions are restricted to
 * three permitted line edits and nothing else may be added to it.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';

import { web_search } from './functions.js';
import { SearchProviderError } from './searxng.js';

const originalFetch = globalThis.fetch;
const originalStderrWrite = process.stderr.write.bind(process.stderr);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubAllAttemptsFail(status = 503): void {
  globalThis.fetch = (async () => jsonResponse({}, status)) as typeof fetch;
}

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

describe('web_search - context-free correlation', () => {
  test('every record from one context-free web_search call shares its requestId', async () => {
    stubAllAttemptsFail();

    const { lines, error } = await captureStderr(() =>
      web_search({ query: 'q' }),
    );
    assert.ok(
      error instanceof SearchProviderError,
      'expected the total-failure error',
    );

    const records = lines.map(
      line => JSON.parse(line) as Record<string, unknown>,
    );
    const attempts = records.filter(r => r.event === 'searxng_attempt_outcome');
    const summaries = records.filter(r => r.event === 'search_complete');
    const toolCalls = records.filter(
      r => r.event === 'tool_call' && r.operation === 'web_search',
    );

    assert.equal(attempts.length, 3);
    assert.equal(summaries.length, 1);
    assert.equal(toolCalls.length, 1);

    const ids = new Set(
      [...attempts, ...summaries, ...toolCalls].map(r => r.requestId),
    );
    assert.equal(
      ids.size,
      1,
      'every record from this call must share one requestId',
    );
    assert.ok((ids.values().next().value as string).length > 0);
  });

  test('a second, sequential context-free web_search call gets a different requestId', async () => {
    stubAllAttemptsFail();
    const { lines: firstLines } = await captureStderr(() =>
      web_search({ query: 'q' }).catch(() => undefined),
    );
    const firstId = (JSON.parse(firstLines[0]!) as Record<string, unknown>)
      .requestId;

    stubAllAttemptsFail();
    const { lines: secondLines } = await captureStderr(() =>
      web_search({ query: 'q' }).catch(() => undefined),
    );
    const secondId = (JSON.parse(secondLines[0]!) as Record<string, unknown>)
      .requestId;

    assert.notEqual(firstId, secondId);
  });
});
