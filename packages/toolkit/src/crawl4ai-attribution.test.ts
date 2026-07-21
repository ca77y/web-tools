/**
 * Table-driven coverage for `runOperation()` wrapping all nine public tool
 * functions, plus Crawl4AI failure-path target attribution, driven from
 * `functionMap` so a forgotten wrap (or a payload-altering one) fails.
 *
 * Six of the nine tools reach Crawl4AI over MCP/SSE, not `fetch`
 * (`web_fetch`, `web_screenshot`, `web_pdf`, `web_execute_js`, `web_crawl`,
 * and `web_archive` via `getArchivedPage` -> `callMdTool`). A closed port
 * only exercises the connection-failure path; the `isError`/empty-content
 * paths need a real, responding MCP server. This file boots a minimal
 * `node:http` + `SSEServerTransport` + `McpServer` stand-in registering the
 * five upstream tool names, points `CRAWL4AI_URL` at it, and only then
 * reaches the toolkit through a dynamic `import()` — `Config` is parsed
 * once at module load, so the env var must be set first. `web_search` and
 * `web_snapshots` are driven by a `globalThis.fetch` stub instead (they
 * never touch Crawl4AI); `web_usage_stats` touches no upstream at all.
 *
 * The closed-port-only scenarios (the thrown proxyCrawl4AI path, the
 * argument-shape redaction test) live in the separate
 * `crawl4ai-closed-port.test.ts`, because a single process can only bind
 * one `CRAWL4AI_URL` for its `Config`'s lifetime; `node --test` gives each
 * test file its own process, so the two files don't interfere.
 */
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, afterEach, describe, test } from 'node:test';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

// ── MCP stand-in fixture ─────────────────────────────────────────────

const STAND_IN_TOOL_NAMES = [
  'crawl',
  'md',
  'screenshot',
  'pdf',
  'execute_js',
] as const;
type StandInToolName = (typeof STAND_IN_TOOL_NAMES)[number];
type StandInReply = { kind: 'ok' | 'error' | 'empty'; text?: string };

function createCrawl4AIStandIn() {
  const replies: Record<StandInToolName, StandInReply> = {
    crawl: { kind: 'ok', text: 'stand-in crawl content' },
    md: { kind: 'ok', text: 'stand-in md content' },
    screenshot: { kind: 'ok', text: 'stand-in-base64-image' },
    pdf: { kind: 'ok', text: 'stand-in-base64-pdf' },
    execute_js: { kind: 'ok', text: '{"result":true}' },
  };

  const mcpServer = new McpServer({
    name: 'crawl4ai-standin',
    version: '1.0.0',
  });
  for (const name of STAND_IN_TOOL_NAMES) {
    mcpServer.tool(name, 'stand-in tool', {}, async () => {
      const reply = replies[name];
      if (reply.kind === 'error') {
        return {
          content: [
            { type: 'text' as const, text: reply.text ?? 'stand-in error' },
          ],
          isError: true,
        };
      }
      if (reply.kind === 'empty') {
        // An empty string (not merely whitespace) is what actually trips
        // the `every((c) => !c.text)` empty-content check in
        // `proxyCrawl4AI` (functions.ts) — whitespace is truthy there.
        return { content: [{ type: 'text' as const, text: '' }] };
      }
      return { content: [{ type: 'text' as const, text: reply.text ?? '' }] };
    });
  }

  let activeTransport: SSEServerTransport | null = null;
  const httpServer = createHttpServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/mcp/sse') {
        activeTransport = new SSEServerTransport('/mcp/messages', res);
        await mcpServer.connect(activeTransport);
        return;
      }
      if (req.method === 'POST' && url.pathname === '/mcp/messages') {
        if (!activeTransport) {
          res.writeHead(400).end('no active SSE connection');
          return;
        }
        await activeTransport.handlePostMessage(req, res);
        return;
      }
      res.writeHead(404).end();
    })();
  });

  return {
    setReply(name: StandInToolName, reply: StandInReply): void {
      replies[name] = reply;
    },
    resetReplies(): void {
      replies.crawl = { kind: 'ok', text: 'stand-in crawl content' };
      replies.md = { kind: 'ok', text: 'stand-in md content' };
      replies.screenshot = { kind: 'ok', text: 'stand-in-base64-image' };
      replies.pdf = { kind: 'ok', text: 'stand-in-base64-pdf' };
      replies.execute_js = { kind: 'ok', text: '{"result":true}' };
    },
    async start(): Promise<string> {
      await new Promise<void>(resolve =>
        httpServer.listen(0, '127.0.0.1', resolve),
      );
      const address = httpServer.address() as AddressInfo;
      return `http://127.0.0.1:${address.port}`;
    },
  };
}

