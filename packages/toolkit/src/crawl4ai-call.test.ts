/**
 * Exercises `call()` (crawl4ai.ts) directly against a real (minimal) MCP SSE
 * peer, covering the behavior `crawl4ai-mcp-client-timeout-and-recovery`
 * adds: an explicit, configurable per-`callTool` timeout; a bounded
 * connect-level retry; a `connecting` promise that never latches even when
 * an `initialize`-phase failure fires no transport-level `onerror`/`onclose`
 * of its own; close-on-discard for a connection-level failure; and no
 * discard/retry for an operation-level failure, which is what keeps
 * concurrent calls unaffected and stops a repeated operation-level failure
 * from leaking a connection per attempt.
 *
 * Follows `crawl4ai-probe.test.ts`'s pattern: a minimal `node:http` +
 * `SSEServerTransport` stand-in, `mode`-driven, with `CRAWL4AI_URL` (and,
 * for this file, `CRAWL4AI_CALL_TIMEOUT_MS`) set before any dynamic import
 * of `crawl4ai.js` — `Config` is parsed once per process, and `node --test`
 * gives each test file its own process.
 *
 * `CRAWL4AI_CALL_TIMEOUT_MS` is set to a small value (300ms) for this whole
 * file rather than the real ~150s production default: every scenario below
 * proves the *mechanism* (an explicit, configurable timeout that is
 * actually honored, distinct from the SDK's 60s default) using delays
 * scaled proportionally down, the same convention `crawl4ai-probe.test.ts`
 * already uses for its own timeout-classification tests (e.g.
 * `probeCrawl4AI(500)`). Waiting out a literal 60s in a unit test is not
 * attempted; the scaled-down window still requires plumbing a real,
 * distinct-from-default `timeout` argument through to the SDK, which is
 * exactly what the fix does and what a hard-coded 60s default would fail.
 */
import assert from 'node:assert/strict';
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  ErrorCode,
  McpError,
  type JSONRPCMessage,
} from '@modelcontextprotocol/sdk/types.js';

type ToolResult = {
  content?: { type: string; text?: string }[];
  isError?: boolean;
};

/** Shape of the handful of JSON-RPC fields this fake needs to look at. */
type IncomingRpc = {
  method?: string;
  id?: string | number;
  params?: { protocolVersion?: string; arguments?: Record<string, unknown> };
};

/**
 * - `ok`             : answers `initialize` normally; answers `tools/call`
 *                      with a fast, successful result.
 * - `init_error`     : answers `initialize` with a JSON-RPC error — a fast,
 *                      deterministic `initialize`-phase failure with no
 *                      transport-level break. This is this file's stand-in
 *                      for the card's "handshake timing out / returning a
 *                      protocol error" connection-level failure class: it
 *                      makes `getClient()` (and therefore `call()`) reject,
 *                      the same as a real handshake timeout would, without
 *                      needing to wait out a real timeout window.
 * - `toolcall_error` : `initialize` succeeds; `tools/call` answers with a
 *                      JSON-RPC error — a fast, deterministic
 *                      operation-level failure that is not a timeout.
 * - `toolcall_silent`: `initialize` succeeds; `tools/call` is never
 *                      answered — drives the SDK's own request-level
 *                      timeout, bounded here by the explicit
 *                      `Config.crawl4ai.callTimeoutMs` this file configures
 *                      small, rather than the SDK's 60s default.
 * - `toolcall_delayed`: `initialize` succeeds; `tools/call` is answered
 *                      successfully after `toolCallDelayMs`.
 * - `per_url`        : `initialize` succeeds; `tools/call`'s answer is
 *                      chosen per request from its own `url` argument
 *                      (`fail` -> JSON-RPC error, `slow` -> delayed
 *                      success, anything else -> immediate success) — used
 *                      only for the concurrency scenario, where two calls
 *                      are in flight at once and a single shared `mode`
 *                      could not distinguish which incoming request belongs
 *                      to which caller.
 */
let mode:
  | 'ok'
  | 'init_error'
  | 'toolcall_error'
  | 'toolcall_silent'
  | 'toolcall_delayed'
  | 'per_url' = 'ok';

