/**
 * Scenarios that specifically require `CRAWL4AI_URL` pointed at a closed
 * local port — a connection failure and nothing else — plus the proxy
 * credential env vars for the redaction scenario. This is a separate file
 * from `crawl4ai-attribution.test.ts` (which points `CRAWL4AI_URL` at a
 * live MCP stand-in) because `Config` is parsed once per process and
 * `node --test` gives each test file its own process, so the two files'
 * different `CRAWL4AI_URL` values never collide.
 *
 * Covers: the thrown `proxyCrawl4AI` path (functions.ts:93) naming its
 * target, the Crawl4AI argument-shape summary carrying no values (and
 * specifically no proxy credentials or script bodies), and the shape
 * summary being emitted before dispatch is even attempted.
 *
 * It also hosts the whole-capture logger-contract scenarios (valid single-line
 * JSON with ts/kind/event, the four mandatory operation fields, the uniform
 * outcome vocabulary, stderr-only), because the mix those scenarios name
 * includes "a web_crawl against an unreachable Crawl4AI" — which is exactly
 * this file's fixture.
 */
import assert from 'node:assert/strict';
import { createServer as createTcpServer } from 'node:net';
import { after, afterEach, describe, test } from 'node:test';

process.env.PROXY_SERVER = 'proxy.example.internal:8080';
process.env.PROXY_USERNAME = 'proxy-user-should-not-leak';
process.env.PROXY_PASSWORD = 'proxy-pass-should-not-leak';

/** Binds a TCP server and closes it immediately, yielding a guaranteed-closed local port. */
async function closedPort(): Promise<number> {
  const server = createTcpServer();
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  await new Promise<void>(resolve => server.close(() => resolve()));
  return port;
}

const port = await closedPort();
process.env.CRAWL4AI_URL = `http://127.0.0.1:${port}`;

const { web_fetch, web_crawl, web_execute_js, web_search } =
  await import('./functions.js');

const originalStderrWrite = process.stderr.write.bind(process.stderr);
const originalFetch = globalThis.fetch;

async function captureStderr<T>(
  fn: () => Promise<T>,
): Promise<{ lines: string[]; raw: string; error?: unknown; result?: T }> {
  const chunks: string[] = [];
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  let error: unknown;
  let result: T | undefined;
  try {
    result = await fn();
  } catch (err) {
    error = err;
  } finally {
    process.stderr.write = originalStderrWrite;
  }
  const raw = chunks.join('');
  return { lines: raw.split('\n').filter(Boolean), raw, error, result };
}

/**
 * Records stdout writes without swallowing them: `node --test` writes its own
 * result lines to the real stdout concurrently with this file's async work, and
 * a swallow-only override silently drops them. Always tee through.
 */
async function captureStdout<T>(
  fn: () => Promise<T>,
): Promise<{ lines: string[]; result: T }> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const chunks: string[] = [];
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    chunks.push(String(chunk));
    return (originalStdoutWrite as (...a: unknown[]) => boolean)(
      chunk,
      ...rest,
    );
  }) as typeof process.stdout.write;
  let result: T;
  try {
    result = await fn();
  } finally {
    process.stdout.write = originalStdoutWrite;
  }
  return { lines: chunks.join('').split('\n').filter(Boolean), result };
}

function parseAll(lines: string[]): Record<string, unknown>[] {
  return lines.map(line => JSON.parse(line) as Record<string, unknown>);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  process.stderr.write = originalStderrWrite;
  globalThis.fetch = originalFetch;
});

describe('the thrown proxyCrawl4AI path names the target', () => {
  test('a connection failure logs outcome error with the sanitized target and the message as cause, and never throws out of web_crawl', async () => {
    const { lines, result, error } = await captureStderr(() =>
      web_crawl({ urls: ['https://example.com/a/b'] }),
    );
    assert.equal(
      error,
      undefined,
      'proxyCrawl4AI must catch the connection failure, not throw',
    );
    assert.equal(result?.isError, true);

    const rec = parseAll(lines).find(r => r.event === 'crawl4ai_call');
    assert.ok(rec);
    assert.equal(rec.outcome, 'error');
    assert.equal(rec.targetUrl, 'https://example.com/a/b');
    assert.equal(typeof rec.cause, 'string');
    assert.ok((rec.cause as string).length > 0);
  });

  test('the requestId in the caller-visible error text matches the logged record on the thrown path', async () => {
    const { lines, result } = await captureStderr(() =>
      web_crawl({ urls: ['https://example.com/a'] }),
    );
    const rec = parseAll(lines).find(r => r.event === 'crawl4ai_call');
    assert.ok(rec);
    const text = result!.content[0]!.text;
    assert.ok(text.includes(rec!.requestId as string));
  });
});

