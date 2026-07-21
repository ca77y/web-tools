/**
 * Exercises the exported `requestLogMiddleware` (request-log.ts) directly
 * over real HTTP round trips against real `express()` apps — mirroring the
 * existing `handler.test.ts` convention of never importing `index.ts`
 * itself (it binds the real port and has unguarded side effects).
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, test } from 'node:test';
import { Config } from '@web-tools/toolkit';
import express, {
  type NextFunction,
  type Request,
  type Response,
} from 'express';

import { toolHandler } from './handler.js';
import { requestLogMiddleware } from './request-log.js';

const originalFetch = globalThis.fetch;
const originalStderrWrite = process.stderr.write.bind(process.stderr);

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.stderr.write = originalStderrWrite;
});

/** Captures every line written to stderr while `fn` runs. */
async function captureStderr<T>(
  fn: () => Promise<T>,
): Promise<{ lines: string[]; raw: string; result: T }> {
  const chunks: string[] = [];
  process.stderr.write = ((chunk: unknown) => {
    chunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  let result: T;
  try {
    result = await fn();
  } finally {
    process.stderr.write = originalStderrWrite;
  }
  const raw = chunks.join('');
  return { lines: raw.split('\n').filter(Boolean), raw, result };
}

/**
 * Records every line written to stdout while `fn` runs, without swallowing
 * it. `node --test`'s own reporter writes its progress to the real stdout,
 * concurrently with this test's own async work — fully replacing
 * `process.stdout.write` (rather than tee-ing through to the original) was
 * observed to silently drop the reporter's own in-flight result lines for
 * neighboring tests, so this always forwards to the original writer.
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

/** node:http.request sends no default User-Agent header, unlike fetch. */
function rawGetNoUserAgent(baseUrl: string, path: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      new URL(path, baseUrl),
      { method: 'GET', headers: {} },
      res => {
        res.resume();
        res.on('end', () => resolve());
      },
    );
    req.on('error', reject);
    req.end();
  });
}