/** Delay (ms) `tools/call` waits before answering under `toolcall_delayed`. */
let toolCallDelayMs = 0;

/** Counts every `GET /mcp/sse` hit (one per connect attempt, successful or not). */
let connectAttempts = 0;
/** Counts every `initialize` JSON-RPC request the fake receives. */
let initializeAttempts = 0;
/** Counts every `tools/call` JSON-RPC request the fake receives. */
let toolCallAttempts = 0;

const openTransports = new Set<SSEServerTransport>();
let httpServer: Server;

async function successResult(
  id: string | number,
  transport: SSEServerTransport,
) {
  await transport.send({
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text: 'ok' }] },
  } as unknown as JSONRPCMessage);
}

async function errorResult(id: string | number, transport: SSEServerTransport) {
  await transport.send({
    jsonrpc: '2.0',
    id,
    error: { code: -32000, message: 'fake tool-call rejection' },
  } as unknown as JSONRPCMessage);
}

async function answer(
  transport: SSEServerTransport,
  message: IncomingRpc,
): Promise<void> {
  if (message.id === undefined) return; // a notification; nothing to answer

  if (message.method === 'initialize') {
    initializeAttempts++;
    if (mode === 'init_error') {
      await transport.send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32000, message: 'fake init rejection' },
      } as unknown as JSONRPCMessage);
      return;
    }
    await transport.send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-crawl4ai-call', version: '0.0.0' },
      },
    } as unknown as JSONRPCMessage);
    return;
  }

  if (message.method === 'tools/call') {
    toolCallAttempts++;

    if (mode === 'per_url') {
      const url = String(message.params?.arguments?.url ?? '');
      if (url.includes('fail')) {
        await errorResult(message.id, transport);
        return;
      }
      if (url.includes('slow')) {
        await new Promise(resolve =>
          setTimeout(resolve, toolCallDelayMs || 100),
        );
      }
      await successResult(message.id, transport);
      return;
    }

    if (mode === 'toolcall_silent') return; // never answers -> drives the SDK's request timeout
    if (mode === 'toolcall_error') {
      await errorResult(message.id, transport);
      return;
    }
    if (mode === 'toolcall_delayed' && toolCallDelayMs > 0) {
      await new Promise(resolve => setTimeout(resolve, toolCallDelayMs));
    }
    await successResult(message.id, transport);
  }
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');

  if (req.method === 'GET' && url.pathname === '/mcp/sse') {
    connectAttempts++;
    const transport = new SSEServerTransport('/messages', res);
    openTransports.add(transport);
    res.on('close', () => openTransports.delete(transport));
    transport.onmessage = message => {
      void answer(transport, message as unknown as IncomingRpc);
    };
    await transport.start();
    return;
  }

  if (req.method === 'POST' && url.pathname === '/messages') {
    const sessionId = url.searchParams.get('sessionId');
    const transport = [...openTransports].find(t => t.sessionId === sessionId);
    if (!transport) {
      res.writeHead(400).end('unknown session');
      return;
    }
    await transport.handlePostMessage(req, res);
    return;
  }

  res.writeHead(404).end();
}

before(async () => {
  httpServer = createServer((req, res) => {
    void handle(req, res);
  });
  httpServer.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => httpServer.once('listening', resolve));
  const address = httpServer.address() as AddressInfo;

  process.env.CRAWL4AI_URL = `http://127.0.0.1:${address.port}`;
  // Small and fixed for the whole file -- see the file-level comment for why.
  process.env.CRAWL4AI_CALL_TIMEOUT_MS = '300';
});

after(async () => {
  for (const transport of openTransports) void transport.close();
  openTransports.clear();
  httpServer.closeAllConnections?.();
  await new Promise<void>(resolve => httpServer.close(() => resolve()));
});

/** Fresh `crawl4ai.js` instance so its memoised client starts cold. */
let instance = 0;
async function freshModule(): Promise<typeof import('./crawl4ai.js')> {
  instance++;
  return (await import(
    `./crawl4ai.js?call-test-instance=${instance}`
  )) as typeof import('./crawl4ai.js');
}