describe('the Crawl4AI argument-shape summary carries no values', () => {
  test('web_fetch with a token-bearing URL and configured proxy credentials never leaks them', async () => {
    const { lines } = await captureStderr(() =>
      web_fetch({ url: 'https://example.com/p?token=SUPERSECRET&q=x' }),
    );
    const shapeRecord = parseAll(lines).find(
      r => r.event === 'crawl4ai_request_shape',
    );
    assert.ok(shapeRecord, 'expected a crawl4ai_request_shape record');
    const argShape = shapeRecord!.argShape as Record<string, string>;
    for (const token of Object.values(argShape)) {
      assert.match(token, /^(string|number|boolean|null|object|array\[\d+\])$/);
    }

    const joined = lines.join('\n');
    assert.ok(!joined.includes('SUPERSECRET'));
    assert.ok(!joined.includes('token='));
    assert.ok(!joined.includes('proxy-user-should-not-leak'));
    assert.ok(!joined.includes('proxy-pass-should-not-leak'));
  });

  test('web_execute_js with a script body never leaks it', async () => {
    const { lines } = await captureStderr(() =>
      web_execute_js({
        url: 'https://example.com/a',
        scripts: ['const SCRIPT_BODY_MARKER = 1; doSomethingSecret();'],
      }),
    );
    const shapeRecord = parseAll(lines).find(
      r => r.event === 'crawl4ai_request_shape',
    );
    assert.ok(shapeRecord);
    assert.equal(
      (shapeRecord!.argShape as Record<string, string>).scripts,
      'array[1]',
    );

    const joined = lines.join('\n');
    assert.ok(!joined.includes('SCRIPT_BODY_MARKER'));
  });
});

describe('the shape summary is emitted before dispatch', () => {
  test('a crawl4ai_request_shape record appears before the corresponding failure record', async () => {
    const { lines } = await captureStderr(() =>
      web_fetch({ url: 'https://example.com/a' }),
    );
    const records = parseAll(lines);
    const shapeIndex = records.findIndex(
      r => r.event === 'crawl4ai_request_shape',
    );
    const failureIndex = records.findIndex(
      r => r.event === 'crawl4ai_call' && r.outcome === 'error',
    );

    assert.ok(shapeIndex >= 0, 'expected a crawl4ai_request_shape record');
    assert.ok(failureIndex >= 0, 'expected a crawl4ai_call failure record');
    assert.ok(
      shapeIndex < failureIndex,
      'the shape summary must be emitted before the failure record',
    );
  });
});

/**
 * Drives the exact mix the "Every emitted line is valid single-line JSON"
 * scenario names: a `web_search` that fails, a `web_search` that returns
 * results, and a `web_crawl` against an unreachable Crawl4AI. (The inbound API
 * request half of that scenario lives in `packages/api/src/request-log.test.ts`,
 * which is where the middleware is exercised.)
 *
 * `globalThis.fetch` is restored before the crawl on purpose: the Crawl4AI SSE
 * client transport itself goes through `globalThis.fetch`, so leaving the
 * SearXNG stub installed would intercept the connection attempt instead of
 * letting it fail against the closed port.
 */
