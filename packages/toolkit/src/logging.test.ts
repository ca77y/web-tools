/**
 * Unit-level scenario tests for the shared structured logger's primitives:
 * the JSON writer, the record-kind contract, request-ID sanitize/adopt/mint,
 * and the safe-value helpers. These exercise `logging.ts` directly, without
 * going through any tool or transport.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { afterEach, describe, test } from 'node:test';

import {
  adoptOrMintRequestId,
  getRequestId,
  logEvent,
  logOperation,
  MAX_ARRAY_ITEMS,
  MAX_FIELD_LENGTH,
  MAX_SANITIZE_DEPTH,
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

describe('logEvent / logOperation - every field value is sanitized by default', () => {
  // This is the generic mechanism every call site relies on: rather than
  // trust each of the (currently five) places that pass raw upstream text
  // into a field — a Crawl4AI/Playwright error message, an SSE transport
  // error, a thrown error from any of the nine tools, a SearXNG
  // unresponsive-engines list — to individually remember to sanitize it,
  // logEvent()/logOperation() sanitize every field value themselves. A new
  // field, or a new call site, cannot opt out by omission.

  const secretUrl =
    'https://user:pw@example.com/a/b?token=SUPERSECRET&api_key=SUPERSECRET2';
  const realisticMessage = `Page.goto: Timeout 120000ms exceeded. Call log: - navigating to "${secretUrl}", waiting until "load"`;

  test('a secret-bearing URL embedded in an arbitrary string field is redacted on the whole captured line, for logOperation', () => {
    const { stderr } = captureStreams(() =>
      logOperation('some_op', {
        operation: 'thing',
        outcome: 'error',
        durationMs: 1,
        cause: realisticMessage,
      }),
    );
    const line = stderr[0]!;
    assert.ok(!line.includes('SUPERSECRET'), `secret leaked: ${line}`);
    assert.ok(!line.includes('SUPERSECRET2'), `secret leaked: ${line}`);
    assert.ok(!line.includes('user:pw@'), `credentials leaked: ${line}`);
    assert.ok(!line.includes('token='), `query leaked: ${line}`);
    const parsed = JSON.parse(line) as Record<string, unknown>;
    assert.match(parsed.cause as string, /Timeout 120000ms exceeded/);
    assert.match(parsed.cause as string, /https:\/\/example\.com\/a\/b/);
  });

  test('the same holds for logEvent, on an arbitrarily-named field (e.g. a transport error "message")', () => {
    const { stderr } = captureStreams(() =>
      logEvent(
        'crawl4ai_transport_error',
        { message: realisticMessage },
        'error',
      ),
    );
    const line = stderr[0]!;
    assert.ok(!line.includes('SUPERSECRET'), `secret leaked: ${line}`);
    assert.ok(!line.includes('user:pw@'), `credentials leaked: ${line}`);
    assert.ok(!line.includes('token='), `query leaked: ${line}`);
  });

  test('a value already safe (no embedded URL, well within bounds) passes through unchanged', () => {
    const { stderr } = captureStreams(() =>
      logOperation('some_op', {
        operation: 'thing',
        outcome: 'ok',
        durationMs: 1,
        baseUrl: 'http://searxng.railway.internal:8080',
        note: 'short and plain',
      }),
    );
    const parsed = JSON.parse(stderr[0]!) as Record<string, unknown>;
    assert.equal(parsed.baseUrl, 'http://searxng.railway.internal:8080');
    assert.equal(parsed.note, 'short and plain');
  });

  test("a structured, non-free-text object (e.g. a SearXNG attempt's `reason`) is never touched", () => {
    const reason = { cause: 'http_status', status: 429 };
    const { stderr } = captureStreams(() =>
      logOperation('some_op', {
        operation: 'thing',
        outcome: 'error',
        durationMs: 1,
        reason,
      }),
    );
    const parsed = JSON.parse(stderr[0]!) as Record<string, unknown>;
    assert.deepEqual(parsed.reason, { cause: 'http_status', status: 429 });
  });

  test('an unboundedly long string field is truncated to exactly MAX_FIELD_LENGTH, with a truncation marker', () => {
    const { stderr } = captureStreams(() =>
      logOperation('some_op', {
        operation: 'thing',
        outcome: 'error',
        durationMs: 1,
        cause: 'x'.repeat(10000),
      }),
    );
    const parsed = JSON.parse(stderr[0]!) as Record<string, unknown>;
    const cause = parsed.cause as string;
    // Pinned to the real constant, not a hand-copied guess: a regression
    // in the cap (e.g. someone widening it "just a little") must fail this.
    assert.equal(cause.length, MAX_FIELD_LENGTH);
    assert.ok(
      cause.endsWith('[truncated]'),
      'a truncated value must be visibly marked as cut, not silently passed off as complete',
    );
  });

  test('a string at or under MAX_FIELD_LENGTH carries no truncation marker', () => {
    const short = 'a short, complete cause message';
    const { stderr } = captureStreams(() =>
      logOperation('some_op', {
        operation: 'thing',
        outcome: 'error',
        durationMs: 1,
        cause: short,
      }),
    );
    const parsed = JSON.parse(stderr[0]!) as Record<string, unknown>;
    assert.equal(parsed.cause, short);
  });

  test("an upstream-controlled string array (e.g. SearXNG's unresponsive engines list) is capped to exactly MAX_ARRAY_ITEMS, and each entry sanitized", () => {
    const manyEngines = Array.from({ length: 100 }, (_, i) => `engine-${i}`);
    const { stderr } = captureStreams(() =>
      logOperation('some_op', {
        operation: 'thing',
        outcome: 'error',
        durationMs: 1,
        engines: manyEngines,
      }),
    );
    const parsed = JSON.parse(stderr[0]!) as Record<string, unknown>;
    const engines = parsed.engines as string[];
    // Pinned to the real constant, not a hand-copied guess.
    assert.equal(engines.length, MAX_ARRAY_ITEMS);
  });

  describe('the redaction regex neither fabricates attribution nor blows up on adversarial input', () => {
    // Two real bugs found in review, both traced to the same root cause:
    // the userinfo group's character class did not exclude "/", "?", "#",
    // so it could span past the real host into unrelated text.

    test('does not treat a later, unrelated "@" in the same run as userinfo and drop the real host', () => {
      const { stderr } = captureStreams(() =>
        logOperation('some_op', {
          operation: 'thing',
          outcome: 'error',
          durationMs: 1,
          cause:
            'Crawl4AI failed on https://shop.example.com/checkout,notify=ops@pagerduty.example',
        }),
      );
      const parsed = JSON.parse(stderr[0]!) as Record<string, unknown>;
      assert.equal(
        parsed.cause,
        'Crawl4AI failed on https://shop.example.com/checkout,notify=ops@pagerduty.example',
        'the real host (shop.example.com) must survive, not be silently replaced by pagerduty.example',
      );
    });

    test('does not treat a query-shaped ";owner=team@host" as userinfo either', () => {
      const { stderr } = captureStreams(() =>
        logOperation('some_op', {
          operation: 'thing',
          outcome: 'error',
          durationMs: 1,
          cause:
            'fetch https://api.internal.corp/v2/orders;owner=team@corp.example failed',
        }),
      );
      const parsed = JSON.parse(stderr[0]!) as Record<string, unknown>;
      assert.equal(
        parsed.cause,
        'fetch https://api.internal.corp/v2/orders;owner=team@corp.example failed',
        'the real host (api.internal.corp) must survive, not be silently replaced by corp.example',
      );
    });

    test('a genuine userinfo + query + fragment is still fully stripped (the fix did not just disable redaction)', () => {
      const { stderr } = captureStreams(() =>
        logOperation('some_op', {
          operation: 'thing',
          outcome: 'error',
          durationMs: 1,
          cause: 'https://user:pw@example.com/a/b?token=SUPERSECRET#frag',
        }),
      );
      const parsed = JSON.parse(stderr[0]!) as Record<string, unknown>;
      assert.equal(parsed.cause, 'https://example.com/a/b');
    });

    test('a 1MB adversarial token completes within a bounded time budget, not quadratic', () => {
      // Pathological shape for the old, unbounded-charset regex: many
      // "@"-adjacent runs following "https://" with no "/", "?", or "#" to
      // stop the lazy userinfo scan early.
      //
      // This guards a property (sanitizing a 1MB adversarial value stays
      // within a bounded budget), not a reproduction. The originally
      // reported quadratic blow-up could not be re-measured on this
      // machine, so no timing figure for the old regex is asserted here —
      // quoting one would cement a number this test cannot re-derive. The
      // regex fix stands on its own for correctness (the userinfo class
      // must exclude "/" for the fabrication case); this ceiling is only a
      // cheap backstop against a future rewrite reintroducing super-linear
      // scanning.
      const pathological = 'https://' + 'a@'.repeat(500_000) + '?';
      const start = performance.now();
      const { stderr } = captureStreams(() =>
        logOperation('some_op', {
          operation: 'thing',
          outcome: 'error',
          durationMs: 1,
          cause: pathological,
        }),
      );
      const elapsed = performance.now() - start;
      assert.ok(
        elapsed < 500,
        `sanitizing a 1MB adversarial value took ${elapsed.toFixed(1)}ms; expected well under 500ms for linear behavior`,
      );
      // Also confirm it actually still parses as one valid, bounded line.
      assert.equal(stderr.length, 1);
      const parsed = JSON.parse(stderr[0]!) as Record<string, unknown>;
      assert.equal((parsed.cause as string).length, MAX_FIELD_LENGTH);
    });
  });

  describe('nested values are sanitized too, not just top-level strings', () => {
    test('a secret-bearing URL nested inside an object field (not just a top-level field) is redacted', () => {
      const { stderr } = captureStreams(() =>
        logOperation('some_op', {
          operation: 'thing',
          outcome: 'error',
          durationMs: 1,
          reason: {
            cause: 'all_engines_unresponsive',
            detail: 'https://user:pw@example.com/x?token=NESTEDSECRET',
          },
        }),
      );
      const line = stderr[0]!;
      assert.ok(
        !line.includes('NESTEDSECRET'),
        `secret leaked one level down: ${line}`,
      );
      assert.ok(
        !line.includes('user:pw@'),
        `credentials leaked one level down: ${line}`,
      );
    });

    test('a large array nested inside an object field is capped and each entry sanitized, matching a top-level array', () => {
      const manyEngines = Array.from({ length: 60 }, (_, i) => `engine-${i}`);
      manyEngines[5] = 'https://u:p@ex.com/x?token=SECRET0';
      const { stderr } = captureStreams(() =>
        logOperation('some_op', {
          operation: 'thing',
          outcome: 'error',
          durationMs: 1,
          reason: {
            cause: 'all_engines_unresponsive',
            engines: manyEngines,
          },
        }),
      );
      const line = stderr[0]!;
      assert.ok(
        !line.includes('SECRET0'),
        `secret leaked in a nested array: ${line}`,
      );
      assert.ok(
        !line.includes('u:p@'),
        `credentials leaked in a nested array: ${line}`,
      );
      const parsed = JSON.parse(line) as {
        reason: { engines: string[] };
      };
      assert.equal(parsed.reason.engines.length, MAX_ARRAY_ITEMS);
    });

    test('reason.cause (a short enum) and reason.status (a number) still come through byte-identical', () => {
      const { stderr } = captureStreams(() =>
        logOperation('some_op', {
          operation: 'thing',
          outcome: 'error',
          durationMs: 1,
          reason: { cause: 'http_status', status: 429 },
        }),
      );
      const parsed = JSON.parse(stderr[0]!) as Record<string, unknown>;
      assert.deepEqual(parsed.reason, { cause: 'http_status', status: 429 });
    });

    test('nesting deeper than MAX_SANITIZE_DEPTH is collapsed rather than emitted raw', () => {
      // Build a chain deeper than the budget, with a secret at the bottom.
      let deep: unknown = 'https://u:p@example.com/x?token=DEEPSECRET';
      for (let i = 0; i < MAX_SANITIZE_DEPTH + 3; i++) {
        deep = { nested: deep };
      }
      const { stderr } = captureStreams(() =>
        logOperation('some_op', {
          operation: 'thing',
          outcome: 'error',
          durationMs: 1,
          payload: deep,
        }),
      );
      const line = stderr[0]!;
      assert.ok(
        !line.includes('DEEPSECRET'),
        `secret leaked past the depth budget: ${line}`,
      );
    });
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
