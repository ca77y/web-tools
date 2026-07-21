/**
 * Exercises `probeCrawl4AI()` directly against a real (minimal) MCP SSE
 * peer, covering the classification branches that `readiness.test.ts` and
 * `packages/api/src/ready.test.ts` cannot reach.
 *
 * Those two files only ever drive Crawl4AI into the `network_error`
 * branch (a connect that answers a clean non-200). The spec calls the
 * timeout-vs-rejection discrimination "exact, not a judgement call", so
 * the two remaining branches need direct coverage:
 *   - `tools/list` answered with a JSON-RPC error → `protocol_error`
 *     (an `McpError` whose code is not `RequestTimeout`);
 *   - `tools/list` never answered → `timeout` (an `McpError` whose code
 *     *is* `RequestTimeout`), bounded by the caller's `timeoutMs`.
 * It also covers recovery: after a failed probe the memoised client must
 * not be left permanently poisoned, so a later probe succeeds once the
 * dependency answers again.
 *
 * The fake server never refuses a connection or hangs a connect: per the
 * note in `packages/api/src/ready.test.ts`, the `eventsource` package
 * behind `SSEClientTransport` retries a refused/hung connect roughly
 * every 3s forever, which leaks a timer that can keep `node --test`
 * alive. "Down" is therefore always a clean, immediate HTTP 503.
 *
 * `Config` freezes `process.env` on first import, and `crawl4ai.ts`
 * memoises its client at module scope, so this file makes no static
 * toolkit import: `before()` starts the fake and sets `CRAWL4AI_URL`, and
 * each test that needs a cold client dynamically imports `crawl4ai.js`
 * with a cache-busting query string.
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
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

type ProbeResult = { status: string; latency_ms: number; detail?: string };

/** Shape of the handful of JSON-RPC fields this fake needs to look at. */
type IncomingRpc = {
  method?: string;
  id?: string | number;
  params?: { protocolVersion?: string };
};

/**
 * - `ok`                : answers `tools/list` normally
 * - `protocol_error`    : answers `tools/list` with a JSON-RPC error
 * - `silent`            : accepts `tools/list` and never answers it
 * - `connect_unavailable`: answers `GET /mcp/sse` with a clean 503
 */
let mode: 'ok' | 'protocol_error' | 'silent' | 'connect_unavailable' = 'ok';

const openTransports = new Set<SSEServerTransport>();
let httpServer: Server;

/** SSE `retry:` hint handed to clients — see the teardown note in `after()`. */
const RECONNECT_HINT_MS = 50;

async function answer(
  transport: SSEServerTransport,
  message: IncomingRpc,
): Promise<void> {
  if (message.id === undefined) return; // a notification; nothing to answer

  if (message.method === 'initialize') {
    await transport.send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        // Echo the client's requested version so negotiation always succeeds.
        protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-crawl4ai-probe', version: '0.0.0' },
      },
    } as unknown as JSONRPCMessage);
    return;
  }

  if (message.method === 'tools/list') {
    if (mode === 'silent') return; // never answers — drives the request timeout
    if (mode === 'protocol_error') {
      await transport.send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'Method not found' },
      } as unknown as JSONRPCMessage);
      return;
    }
    await transport.send({
      jsonrpc: '2.0',
      id: message.id,
      result: { tools: [] },
    } as unknown as JSONRPCMessage);
  }
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');

  if (req.method === 'GET' && url.pathname === '/mcp/sse') {
    if (mode === 'connect_unavailable') {
      res.writeHead(503).end();
      return;
    }
    const transport = new SSEServerTransport('/messages', res);
    openTransports.add(transport);
    res.on('close', () => openTransports.delete(transport));
    transport.onmessage = message => {
      void answer(transport, message as unknown as IncomingRpc);
    };
    await transport.start();
    // Shrink the client's reconnect backoff (default ~3s) via the SSE
    // `retry:` directive, so teardown can deterministically drive every
    // still-open client into its permanent-failure state quickly.
    res.write(`retry: ${RECONNECT_HINT_MS}\n\n`);
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
  process.env.CRAWL4AI_API_TOKEN = 'crawl4ai-probe-test-token';
});

