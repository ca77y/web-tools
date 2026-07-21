/**
 * Unit-level scenario tests for the shared structured logger's primitives:
 * the JSON writer, the record-kind contract, request-ID sanitize/adopt/mint,
 * and the safe-value helpers. These exercise `logging.ts` directly, without
 * going through any tool or transport.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, test } from 'node:test';

import {
  adoptOrMintRequestId,
  getRequestId,
  logEvent,
  logOperation,
  runInRequestContext,
  safeUrl,
  sanitizeRequestId,
  summarizeArgShape,
  truncate,
  withRequestContext,
} from './logging.js';

const originalStderrWrite = process.stderr.write.bind(process.stderr);
const originalStdoutWrite = process.stdout.write.bind(process.stdout);

/** Captures every line written to stderr and stdout while `fn` runs. */
function captureStreams<T>(fn: () => T): {
  stderr: string[];
  stdout: string[];
  result: T;
} {
  const stderrChunks: string[] = [];
  const stdoutChunks: string[] = [];
  process.stderr.write = ((chunk: unknown) => {
    stderrChunks.push(String(chunk));
    return true;
  }) as typeof process.stderr.write;
  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  let result: T;
  try {
    result = fn();
  } finally {
    process.stderr.write = originalStderrWrite;
    process.stdout.write = originalStdoutWrite;
  }
  return {
    stderr: stderrChunks.join('').split('\n').filter(Boolean),
    stdout: stdoutChunks.join('').split('\n').filter(Boolean),
    result,
  };
}

afterEach(() => {
  process.stderr.write = originalStderrWrite;
  process.stdout.write = originalStdoutWrite;
});

describe('logEvent / logOperation - record shape', () => {
  test('logEvent writes one single-line JSON object to stderr only, carrying ts/kind/event', () => {
    const { stderr, stdout } = captureStreams(() =>
      logEvent('some_event', { foo: 'bar' }),
    );

    assert.equal(stdout.length, 0, 'no log record should reach stdout');
    assert.equal(stderr.length, 1);
    const parsed = JSON.parse(stderr[0]!) as Record<string, unknown>;
    assert.equal(typeof parsed.ts, 'string');
    assert.equal(parsed.kind, 'event');
    assert.equal(parsed.event, 'some_event');
    assert.equal(parsed.foo, 'bar');
    assert.equal(parsed.level, 'info');
  });

  test('logOperation writes kind "operation" and always carries requestId/operation/outcome/durationMs', () => {
    const { stderr } = captureStreams(() =>
      logOperation('some_op', {
        operation: 'thing',
        outcome: 'ok',
        durationMs: 12,
      }),
    );

    const parsed = JSON.parse(stderr[0]!) as Record<string, unknown>;
    assert.equal(parsed.kind, 'operation');
    assert.equal(parsed.event, 'some_op');
    assert.equal(parsed.operation, 'thing');
    assert.equal(parsed.outcome, 'ok');
    assert.equal(parsed.durationMs, 12);
    assert.equal(typeof parsed.requestId, 'string');
    assert.ok((parsed.requestId as string).length > 0);
  });

  test('logOperation error outcome is logged at level "error"', () => {
    const { stderr } = captureStreams(() =>
      logOperation('some_op', {
        operation: 'thing',
        outcome: 'error',
        durationMs: 1,
      }),
    );
    const parsed = JSON.parse(stderr[0]!) as Record<string, unknown>;
    assert.equal(parsed.level, 'error');
  });

  test('a caller cannot override the "kind" discriminator via extra fields', () => {
    const fields = {
      operation: 'thing',
      outcome: 'ok' as const,
      durationMs: 1,
      kind: 'event',
    };
    const { stderr } = captureStreams(() => logOperation('some_op', fields));
    const parsed = JSON.parse(stderr[0]!) as Record<string, unknown>;
    assert.equal(parsed.kind, 'operation');
  });

  test('an explicit requestId in fields is preserved rather than replaced by the ambient one', () => {
    const { stderr } = captureStreams(() =>
      runInRequestContext('ambient-id', () =>
        logOperation('some_op', {
          operation: 'thing',
          outcome: 'ok',
          durationMs: 1,
          requestId: 'explicit-id',
        }),
      ),
    );
    const parsed = JSON.parse(stderr[0]!) as Record<string, unknown>;
    assert.equal(parsed.requestId, 'explicit-id');
  });
});

describe('request correlation context', () => {
  test('getRequestId reads the ambient context when one is active', () => {
    runInRequestContext('req-abc', () => {
      assert.equal(getRequestId(), 'req-abc');
    });
  });

  test('getRequestId mints a non-empty fallback when no context is active', () => {
    const a = getRequestId();
    const b = getRequestId();
    assert.ok(a.length > 0);
    assert.ok(b.length > 0);
    assert.notEqual(a, b, 'each context-free call should mint its own id');
  });

  test('withRequestContext reuses an existing ambient context rather than minting a new one', () => {
    runInRequestContext('outer-id', () => {
      withRequestContext(requestId => {
        assert.equal(requestId, 'outer-id');
      });
    });
  });

  test('withRequestContext mints a fresh id when no context is active, and two calls differ', () => {
    let first: string | undefined;
    let second: string | undefined;
    withRequestContext(id => {
      first = id;
    });
    withRequestContext(id => {
      second = id;
    });
    assert.ok(first);
    assert.ok(second);
    assert.notEqual(first, second);
  });

  test('concurrent context-free withRequestContext calls stay isolated from one another', async () => {
    const seen: string[] = [];
    await Promise.all(
      [1, 2, 3].map(() =>
        withRequestContext(async requestId => {
          await new Promise(resolve => setTimeout(resolve, 1));
          assert.equal(
            getRequestId(),
            requestId,
            'context must survive the await',
          );
          seen.push(requestId);
        }),
      ),
    );
    assert.equal(
      new Set(seen).size,
      3,
      'three concurrent contexts must get three distinct ids',
    );
  });
});