const standIn = createCrawl4AIStandIn();
const standInBaseUrl = await standIn.start();
process.env.CRAWL4AI_URL = standInBaseUrl;

const { functionMap, web_search, web_crawl, web_snapshots } =
  await import('./functions.js');
const { SearchProviderError } = await import('./searxng.js');

// ── fetch stub (branches on URL: SearXNG vs Wayback CDX) ─────────────

const originalFetch = globalThis.fetch;
const originalStderrWrite = process.stderr.write.bind(process.stderr);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubFetch(mode: 'success' | 'failure' | 'reject'): void {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (mode === 'reject') throw new TypeError('network down');
    // Check the CDX endpoint first: its path ("/cdx/search/cdx") contains
    // "/search" as a substring, so a "/search"-first check would shadow it.
    if (url.includes('/cdx/search/cdx')) {
      return mode === 'success'
        ? jsonResponse([
            [
              'timestamp',
              'original',
              'mimetype',
              'statuscode',
              'digest',
              'length',
            ],
            [
              '20200101000000',
              'https://example.com/',
              'text/html',
              '200',
              'abc',
              '123',
            ],
          ])
        : jsonResponse({}, 503);
    }
    if (url.includes('/search')) {
      return mode === 'success'
        ? jsonResponse({
            results: [
              { url: 'https://a.example', title: 'A', content: 'body' },
            ],
          })
        : jsonResponse({}, 503);
    }
    throw new Error(`unexpected fetch to ${url}`);
  }) as typeof fetch;
}

async function captureStderr<T>(
  fn: () => Promise<T>,
): Promise<{ lines: string[]; error?: unknown; result?: T }> {
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
  return { lines: chunks.join('').split('\n').filter(Boolean), error, result };
}

function parseAll(lines: string[]): Record<string, unknown>[] {
  return lines.map(line => JSON.parse(line) as Record<string, unknown>);
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  standIn.resetReplies();
});

// ── table-driven: minimal args + failure/success wiring per tool ────

const CRAWL4AI_TOOL_FOR: Partial<Record<string, StandInToolName>> = {
  web_fetch: 'crawl',
  web_screenshot: 'screenshot',
  web_pdf: 'pdf',
  web_execute_js: 'execute_js',
  web_crawl: 'crawl',
  web_archive: 'md',
};

function argsFor(name: string): Record<string, unknown> {
  switch (name) {
    case 'web_search':
      return { query: 'q' };
    case 'web_fetch':
    case 'web_screenshot':
    case 'web_pdf':
      return { url: 'https://example.com/a' };
    case 'web_execute_js':
      return { url: 'https://example.com/a', scripts: ['1+1'] };
    case 'web_crawl':
      return { urls: ['https://example.com/a'] };
    case 'web_snapshots':
      return { url: 'https://example.com/a' };
    case 'web_archive':
      return { url: 'https://example.com/a', timestamp: '20200101000000' };
    case 'web_usage_stats':
      return {};
    default:
      throw new Error(`no args configured for ${name}`);
  }
}