after(async () => {
  // Every probe that connected left a live SSE stream owned by a memoised
  // client this file cannot reach. Closing the server first would make
  // each of those clients retry against a refused port — the unbounded
  // ~3s reconnect loop that keeps `node --test` alive forever. Instead,
  // keep the port listening, switch the fake to a clean 503, drop the
  // streams, and let each client reconnect once, get its permanent
  // failure, and stop. Only then close the server.
  mode = 'connect_unavailable';
  for (const transport of openTransports) void transport.close();
  openTransports.clear();
  await new Promise(resolve => setTimeout(resolve, RECONNECT_HINT_MS * 10));

  httpServer.closeAllConnections?.();
  await new Promise<void>(resolve => httpServer.close(() => resolve()));
});

/** Fresh `crawl4ai.js` instance so its memoised client starts cold. */
let instance = 0;
async function freshProbe(): Promise<
  (timeoutMs: number) => Promise<ProbeResult>
> {
  instance++;
  const mod = (await import(
    `./crawl4ai.js?probe-test-instance=${instance}`
  )) as typeof import('./crawl4ai.js');
  return mod.probeCrawl4AI;
}

test('a reachable MCP server answering tools/list probes ok with no detail', async () => {
  mode = 'ok';
  const probeCrawl4AI = await freshProbe();

  const result = await probeCrawl4AI(3000);

  assert.equal(result.status, 'ok');
  assert.equal(result.detail, undefined);
  assert.ok(Number.isInteger(result.latency_ms));
  assert.ok(result.latency_ms >= 0);
});

test('a JSON-RPC error answer to tools/list is unhealthy with protocol_error', async () => {
  mode = 'protocol_error';
  const probeCrawl4AI = await freshProbe();

  const result = await probeCrawl4AI(3000);

  assert.equal(result.status, 'unhealthy');
  assert.equal(result.detail, 'protocol_error');
});

test('a connected server that never answers tools/list is unhealthy with timeout, inside the passed bound', async () => {
  mode = 'silent';
  const probeCrawl4AI = await freshProbe();

  const start = Date.now();
  const result = await probeCrawl4AI(500);
  const elapsed = Date.now() - start;

  assert.equal(result.status, 'unhealthy');
  assert.equal(
    result.detail,
    'timeout',
    'an MCP RequestTimeout must classify as timeout, not as a generic rejection',
  );
  assert.ok(
    elapsed < 3000,
    `probe must honour its own timeoutMs, took ${elapsed}ms`,
  );
});

test('the probe recovers to ok once the dependency answers again after a failed connect', async () => {
  mode = 'connect_unavailable';
  const probeCrawl4AI = await freshProbe(); // one instance across both calls

  const down = await probeCrawl4AI(3000);
  assert.equal(down.status, 'unhealthy');
  assert.equal(down.detail, 'network_error');

  mode = 'ok';
  const recovered = await probeCrawl4AI(3000);
  assert.equal(
    recovered.status,
    'ok',
    'a failed probe must not leave the memoised client permanently poisoned',
  );
  assert.equal(recovered.detail, undefined);
});

test('every failure detail this probe can emit stays inside the closed set', async () => {
  const pattern = /^(timeout|network_error|protocol_error|http_status:\d{3})$/;

  mode = 'protocol_error';
  const first = await (await freshProbe())(3000);
  mode = 'connect_unavailable';
  const second = await (await freshProbe())(3000);

  for (const result of [first, second]) {
    assert.equal(result.status, 'unhealthy');
    assert.match(result.detail ?? '', pattern);
    // No upstream URL, token, header, or exception text may leak through.
    assert.ok(!(result.detail ?? '').includes('127.0.0.1'));
    assert.ok(!(result.detail ?? '').includes('crawl4ai-probe-test-token'));
  }
});