/** Spins up a real Express server on a real socket and tears it down after `fn`. */
async function withServer(
  build: (app: express.Express) => void,
  fn: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const app = express();
  app.use(express.json());
  build(app);

  const server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  try {
    await fn(`http://127.0.0.1:${address.port}`);
  } finally {
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
}

describe('requestLogMiddleware - request-ID adoption, minting, and sanitization', () => {
  test('an inbound X-Request-Id is adopted verbatim', async () => {
    await withServer(
      app => {
        app.use(requestLogMiddleware);
        app.get('/x', (_req, res) => res.status(200).json({ ok: true }));
      },
      async baseUrl => {
        const { lines } = await captureStderr(() =>
          fetch(`${baseUrl}/x`, { headers: { 'X-Request-Id': 'abc-123' } }),
        );
        const rec = parseAll(lines).find(r => r.event === 'http_request');
        assert.ok(rec);
        assert.equal(rec.requestId, 'abc-123');
      },
    );
  });

  test('a missing X-Request-Id is minted, and two requests differ', async () => {
    await withServer(
      app => {
        app.use(requestLogMiddleware);
        app.get('/x', (_req, res) => res.status(200).json({ ok: true }));
      },
      async baseUrl => {
        const { lines: firstLines } = await captureStderr(() =>
          fetch(`${baseUrl}/x`),
        );
        const { lines: secondLines } = await captureStderr(() =>
          fetch(`${baseUrl}/x`),
        );

        const firstId = parseAll(firstLines).find(
          r => r.event === 'http_request',
        )?.requestId;
        const secondId = parseAll(secondLines).find(
          r => r.event === 'http_request',
        )?.requestId;
        assert.ok(typeof firstId === 'string' && firstId.length > 0);
        assert.ok(typeof secondId === 'string' && secondId.length > 0);
        assert.notEqual(firstId, secondId);
      },
    );
  });

  test('a hostile X-Request-Id cannot forge a log line', async () => {
    // A real HTTP client (fetch/undici, and Node's own http client) refuses
    // to send a raw CR/LF inside a header value — that byte sequence would
    // terminate the header line at the wire level, so it can never survive
    // transport as part of one header's value regardless of what this
    // middleware does. `sanitizeRequestId`'s handling of a literal embedded
    // newline is covered directly at the unit level in `logging.test.ts`;
    // this transport-level test exercises what a compliant client *can*
    // actually deliver: an oversized value containing a quote character.
    await withServer(
      app => {
        app.use(requestLogMiddleware);
        app.get('/x', (_req, res) => res.status(200).json({ ok: true }));
      },
      async baseUrl => {
        const { lines: emptyBaselineLines } = await captureStderr(() =>
          fetch(`${baseUrl}/x`),
        );

        const hostile = 'evil"id' + 'x'.repeat(5000);
        const { lines: hostileLines } = await captureStderr(() =>
          fetch(`${baseUrl}/x`, { headers: { 'X-Request-Id': hostile } }),
        );

        assert.equal(
          hostileLines.length,
          emptyBaselineLines.length,
          'line count must be unchanged versus the same request without the header',
        );
        for (const line of hostileLines) {
          assert.doesNotThrow(
            () => JSON.parse(line),
            `not valid JSON: ${line}`,
          );
        }
        const rec = parseAll(hostileLines).find(
          r => r.event === 'http_request',
        );
        assert.ok(rec);
        const recordedId = rec.requestId as string;
        assert.ok(recordedId.length <= 200);
        assert.ok(!recordedId.includes('\n'));
      },
    );
  });
});

describe('requestLogMiddleware - the http_request record', () => {
  test('carries method, path, status, durationMs, and userAgent', async () => {
    await withServer(
      app => {
        app.use(requestLogMiddleware);
        app.get('/x/y', (_req, res) => res.status(200).json({ ok: true }));
      },
      async baseUrl => {
        const { lines } = await captureStderr(() =>
          fetch(`${baseUrl}/x/y`, {
            headers: { 'User-Agent': 'spec-probe-agent/1.0' },
          }),
        );
        const records = parseAll(lines).filter(r => r.event === 'http_request');
        assert.equal(
          records.length,
          1,
          'exactly one http_request record per request',
        );
        const rec = records[0]!;
        assert.equal(rec.method, 'GET');
        assert.equal(rec.path, '/x/y');
        assert.equal(rec.status, 200);
        assert.equal(typeof rec.durationMs, 'number');
        assert.equal(rec.userAgent, 'spec-probe-agent/1.0');
      },
    );
  });

  test('a missing User-Agent header is recorded explicitly as null', async () => {
    await withServer(
      app => {
        app.use(requestLogMiddleware);
        app.get('/x', (_req, res) => res.status(200).json({ ok: true }));
      },
      async baseUrl => {
        const { lines } = await captureStderr(() =>
          rawGetNoUserAgent(baseUrl, '/x'),
        );
        const rec = parseAll(lines).find(r => r.event === 'http_request');
        assert.ok(rec);
        assert.equal(rec.userAgent, null);
      },
    );
  });

  test('a rejected 4xx request is still logged, with outcome error', async () => {
    await withServer(
      app => {
        app.use(requestLogMiddleware);
        app.get('/x', (_req, res) =>
          res.status(404).json({ error: 'not found' }),
        );
      },
      async baseUrl => {
        const { lines } = await captureStderr(() => fetch(`${baseUrl}/x`));
        const rec = parseAll(lines).find(r => r.event === 'http_request');
        assert.ok(rec);
        assert.equal(rec.status, 404);
        assert.equal(rec.outcome, 'error');
      },
    );
  });

  test('an auth-rejected request (403, no next()) is still logged with its user agent', async () => {
    await withServer(
      app => {
        app.use(requestLogMiddleware);
        // Shape of the production auth middleware: terminates with 403
        // without ever calling next().
        app.use((_req: Request, res: Response, _next: NextFunction) => {
          res.status(403).json({ error: 'forbidden' });
        });
        app.get('/x', (_req, res) => res.status(200).json({ ok: true }));
      },
      async baseUrl => {
        const { lines } = await captureStderr(() =>
          fetch(`${baseUrl}/x`, { headers: { 'User-Agent': 'probe-bot/1.0' } }),
        );
        const rec = parseAll(lines).find(r => r.event === 'http_request');
        assert.ok(
          rec,
          'a request the auth middleware rejects must still be logged',
        );
        assert.equal(rec.status, 403);
        assert.equal(rec.outcome, 'error');
        assert.equal(rec.userAgent, 'probe-bot/1.0');
      },
    );
  });
});

describe('requestLogMiddleware - no log record on stdout', () => {
  test('no captured stdout line parses as a log record', async () => {
    // Node's test runner may itself interleave unrelated stdout writes
    // (progress reporting) while this override is active, so — matching
    // the CLI's own "stdout stays machine-parseable" convention — assert
    // that no captured line parses as a `{kind: "event"|"operation"}`
    // record, rather than asserting the capture is empty outright.
    await withServer(
      app => {
        app.use(requestLogMiddleware);
        app.get('/x', (_req, res) => res.status(200).json({ ok: true }));
      },
      async baseUrl => {
        const { lines: stdoutLines } = await captureStdout(() =>
          captureStderr(() => fetch(`${baseUrl}/x`)),
        );
        for (const line of stdoutLines) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line);
          } catch {
            continue;
          }
          if (parsed && typeof parsed === 'object' && 'kind' in parsed) {
            assert.notEqual((parsed as { kind: unknown }).kind, 'event');
            assert.notEqual((parsed as { kind: unknown }).kind, 'operation');
          }
        }
      },
    );
  });
});