describe('sanitizeRequestId / adoptOrMintRequestId', () => {
  test('a missing header mints a fresh id', () => {
    const id = adoptOrMintRequestId(undefined);
    assert.ok(id.length > 0);
  });

  test('a well-formed header is adopted verbatim', () => {
    assert.equal(sanitizeRequestId('abc-123'), 'abc-123');
  });

  test('an array header value adopts the first entry', () => {
    assert.equal(adoptOrMintRequestId(['first-id', 'second-id']), 'first-id');
  });

  test('a hostile id (newline, quote, 5000 chars) is bounded to 200 chars and stripped of disallowed characters', () => {
    const hostile = 'a"b\nc' + 'x'.repeat(5000);
    const sanitized = sanitizeRequestId(hostile);
    assert.ok(sanitized.length <= 200);
    assert.ok(!sanitized.includes('\n'));
    assert.ok(!sanitized.includes('"'));
    assert.match(sanitized, /^[A-Za-z0-9._:-]+$/);
  });

  test('an id that is entirely disallowed characters mints a fresh one instead of returning empty', () => {
    const sanitized = sanitizeRequestId('"""\n\n\n');
    assert.ok(sanitized.length > 0);
  });
});

describe('safeUrl', () => {
  test('strips userinfo, query string, and fragment; reports hasQuery', () => {
    const { url, hasQuery } = safeUrl(
      'https://user:pw@example.com/a/b?token=SUPERSECRET#frag',
    );
    assert.equal(url, 'https://example.com/a/b');
    assert.equal(hasQuery, true);
  });

  test('a url with no query reports hasQuery false', () => {
    const { url, hasQuery } = safeUrl('https://example.com/a/b');
    assert.equal(url, 'https://example.com/a/b');
    assert.equal(hasQuery, false);
  });

  test('a null/undefined input reports url null, hasQuery false', () => {
    assert.deepEqual(safeUrl(null), { url: null, hasQuery: false });
    assert.deepEqual(safeUrl(undefined), { url: null, hasQuery: false });
  });

  test('an unparseable string is reported as "(unparseable)" rather than echoed', () => {
    const { url } = safeUrl('not a url at all');
    assert.equal(url, '(unparseable)');
  });

  test('a long pathname is truncated to 200 characters', () => {
    const longPath = '/' + 'a'.repeat(300);
    const { url } = safeUrl(`https://example.com${longPath}`);
    assert.ok(url);
    const pathname = url.replace('https://example.com', '');
    assert.equal(pathname.length, 200);
  });
});

describe('summarizeArgShape', () => {
  test('maps top-level keys to type tokens only, never descending into nested objects', () => {
    const shape = summarizeArgShape({
      url: 'https://example.com',
      count: 3,
      enabled: true,
      missing: null,
      tags: ['a', 'b', 'c'],
      browser_config: {
        params: { proxy_config: { params: { username: 'u', password: 'p' } } },
      },
    });
    assert.deepEqual(shape, {
      url: 'string',
      count: 'number',
      enabled: 'boolean',
      missing: 'null',
      tags: 'array[3]',
      browser_config: 'object',
    });
    assert.ok(
      !JSON.stringify(shape).includes('password'),
      'nested keys must never appear',
    );
  });
});

describe('truncate', () => {
  test('leaves short strings unchanged', () => {
    assert.equal(truncate('short', 10), 'short');
  });

  test('truncates strings longer than maxLength', () => {
    assert.equal(truncate('x'.repeat(300), 256).length, 256);
  });
});

describe('structural: one helper replaces the duplicates (toolkit)', () => {
  // dist-test/logging.test.js and src/logging.ts are siblings under the
  // package root, so this resolves regardless of the process cwd.
  const srcDir = new URL('../src/', import.meta.url);
  const toolkitFiles = [
    'functions.ts',
    'searxng.ts',
    'crawl4ai.ts',
    'logging.ts',
  ];

  test('logging.ts exists', () => {
    assert.ok(existsSync(new URL('logging.ts', srcDir)));
  });

  test('no local `const log = (...args: unknown[]) =>` helper remains in searxng.ts or functions.ts', () => {
    for (const file of ['functions.ts', 'searxng.ts']) {
      const contents = readFileSync(new URL(file, srcDir), 'utf8');
      assert.ok(
        !/const log = \(\.\.\.args: unknown\[\]\)/.test(contents),
        `${file} still defines the duplicate log helper`,
      );
    }
  });

  test("no raw process.stderr.write call remains in this unit's toolkit files outside logging.ts", () => {
    for (const file of toolkitFiles) {
      const contents = readFileSync(new URL(file, srcDir), 'utf8');
      const isLoggingModule = file === 'logging.ts';
      const hasRawWrite = /process\.stderr\.write/.test(contents);
      if (isLoggingModule) {
        assert.ok(
          hasRawWrite,
          'logging.ts is expected to own the one raw process.stderr.write call',
        );
      } else {
        assert.ok(
          !hasRawWrite,
          `${file} still calls process.stderr.write directly`,
        );
      }
    }
  });
});