async function driveMixedWorkload(): Promise<string[]> {
  const { lines, raw } = await captureStderr(async () => {
    globalThis.fetch = (async () => jsonResponse({}, 503)) as typeof fetch;
    await web_search({ query: 'contract-probe-failing' }).catch(
      () => undefined,
    );

    globalThis.fetch = (async () =>
      jsonResponse({
        results: [{ url: 'https://a.example', title: 'A', content: 'body' }],
      })) as typeof fetch;
    await web_search({ query: 'contract-probe-ok' });

    globalThis.fetch = originalFetch;
    await web_crawl({ urls: ['https://example.com/a/b'] });
  });

  // Every record is exactly one line: as many newlines as lines, none embedded.
  assert.equal(
    (raw.match(/\n/g) ?? []).length,
    lines.length,
    'each record must occupy exactly one line',
  );
  return lines;
}

describe('the shared logger contract holds across a whole capture', () => {
  test('every captured line is a single-line, non-array JSON object carrying ts, kind, and event', async () => {
    const lines = await driveMixedWorkload();
    assert.ok(lines.length > 0, 'expected the workload to emit records');

    for (const line of lines) {
      let parsed: unknown;
      assert.doesNotThrow(() => {
        parsed = JSON.parse(line);
      }, `not valid JSON: ${line}`);
      assert.ok(
        parsed && typeof parsed === 'object' && !Array.isArray(parsed),
        `not a non-array object: ${line}`,
      );
      const record = parsed as Record<string, unknown>;
      assert.equal(typeof record.ts, 'string', `missing ts: ${line}`);
      assert.equal(typeof record.kind, 'string', `missing kind: ${line}`);
      assert.equal(typeof record.event, 'string', `missing event: ${line}`);
    }
  });

  test('every operation record in the capture carries the four required fields, and the search and the crawl each produce one', async () => {
    const records = parseAll(await driveMixedWorkload());
    const operations = records.filter(r => r.kind === 'operation');
    assert.ok(operations.length > 0, 'expected operation records');

    for (const record of operations) {
      assert.equal(typeof record.requestId, 'string');
      assert.ok(
        (record.requestId as string).length > 0,
        `empty requestId: ${JSON.stringify(record)}`,
      );
      assert.equal(typeof record.operation, 'string');
      assert.ok((record.operation as string).length > 0);
      assert.ok(
        ['ok', 'empty', 'error'].includes(record.outcome as string),
        `unexpected outcome: ${JSON.stringify(record)}`,
      );
      assert.equal(typeof record.durationMs, 'number');
      assert.ok(
        Number.isFinite(record.durationMs as number) &&
          (record.durationMs as number) >= 0,
        `bad durationMs: ${JSON.stringify(record)}`,
      );
    }

    assert.ok(
      operations.some(r => r.operation === 'web_search'),
      'expected an operation record for the search',
    );
    assert.ok(
      operations.some(r => r.operation === 'web_crawl'),
      'expected an operation record for the crawl',
    );
  });

  test('the outcome vocabulary is uniform: no "failed" token, and no kind outside event/operation', async () => {
    const records = parseAll(await driveMixedWorkload());

    for (const record of records) {
      assert.ok(
        record.kind === 'operation' || record.kind === 'event',
        `unexpected kind: ${JSON.stringify(record)}`,
      );
      assert.notEqual(
        record.outcome,
        'failed',
        `the retired "failed" token survives: ${JSON.stringify(record)}`,
      );
    }
  });

  test('no log record reaches stdout', async () => {
    const { lines: stdoutLines } = await captureStdout(() =>
      driveMixedWorkload(),
    );

    for (const line of stdoutLines) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      if (parsed && typeof parsed === 'object' && 'kind' in parsed) {
        const kind = (parsed as { kind: unknown }).kind;
        assert.notEqual(kind, 'event', `log record on stdout: ${line}`);
        assert.notEqual(kind, 'operation', `log record on stdout: ${line}`);
      }
    }
  });
});

after(async () => {
  // Every call in this file hits a closed port, so the toolkit's SSE
  // client transport (crawl4ai.ts) never completes its first connection —
  // but the underlying EventSource still auto-retries on its own timer
  // regardless, with no exposed close() to stop it. Left alone this keeps
  // this file's dedicated `node --test` child process alive forever.
  // `node --test` isolates each test file in its own process, so exiting
  // here only ends this file's run. A short delay lets the test runner
  // finish reporting the last test's result before the process disappears.
  await new Promise(resolve => setTimeout(resolve, 100));
  process.exit(0);
});