// ── Explicit, configurable timeout ───────────────────────────────────────

test('a call slower than a naive small bound still succeeds within the configured ceiling', async () => {
  mode = 'toolcall_delayed';
  toolCallDelayMs = 100; // well under the file's configured 300ms ceiling
  const { callCrawlTool } = await freshModule();

  const result = (await callCrawlTool({
    url: 'https://example.invalid/',
  })) as ToolResult;

  assert.equal(result.content?.[0]?.text, 'ok');
});

test('the explicit timeout is really wired to the SDK request, not the 60s default: an unanswered call fails fast, at the configured ceiling', async () => {
  mode = 'toolcall_silent';
  connectAttempts = 0;
  toolCallAttempts = 0;
  const { callCrawlTool } = await freshModule();

  const start = Date.now();
  await assert.rejects(
    () => callCrawlTool({ url: 'https://example.invalid/' }),
    (err: unknown) =>
      err instanceof McpError && err.code === ErrorCode.RequestTimeout,
  );
  const elapsed = Date.now() - start;

  assert.ok(
    elapsed < 5000,
    `expected the configured ~300ms timeout to fire, not the SDK's 60s default (took ${elapsed}ms)`,
  );
  assert.equal(toolCallAttempts, 1, 'the tool call itself must not be retried');
  assert.equal(
    connectAttempts,
    1,
    'an operation-level timeout must not trigger a reconnect',
  );
});

// ── Connection-level failure: bounded retry, no latching, close-on-discard ─

test('a connection-level failure is retried exactly once before surfacing', async () => {
  mode = 'init_error';
  connectAttempts = 0;
  const { callCrawlTool } = await freshModule();

  await assert.rejects(() =>
    callCrawlTool({ url: 'https://example.invalid/' }),
  );

  assert.equal(
    connectAttempts,
    2,
    'expected exactly one retry (two total connect attempts) before the error surfaced',
  );
});

test('an initialize-phase failure does not latch `connecting`: the next call opens a genuinely fresh connection and can succeed', async () => {
  mode = 'init_error';
  connectAttempts = 0;
  const { callCrawlTool } = await freshModule();

  await assert.rejects(() =>
    callCrawlTool({ url: 'https://example.invalid/' }),
  );
  const attemptsAfterFailure = connectAttempts;

  mode = 'ok';
  const result = (await callCrawlTool({
    url: 'https://example.invalid/',
  })) as ToolResult;

  assert.equal(result.content?.[0]?.text, 'ok');
  assert.ok(
    connectAttempts > attemptsAfterFailure,
    'the next call must attempt a genuinely fresh connect, not reuse a latched rejected promise',
  );
});

test("`connecting` does not latch even if the MCP SDK's own internal close() cascade is defeated", async () => {
  // `Client.connect()` (the MCP SDK) happens to call its own `this.close()`
  // internally before rethrowing on any `initialize`-phase failure, which
  // today cascades to crawl4ai.ts's `onclose` handler and would, by itself,
  // already clear shared state for the scenario above -- see the comment on
  // `getClient()`'s own `catch` around `c.connect()` in crawl4ai.ts. This
  // test proves crawl4ai.ts's own explicit `catch` is what actually
  // provides the guarantee, independent of that SDK-internal detail: it
  // patches `Client.prototype.close` to a no-op, defeating the cascade, and
  // still expects a fresh connect attempt on the next call. (Verified
  // empirically before writing this test: with crawl4ai.ts's `catch`
  // removed and this same patch applied, `connecting` does latch and the
  // second call reuses the same dead, already-rejected promise.)
  mode = 'init_error';
  connectAttempts = 0;
  const originalClose = Client.prototype.close;
  Client.prototype.close = async function patchedClose() {
    // no-op: defeats the SDK's own internal self-heal cascade
  };

  try {
    const { callCrawlTool } = await freshModule();

    await assert.rejects(() =>
      callCrawlTool({ url: 'https://example.invalid/' }),
    );
    const attemptsAfterFailure = connectAttempts;

    mode = 'ok';
    const result = (await callCrawlTool({
      url: 'https://example.invalid/',
    })) as ToolResult;

    assert.equal(result.content?.[0]?.text, 'ok');
    assert.ok(
      connectAttempts > attemptsAfterFailure,
      "a fresh connect attempt must happen even with the SDK's own internal close() cascade defeated",
    );
  } finally {
    Client.prototype.close = originalClose;
  }
});