function configureFailure(name: string): void {
  if (name === 'web_search' || name === 'web_snapshots') {
    stubFetch('failure');
    return;
  }
  const toolName = CRAWL4AI_TOOL_FOR[name];
  if (toolName)
    standIn.setReply(toolName, { kind: 'error', text: 'stand-in failure' });
}

function configureSuccess(name: string): void {
  if (name === 'web_search' || name === 'web_snapshots') {
    stubFetch('success');
    return;
  }
  const toolName = CRAWL4AI_TOOL_FOR[name];
  if (toolName)
    standIn.setReply(toolName, { kind: 'ok', text: 'stand-in ok content' });
}

const TOOLS_WITH_UPSTREAM = Object.keys(functionMap).filter(
  name => name !== 'web_usage_stats',
);

describe('table-driven: every one of the nine public tools is wrapped (failure path)', () => {
  for (const name of TOOLS_WITH_UPSTREAM) {
    test(`${name} - a deterministic failure emits exactly one operation record for this tool, correlated`, async () => {
      configureFailure(name);
      const { lines } = await captureStderr(() =>
        functionMap[name]!(argsFor(name)).catch(() => undefined),
      );
      const records = parseAll(lines);

      const toolRecords = records.filter(
        r => r.kind === 'operation' && r.operation === name,
      );
      assert.equal(
        toolRecords.length,
        1,
        `expected exactly one operation record for ${name}`,
      );
      const rec = toolRecords[0]!;
      assert.equal(typeof rec.requestId, 'string');
      assert.ok((rec.requestId as string).length > 0);
      assert.ok(['ok', 'empty', 'error'].includes(rec.outcome as string));
      assert.equal(typeof rec.durationMs, 'number');
      assert.ok(
        Number.isFinite(rec.durationMs as number) &&
          (rec.durationMs as number) >= 0,
      );

      const withRequestId = records.filter(
        r => typeof r.requestId === 'string',
      );
      const ids = new Set(withRequestId.map(r => r.requestId));
      assert.equal(
        ids.size,
        1,
        'every record emitted during this invocation must share its requestId',
      );
    });
  }

  test('two sequential invocations of the same tool carry different requestId values', async () => {
    configureFailure('web_crawl');
    const first = await captureStderr(() =>
      web_crawl(argsFor('web_crawl')).catch(() => undefined),
    );
    configureFailure('web_crawl');
    const second = await captureStderr(() =>
      web_crawl(argsFor('web_crawl')).catch(() => undefined),
    );

    const firstId = parseAll(first.lines).find(
      r => r.operation === 'web_crawl',
    )?.requestId;
    const secondId = parseAll(second.lines).find(
      r => r.operation === 'web_crawl',
    )?.requestId;
    assert.ok(firstId);
    assert.ok(secondId);
    assert.notEqual(firstId, secondId);
  });
});

describe('table-driven: every one of the nine public tools is wrapped (success path)', () => {
  for (const name of Object.keys(functionMap)) {
    test(`${name} - a deterministic success returns the unwrapped value and logs outcome ok`, async () => {
      configureSuccess(name);
      const { lines, result, error } = await captureStderr(() =>
        functionMap[name]!(argsFor(name)),
      );
      assert.equal(
        error,
        undefined,
        `${name} must not throw on a deterministic success`,
      );

      const records = parseAll(lines);
      const toolRecord = records.find(
        r => r.kind === 'operation' && r.operation === name,
      );
      assert.ok(toolRecord, `expected an operation record for ${name}`);
      assert.equal(toolRecord.outcome, 'ok');

      // No wrapper, no added/removed field: the return value's own shape is
      // untouched by runOperation.
      if (name === 'web_search' || name === 'web_snapshots') {
        assert.ok(Array.isArray(result), `${name} must return a bare array`);
      } else if (name === 'web_archive') {
        assert.ok(result && typeof result === 'object');
        assert.deepEqual(
          Object.keys(result as object).sort(),
          ['content', 'contentLength', 'waybackUrl'].sort(),
        );
      } else if (name === 'web_usage_stats') {
        assert.ok(
          result &&
            typeof result === 'object' &&
            'started_at' in (result as object),
        );
      } else {
        // The five Crawl4AI-backed ToolResult tools.
        assert.ok(result && typeof result === 'object');
        assert.ok(Array.isArray((result as { content: unknown }).content));
        assert.ok(
          !('requestId' in (result as object)),
          'runOperation must not decorate the return value',
        );
      }
    });
  }
});