describe('requestLogMiddleware - secrets never reach the logs', () => {
  test('neither the Authorization header value nor the api_key query value appears in any log line', async () => {
    const keyMatches = (provided: string | undefined): boolean =>
      provided === Config.apiKey;

    await withServer(
      app => {
        app.use(requestLogMiddleware);
        app.use((req: Request, res: Response, next: NextFunction) => {
          const provided =
            req.headers.authorization?.replace(/^Bearer\s+/i, '') ||
            (req.query.api_key as string | undefined);
          if (!keyMatches(provided)) {
            res.status(403).json({ error: 'forbidden' });
            return;
          }
          next();
        });
        for (const name of ['web_search']) {
          app.post(`/api/v0/${name}`, toolHandler(name));
        }
      },
      async baseUrl => {
        // globalThis.fetch is stubbed to fake SearXNG's response (consumed
        // by the toolkit); the outbound call to the local test server below
        // must use the original, unstubbed fetch, or it would never reach
        // the server at all.
        globalThis.fetch = (async () =>
          new Response(JSON.stringify({}), { status: 503 })) as typeof fetch;

        const { lines } = await captureStderr(() =>
          originalFetch(
            `${baseUrl}/api/v0/web_search?api_key=${Config.apiKey}`,
            {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                Authorization: `Bearer ${Config.apiKey}`,
              },
              body: JSON.stringify({ query: 'q' }),
            },
          ),
        );

        const httpRequestRecord = parseAll(lines).find(
          r => r.event === 'http_request',
        );
        assert.ok(httpRequestRecord, 'expected an inbound request record');

        const joined = lines.join('\n');
        assert.ok(
          !joined.includes(Config.apiKey),
          'the configured key must appear in no captured line',
        );
        assert.ok(
          !joined.includes('api_key'),
          'no captured line may contain the substring api_key',
        );
        assert.ok(
          !joined.toLowerCase().includes('"authorization"'),
          'no captured line may contain an authorization field',
        );
      },
    );
  });
});

describe('requestLogMiddleware - all lines from one request share its ID', () => {
  test('the inbound request record and every toolkit record from a web_search call share one requestId', async () => {
    await withServer(
      app => {
        app.use(requestLogMiddleware);
        app.post('/api/v0/web_search', toolHandler('web_search'));
      },
      async baseUrl => {
        globalThis.fetch = (async () =>
          new Response(JSON.stringify({}), { status: 503 })) as typeof fetch;

        const { lines } = await captureStderr(() =>
          originalFetch(`${baseUrl}/api/v0/web_search`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: 'q' }),
          }),
        );
        const records = parseAll(lines);

        const httpRecord = records.find(r => r.event === 'http_request');
        const attempts = records.filter(
          r => r.event === 'searxng_attempt_outcome',
        );
        const summary = records.find(r => r.event === 'search_complete');
        const toolRecord = records.find(
          r => r.event === 'tool_call' && r.operation === 'web_search',
        );

        assert.ok(httpRecord);
        assert.equal(attempts.length, 3);
        assert.ok(summary);
        assert.ok(toolRecord);

        const ids = new Set(
          [httpRecord, ...attempts, summary, toolRecord].map(r => r!.requestId),
        );
        assert.equal(
          ids.size,
          1,
          'every record from this one request must share its requestId',
        );
      },
    );
  });
});