test('a connection-level failure closes every transport it built (no leaked SSE connection)', async () => {
  mode = 'init_error';
  connectAttempts = 0;
  let closeCalls = 0;
  const originalClose = SSEClientTransport.prototype.close;
  SSEClientTransport.prototype.close = async function patchedClose(
    this: SSEClientTransport,
    ...args: unknown[]
  ) {
    closeCalls++;
    return (originalClose as (...a: unknown[]) => Promise<void>).apply(
      this,
      args,
    );
  };

  try {
    const { callCrawlTool } = await freshModule();
    await assert.rejects(() =>
      callCrawlTool({ url: 'https://example.invalid/' }),
    );

    // At least once per connect attempt (two attempts: one plus the bounded
    // retry). Can legitimately be more than `connectAttempts`: the MCP
    // SDK's own `Client.connect()` also calls its own `this.close()`
    // internally on an `initialize`-phase failure (see the comment on
    // `getClient()`'s `catch` around `c.connect()` in crawl4ai.ts), so a
    // single failed attempt can see `close()` invoked both by that
    // SDK-internal cascade and by crawl4ai.ts's own explicit
    // `resetClient()` call -- redundant, but harmless (idempotent,
    // best-effort) and not what this test is pinning down.
    assert.ok(
      closeCalls >= connectAttempts,
      `expected close() invoked at least once per connect attempt (${connectAttempts} attempts, ${closeCalls} close() calls)`,
    );
    assert.equal(
      connectAttempts,
      2,
      'expected exactly the bounded retry (two attempts)',
    );
  } finally {
    SSEClientTransport.prototype.close = originalClose;
  }
});

// ── Operation-level failure: no retry, no discard ────────────────────────

test('an upstream operation timeout is not retried: no second connect and the tool call itself runs once', async () => {
  mode = 'toolcall_silent';
  connectAttempts = 0;
  toolCallAttempts = 0;
  const { callCrawlTool } = await freshModule();

  await assert.rejects(
    () => callCrawlTool({ url: 'https://example.invalid/' }),
    (err: unknown) =>
      err instanceof McpError && err.code === ErrorCode.RequestTimeout,
  );

  assert.equal(connectAttempts, 1, 'no retry on an operation-level timeout');
  assert.equal(toolCallAttempts, 1, 'the tool call itself must not be retried');
});

test("one call's operation-level failure does not disturb a concurrent call sharing the connection", async () => {
  mode = 'ok';
  const { callCrawlTool } = await freshModule();

  // Warm the shared connection first so both calls below definitely share
  // one already-established client.
  await callCrawlTool({ url: 'https://example.invalid/warm' });

  mode = 'per_url';
  const failing = callCrawlTool({ url: 'https://example.invalid/fail-me' });
  const succeeding = callCrawlTool({
    url: 'https://example.invalid/slow-but-ok',
  });

  await assert.rejects(() => failing);
  const result = (await succeeding) as ToolResult;
  assert.equal(
    result.content?.[0]?.text,
    'ok',
    "the concurrent call must still resolve normally despite the other call's failure",
  );
});

test('N sequential operation-level failures open at most one connection (no leak)', async () => {
  mode = 'toolcall_error';
  connectAttempts = 0;
  const { callCrawlTool } = await freshModule();

  const N = 5;
  for (let i = 0; i < N; i++) {
    await assert.rejects(() =>
      callCrawlTool({ url: `https://example.invalid/${i}` }),
    );
  }

  assert.equal(
    connectAttempts,
    1,
    `expected exactly one connection across ${N} operation-level failures`,
  );
});