describe('table-driven: a tool that throws today is driven to throw, unchanged', () => {
  test('web_search on a total SearXNG outage rethrows SearchProviderError unchanged, outcome error', async () => {
    stubFetch('failure');
    const { lines, error } = await captureStderr(() =>
      web_search({ query: 'q' }),
    );
    assert.ok(error instanceof SearchProviderError);
    assert.equal((error as Error).name, 'SearchProviderError');

    const rec = parseAll(lines).find(
      r => r.kind === 'operation' && r.operation === 'web_search',
    );
    assert.ok(rec);
    assert.equal(rec.outcome, 'error');
  });

  test('web_snapshots on a rejected fetch rethrows unchanged, outcome error', async () => {
    stubFetch('reject');
    const { lines, error } = await captureStderr(() =>
      web_snapshots({ url: 'https://example.com/a' }),
    );
    assert.ok(error instanceof Error);
    assert.equal((error as Error).message, 'network down');

    const rec = parseAll(lines).find(
      r => r.kind === 'operation' && r.operation === 'web_snapshots',
    );
    assert.ok(rec);
    assert.equal(rec.outcome, 'error');
  });
});

// ── Crawl4AI failure-path target attribution ─────────────────────────

describe('Crawl4AI failures name their target', () => {
  test('the error-response path names the target', async () => {
    standIn.setReply('crawl', { kind: 'error', text: 'boom' });
    const { lines, result } = await captureStderr(() =>
      web_crawl({ urls: ['https://example.com/a/b'] }),
    );
    assert.equal(result?.isError, true);

    const rec = parseAll(lines).find(r => r.event === 'crawl4ai_call');
    assert.ok(rec);
    assert.equal(rec.outcome, 'error');
    assert.equal(rec.targetUrl, 'https://example.com/a/b');
    assert.equal(typeof rec.durationMs, 'number');
  });

  test('the empty-content path names the target', async () => {
    standIn.setReply('crawl', { kind: 'empty' });
    const { lines, result } = await captureStderr(() =>
      web_crawl({ urls: ['https://example.com/a/b'] }),
    );
    assert.equal(result?.isError, true);

    const rec = parseAll(lines).find(r => r.event === 'crawl4ai_call');
    assert.ok(rec);
    assert.equal(rec.outcome, 'empty');
    assert.equal(rec.targetUrl, 'https://example.com/a/b');
  });

  test('a multi-URL crawl records its first target and the total count', async () => {
    standIn.setReply('crawl', { kind: 'error', text: 'boom' });
    const { lines } = await captureStderr(() =>
      web_crawl({
        urls: [
          'https://alpha.example/x',
          'https://beta.example/y',
          'https://gamma.example/z',
        ],
      }),
    );
    const rec = parseAll(lines).find(r => r.event === 'crawl4ai_call');
    assert.ok(rec);
    assert.equal(rec.targetUrl, 'https://alpha.example/x');
    assert.equal(rec.targetUrlCount, 3);
  });

  test('the target URL is sanitized: userinfo, query, and fragment never reach a log line', async () => {
    standIn.setReply('crawl', { kind: 'error', text: 'boom' });
    const { lines } = await captureStderr(() =>
      web_crawl({
        urls: ['https://user:pw@example.com/a/b?token=SUPERSECRET#frag'],
      }),
    );
    const joined = lines.join('\n');
    assert.ok(!joined.includes('SUPERSECRET'));
    assert.ok(!joined.includes('token='));
    assert.ok(!joined.includes('pw'));

    const rec = parseAll(lines).find(r => r.event === 'crawl4ai_call');
    assert.ok(rec);
    assert.equal(rec.targetUrl, 'https://example.com/a/b');
    assert.equal(rec.targetHasQuery, true);
  });

  test('the requestId in the caller-visible error text matches the logged record (error-response path)', async () => {
    standIn.setReply('crawl', { kind: 'error', text: 'boom' });
    const { lines, result } = await captureStderr(() =>
      web_crawl({ urls: ['https://example.com/a'] }),
    );
    assert.equal(result?.isError, true);
    const rec = parseAll(lines).find(r => r.event === 'crawl4ai_call');
    assert.ok(rec);
    const text = result!.content[0]!.text;
    assert.ok(text.includes(rec!.requestId as string));
  });

  test('the requestId in the caller-visible error text matches the logged record (empty-content path)', async () => {
    standIn.setReply('crawl', { kind: 'empty' });
    const { lines, result } = await captureStderr(() =>
      web_crawl({ urls: ['https://example.com/a'] }),
    );
    assert.equal(result?.isError, true);
    const rec = parseAll(lines).find(r => r.event === 'crawl4ai_call');
    assert.ok(rec);
    const text = result!.content[0]!.text;
    assert.ok(text.includes(rec!.requestId as string));
  });
});