describe('the shared logger contract holds for an inbound API request', () => {
  /**
   * The transport half of the "Every emitted line is valid single-line JSON" /
   * "Operation lines carry the four required fields" / "The outcome vocabulary
   * is uniform" scenarios: one real inbound request that reaches the real
   * `toolHandler` and drives a failing `web_search` underneath it, so the
   * capture holds `http_request`, `searxng_attempt_outcome`, `search_complete`,
   * and `tool_call` records together. (The toolkit half — a successful search
   * and an unreachable-Crawl4AI crawl — lives in
   * `packages/toolkit/src/crawl4ai-closed-port.test.ts`.)
   */
  async function captureOneInboundRequest(): Promise<{
    lines: string[];
    raw: string;
  }> {
    let captured: { lines: string[]; raw: string } | undefined;
    await withServer(
      app => {
        app.use(requestLogMiddleware);
        app.post('/api/v0/web_search', toolHandler('web_search'));
      },
      async baseUrl => {
        globalThis.fetch = (async () =>
          new Response(JSON.stringify({}), { status: 503 })) as typeof fetch;

        const { lines, raw } = await captureStderr(async () => {
          await originalFetch(`${baseUrl}/api/v0/web_search`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ query: 'q' }),
          });
          // The http_request record is emitted on the response's 'finish'
          // event, which can land a tick after the client's promise settles.
          await new Promise(resolve => setTimeout(resolve, 25));
        });
        captured = { lines, raw };
      },
    );
    assert.ok(captured, 'expected a capture');
    return captured;
  }

  test('every captured line is a single-line, non-array JSON object carrying ts, kind, and event', async () => {
    const { lines, raw } = await captureOneInboundRequest();
    assert.ok(lines.length > 0, 'expected the request to emit records');
    assert.equal(
      (raw.match(/\n/g) ?? []).length,
      lines.length,
      'each record must occupy exactly one line',
    );

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

  test('every operation record carries the four required fields, and the API request itself produces one', async () => {
    const { lines } = await captureOneInboundRequest();
    const operations = parseAll(lines).filter(r => r.kind === 'operation');
    assert.ok(operations.length > 0, 'expected operation records');

    for (const record of operations) {
      assert.equal(typeof record.requestId, 'string');
      assert.ok((record.requestId as string).length > 0);
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
      );
    }

    assert.ok(
      operations.some(r => r.event === 'http_request'),
      'expected an operation record for the inbound API request',
    );
  });

  test('the outcome vocabulary is uniform: no "failed" token, and no kind outside event/operation', async () => {
    const { lines } = await captureOneInboundRequest();

    for (const record of parseAll(lines)) {
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
});

describe('structural: one helper replaces the duplicates (api)', () => {
  // dist-test/request-log.test.js and src/*.ts are siblings under the
  // package root, so this resolves regardless of the process cwd.
  const srcDir = new URL('../src/', import.meta.url);

  test('no local `const log = (...args: unknown[]) =>` helper remains in index.ts', () => {
    const contents = readFileSync(new URL('index.ts', srcDir), 'utf8');
    assert.ok(
      !/const log = \(\.\.\.args: unknown\[\]\)/.test(contents),
      'index.ts still defines the duplicate log helper',
    );
  });

  test('no raw process.stderr.write call remains in index.ts or request-log.ts', () => {
    for (const file of ['index.ts', 'request-log.ts']) {
      const contents = readFileSync(new URL(file, srcDir), 'utf8');
      assert.ok(
        !/process\.stderr\.write/.test(contents),
        `${file} still calls process.stderr.write directly`,
      );
    }
  });

  test('the request-logging middleware is mounted after express.json() and strictly before the auth middleware, with nothing else in between', () => {
    const contents = readFileSync(new URL('index.ts', srcDir), 'utf8');
    const jsonIdx = contents.indexOf('app.use(express.json())');
    const middlewareIdx = contents.indexOf('app.use(requestLogMiddleware)');
    const authIdx = contents.indexOf('keyMatches(provided, Config.apiKey)');

    assert.ok(jsonIdx >= 0, 'expected app.use(express.json()) in index.ts');
    assert.ok(
      middlewareIdx >= 0,
      'expected app.use(requestLogMiddleware) in index.ts',
    );
    assert.ok(
      authIdx >= 0,
      'expected the auth middleware referencing keyMatches in index.ts',
    );
    assert.ok(
      jsonIdx < middlewareIdx,
      'requestLogMiddleware must be mounted after express.json()',
    );
    assert.ok(
      middlewareIdx < authIdx,
      'requestLogMiddleware must be mounted before the auth middleware',
    );

    const between = contents.slice(jsonIdx, middlewareIdx);
    const appUseCount = (between.match(/app\.use\(/g) ?? []).length;
    assert.equal(
      appUseCount,
      1,
      'no other app.use may be inserted between express.json() and requestLogMiddleware',
    );
  });

  test('/health and the auth middleware bypass are unchanged', () => {
    const contents = readFileSync(new URL('index.ts', srcDir), 'utf8');
    assert.match(contents, /if \(req\.path === '\/health'\) return next\(\);/);
    assert.match(
      contents,
      /app\.get\('\/health', \(_req: Request, res: Response\) => \{\s*res\.json\(\{ status: 'ok' \}\);/,
    );
  });
});