// ── Concurrency attribution ───────────────────────────────────────────

describe('concurrent context-free calls get distinct IDs', () => {
  test('three concurrent web_crawl calls each get a distinct requestId, and each host is attributed to exactly one', async () => {
    standIn.setReply('crawl', { kind: 'ok', text: 'stand-in ok content' });
    const urls = [
      'https://alpha.example/x',
      'https://beta.example/y',
      'https://gamma.example/z',
    ];

    const chunks: string[] = [];
    process.stderr.write = ((chunk: unknown) => {
      chunks.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await Promise.all(urls.map(url => web_crawl({ urls: [url] })));
    } finally {
      process.stderr.write = originalStderrWrite;
    }
    const records = parseAll(chunks.join('').split('\n').filter(Boolean));

    const toolRecords = records.filter(r => r.operation === 'web_crawl');
    assert.equal(toolRecords.length, 3);
    const ids = new Set(toolRecords.map(r => r.requestId));
    assert.equal(
      ids.size,
      3,
      'three concurrent calls must get three distinct requestIds',
    );

    const crawlRecords = records.filter(r => r.event === 'crawl4ai_call');
    assert.equal(crawlRecords.length, 3);
    for (const rec of crawlRecords) {
      assert.ok(
        ids.has(rec.requestId),
        'every Crawl4AI record must match one of the three originating calls',
      );
    }

    const hostToIds = new Map<string, Set<unknown>>();
    for (const rec of crawlRecords) {
      const host = new URL(rec.targetUrl as string).host;
      const set = hostToIds.get(host) ?? new Set();
      set.add(rec.requestId);
      hostToIds.set(host, set);
    }
    assert.equal(hostToIds.size, 3);
    for (const set of hostToIds.values()) {
      assert.equal(
        set.size,
        1,
        'each sanitized target host must appear under exactly one requestId',
      );
    }
  });
});

after(async () => {
  // The toolkit's Crawl4AI client (crawl4ai.ts) is a module-level singleton
  // with no exported close(): its SSE connection is EventSource-backed, and
  // EventSource auto-reconnects whenever its stream ends — including when
  // the stand-in server above is torn down. There is no seam to tell the
  // toolkit's client to stop retrying, so the reconnect loop would keep
  // this file's dedicated `node --test` child process alive forever.
  // `node --test` isolates each test file in its own process, so exiting
  // here only ends this file's run, not the sibling files in the suite.
  // A short delay lets the test runner finish reporting the last test's
  // result before the process disappears out from under it.
  await new Promise(resolve => setTimeout(resolve, 100));
  process.exit(0);
});
