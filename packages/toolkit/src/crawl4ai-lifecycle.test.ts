/**
 * Exercises `call()`'s new failure classification and `getClient()`'s new
 * connect guard (crawl4ai.ts) directly against an in-process fake MCP SSE
 * server, following the pattern already established by
 * `crawl4ai-probe.test.ts` (fake `node:http` + `SSEServerTransport` peer,
 * `mode`-driven behaviour, cache-busting dynamic `import()` per test for a
 * cold client) and `crawl4ai-attribution.test.ts` (a live MCP stand-in
 * driving the real tool entry points). Unlike `crawl4ai-probe.test.ts`,
 * every test here closes its own fresh module instance via the now-
 * available `closeCrawl4AIClient()` (test-only teardown, crawl4ai.ts)
 * instead of the older `process.exit()` hack those files needed before that
 * export existed — so `after()` here can just close the fake server
 * directly.
 *
 * `CRAWL4AI_CALL_TIMEOUT_MS` is fixed to `TEST_TIMEOUT_MS` (small, so the
 * RequestTimeout and slow-success scenarios stay fast) for this whole file,
 * set once in `before()` before any test's first `freshModule()` call —
 * `config.ts`'s `envSchema` parses `process.env` once per process and the
 * unbusted `./config.js` specifier `crawl4ai.ts` statically imports is
 * cached module-wide after its first load, so every fresh `crawl4ai.js`
 * instance in this file shares the same fixed value. The "default exceeds
 * the crawl budget" and "override reflects the env var" scenarios are
 * config.ts unit tests decoupled from any MCP server, and live in
 * `crawl4ai-call-timeout-config.test.ts` instead, where each test is free
 * to pick its own value.
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

/** Fixed `CRAWL4AI_CALL_TIMEOUT_MS` for this whole file (see file doc comment). */
const TEST_TIMEOUT_MS = 1000;
/** Comfortably under `TEST_TIMEOUT_MS`, for the "slow but under budget" scenario. */
const SLOW_SUCCESS_DELAY_MS = 250;

type ToolResult = { isError?: unknown };

type IncomingRpc = {
  method?: string;
  id?: string | number;
  params?: {
    protocolVersion?: string;
    name?: string;
    arguments?: Record<string, unknown>;
  };
};

/**
 * `connectMode` controls `GET /mcp/sse` behaviour:
 *  - 'ok': accepts and connects normally.
 *  - 'refused': destroyed the socket (a genuine network-level rejection) —
 *    gated by `connectRefuseBudget` below, not this mode, for the bounded
 *    retry scenarios; this mode is a persistent variant used by the
 *    initialize-phase-then-fresh-attempt design where the transport itself
 *    must never even be reachable.
 *  - 'init_malformed': accepts the SSE stream, but answers `initialize`
 *    with a payload that fails the SDK's own result-schema validation — a
 *    connect rejection that fires no `onerror`/`onclose` (the transport
 *    itself is fine; only the `initialize` *response* is malformed),
 *    modelling the card's initialize-phase failure exactly as
 *    `crawl4ai-probe.test.ts`'s `malformed_pending` mode does for
 *    `tools/list`.
 */
type ConnectMode = 'ok' | 'refused' | 'init_malformed';
let connectMode: ConnectMode = 'ok';

/**
 * Number of subsequent `GET /mcp/sse` attempts to refuse (destroy the
 * socket) before allowing one through, decrementing on each refusal.
 * Independent of `connectMode` so a test can fail exactly N connect
 * attempts and then recover deterministically, regardless of `connectMode`.
 */
let connectRefuseBudget = 0;

/**
 * Number of subsequent `POST /messages` requests to fail with a clean 500
 * before allowing one through, decrementing on each failure. This is what
 * `SSEClientTransport.send()` throws a plain `Error` (not an `McpError`)
 * for — the connection-level "failed/refused send()" shape the spec names
 * explicitly.
 */
let postFailBudget = 0;

/**
 * When set, a `POST /messages` addressed to this specific SSE session id
 * fails with a clean 500, regardless of `postFailBudget`; any other/newer
 * session succeeds normally. More robust than a blind attempt-count budget
 * for a scenario with two concurrent callers sharing one transport: a count
 * cannot guarantee *which* of the two callers' first-attempt-vs-retry POSTs
 * consumes which unit, so an unlucky interleaving (one caller's own attempt
 * and its own retry both landing before the other caller's first attempt)
 * can exhaust the whole budget on one caller alone. Poisoning the doomed
 * session by identity removes that race: every POST addressed to it fails,
 * no matter how many arrive or in what order, and a retry — which only ever
 * runs after `resetClient()` has already replaced the session — can never
 * land on it again.
 */
let poisonedSessionId: string | null = null;

let refusedConnectAttempts = 0;
let acceptedConnectAttempts = 0;
/** Every `tools/call` message the fake receives, regardless of `mode`/behaviour. */
let toolCallAttempts = 0;

type CallBehavior =
  | { kind: 'ok'; delayMs?: number }
  | { kind: 'protocol_error' }
  | { kind: 'never' };

/** Applied when no per-call `_case` marker matches an entry in `callBehaviorByCase`. */
let defaultCallBehavior: CallBehavior = { kind: 'ok' };
/** Keyed by the outgoing tool arguments' `_case` field, for per-call control in concurrent scenarios. */
const callBehaviorByCase = new Map<string, CallBehavior>();

const openTransports = new Set<SSEServerTransport>();
let httpServer: Server;

async function answer(
  transport: SSEServerTransport,
  message: IncomingRpc,
): Promise<void> {
  if (message.id === undefined) return; // a notification; nothing to answer

  if (message.method === 'initialize') {
    if (connectMode === 'init_malformed') {
      await transport.send({
        jsonrpc: '2.0',
        id: message.id,
        result: { not_a_valid_initialize_result: true },
      } as unknown as JSONRPCMessage);
      return;
    }
    await transport.send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        protocolVersion: message.params?.protocolVersion ?? '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'fake-crawl4ai-lifecycle', version: '0.0.0' },
      },
    } as unknown as JSONRPCMessage);
    return;
  }

  if (message.method === 'tools/call') {
    toolCallAttempts++;
    const caseMarker = message.params?.arguments?._case as string | undefined;
    const behavior =
      (caseMarker ? callBehaviorByCase.get(caseMarker) : undefined) ??
      defaultCallBehavior;

    if (behavior.kind === 'never') return; // held open forever

    if (behavior.kind === 'protocol_error') {
      // -32601 ("Method not found"), not -32000: -32000 is
      // `ErrorCode.ConnectionClosed`, which `call()` deliberately treats as
      // connection-level (see crawl4ai.ts) since the SDK itself synthesizes
      // that exact code client-side when a transport closes mid-request.
      // Using it here would misrepresent a genuine server-returned protocol
      // error as that shape.
      await transport.send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32601, message: 'fake server rejects this tool call' },
      } as unknown as JSONRPCMessage);
      return;
    }

    if (behavior.delayMs) {
      await new Promise(resolve => setTimeout(resolve, behavior.delayMs));
    }
    await transport.send({
      jsonrpc: '2.0',
      id: message.id,
      result: { content: [{ type: 'text', text: 'ok' }] },
    } as unknown as JSONRPCMessage);
  }
}

async function handle(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');

  if (req.method === 'GET' && url.pathname === '/mcp/sse') {
    if (connectMode === 'refused' || connectRefuseBudget > 0) {
      if (connectRefuseBudget > 0) connectRefuseBudget--;
      refusedConnectAttempts++;
      req.socket.destroy();
      return;
    }
    acceptedConnectAttempts++;
    const transport = new SSEServerTransport('/messages', res);
    openTransports.add(transport);
    res.on('close', () => openTransports.delete(transport));
    transport.onmessage = message => {
      void answer(transport, message as unknown as IncomingRpc);
    };
    await transport.start();
    // Shrink the client's reconnect backoff, matching the sibling probe
    // fixture, in case a test leaves a transport to its own retry loop.
    res.write('retry: 50\n\n');
    return;
  }

  if (req.method === 'POST' && url.pathname === '/messages') {
    const sessionId = url.searchParams.get('sessionId');
    if (poisonedSessionId && sessionId === poisonedSessionId) {
      res
        .writeHead(500)
        .end('fake server rejects this POST (poisoned session)');
      return;
    }
    if (postFailBudget > 0) {
      postFailBudget--;
      res.writeHead(500).end('fake server rejects this POST');
      return;
    }
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
  process.env.CRAWL4AI_CALL_TIMEOUT_MS = String(TEST_TIMEOUT_MS);
});

after(async () => {
  // Every test below closes its own fresh module's client via
  // `closeCrawl4AIClient()` before completing, so no client-side EventSource
  // should still be open here — a plain close suffices, unlike the
  // reconnect-loop dance `crawl4ai-probe.test.ts` needs (written before
  // `closeCrawl4AIClient()` existed).
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
    `./crawl4ai.js?lifecycle-test-instance=${instance}`
  )) as typeof import('./crawl4ai.js');
}

function resetFakeServer(): void {
  connectMode = 'ok';
  connectRefuseBudget = 0;
  postFailBudget = 0;
  poisonedSessionId = null;
  refusedConnectAttempts = 0;
  acceptedConnectAttempts = 0;
  toolCallAttempts = 0;
  defaultCallBehavior = { kind: 'ok' };
  callBehaviorByCase.clear();
}

// ── Requirement: explicit, configurable, budget-exceeding per-call timeout ──

test('every callTool call passes the configured timeout in the third RequestOptions slot, for every Crawl4AI-backed operation, and no callTool relies on the SDK default', async () => {
  resetFakeServer();
  const mod = await freshModule();
  const { Config } = await import('./config.js');

  const captured: Array<{
    params: unknown;
    resultSchema: unknown;
    options: unknown;
  }> = [];
  const originalCallTool = Client.prototype.callTool;
  Client.prototype.callTool = function patchedCallTool(
    this: Client,
    params: unknown,
    resultSchema?: unknown,
    options?: unknown,
  ) {
    captured.push({ params, resultSchema, options });
    return (
      originalCallTool as (...a: unknown[]) => ReturnType<Client['callTool']>
    ).call(this, params, resultSchema, options);
  } as typeof Client.prototype.callTool;

  try {
    await mod.callCrawlTool({ url: 'https://example.com/a' });
    await mod.callMdTool({ url: 'https://example.com/a' });
    await mod.callScreenshotTool({ url: 'https://example.com/a' });
    await mod.callPdfTool({ url: 'https://example.com/a' });
    await mod.callExecuteJsTool({
      url: 'https://example.com/a',
      scripts: ['1+1'],
    });
  } finally {
    Client.prototype.callTool = originalCallTool;
    await mod.closeCrawl4AIClient();
  }

  assert.equal(
    captured.length,
    5,
    'expected one callTool invocation per operation',
  );
  const expectedNames = ['crawl', 'md', 'screenshot', 'pdf', 'execute_js'];
  captured.forEach((call, i) => {
    assert.equal(
      (call.params as { name: string }).name,
      expectedNames[i],
      `call ${i} dispatched the wrong tool name`,
    );
    assert.equal(
      call.resultSchema,
      undefined,
      'the second (resultSchema) slot must be left undefined, not the options object',
    );
    assert.deepEqual(
      call.options,
      { timeout: Config.crawl4ai.callTimeoutMs },
      `call ${i} (${expectedNames[i]}) must carry an explicit timeout equal to Config.crawl4ai.callTimeoutMs in the third slot`,
    );
  });
});

test('a delayed answer comfortably under the configured timeout still succeeds, proving the operative bound is the configured value and not a hard-coded 60s default', async () => {
  resetFakeServer();
  defaultCallBehavior = { kind: 'ok', delayMs: SLOW_SUCCESS_DELAY_MS };

  const mod = await freshModule();
  const start = Date.now();
  const result = (await mod.callCrawlTool({
    url: 'https://example.com/a',
  })) as ToolResult;
  const elapsed = Date.now() - start;

  assert.ok(!result.isError);
  assert.ok(
    elapsed < TEST_TIMEOUT_MS,
    `expected the delayed answer to resolve within the configured timeout (${TEST_TIMEOUT_MS}ms), took ${elapsed}ms`,
  );

  await mod.closeCrawl4AIClient();
});

// ── Requirement: a discarded client is closed, never leaked ─────────────

test('a connection-level call() failure closes the discarded transport via resetClient(), and the retry reconnects on a fresh one', async () => {
  resetFakeServer();
  const mod = await freshModule();

  // Establish a live client (T1).
  await mod.callCrawlTool({ url: 'https://example.com/a' });
  assert.equal(acceptedConnectAttempts, 1);

  let closeCalls = 0;
  const originalClose = SSEClientTransport.prototype.close;
  SSEClientTransport.prototype.close = async function patchedClose(
    ...args: unknown[]
  ) {
    closeCalls++;
    return (originalClose as (...a: unknown[]) => Promise<void>).apply(
      this,
      args,
    );
  };

  try {
    // The next call's outgoing POST fails once (connection-level, a plain
    // Error from a failed send()): T1 is discarded and the call is retried
    // once against a fresh connection (T2), which succeeds.
    postFailBudget = 1;
    const result = (await mod.callCrawlTool({
      url: 'https://example.com/b',
    })) as ToolResult;
    assert.ok(!result.isError);
  } finally {
    SSEClientTransport.prototype.close = originalClose;
  }

  assert.ok(
    closeCalls >= 1,
    'resetClient() must close() the transport a connection-level failure discarded — a discarded client must never merely be dereferenced',
  );
  assert.equal(
    acceptedConnectAttempts,
    2,
    'the retry reconnected on a fresh transport (T2), proving client/connecting/activeTransport were cleared, not just client/connecting',
  );

  await mod.closeCrawl4AIClient();
});

// ── Requirement: a rejected connect never latches the connecting promise ──

test('an initialize-phase connect rejection (no onerror/onclose) does not latch connecting: a subsequent call makes a genuinely fresh attempt and can succeed', async () => {
  resetFakeServer();
  connectMode = 'init_malformed';

  const mod = await freshModule();

  // The first call's own attempt AND its one bounded connection-level retry
  // both hit the same initialize-phase failure (connectMode is unchanged in
  // between), so this rejection is preceded by exactly two accepted
  // connect attempts, not latched on a single permanently-rejected promise.
  await assert.rejects(() =>
    mod.callCrawlTool({ url: 'https://example.com/a' }),
  );
  assert.equal(
    acceptedConnectAttempts,
    2,
    'the original attempt and its one bounded retry both reached the server and both failed at the initialize phase',
  );

  connectMode = 'ok';
  const result = (await mod.callCrawlTool({
    url: 'https://example.com/a',
  })) as ToolResult;
  assert.ok(!result.isError);
  assert.equal(
    acceptedConnectAttempts,
    3,
    'this call made a genuinely fresh connect attempt, not a re-return of the earlier rejected promise',
  );

  await mod.closeCrawl4AIClient();
});

// ── Requirement: one bounded reconnect-and-retry for connection-level failures ──

test('a connection-level connect failure is retried exactly once and then succeeds', async () => {
  resetFakeServer();
  connectRefuseBudget = 1;

  const mod = await freshModule();
  const result = (await mod.callCrawlTool({
    url: 'https://example.com/a',
  })) as ToolResult;

  assert.ok(!result.isError);
  assert.equal(refusedConnectAttempts, 1, 'exactly one failed connect attempt');
  assert.equal(
    acceptedConnectAttempts,
    1,
    'exactly one successful connect attempt — the bounded retry',
  );

  await mod.closeCrawl4AIClient();
});

test('a second connection-level connect failure on the retry surfaces to the caller, with no third attempt', async () => {
  resetFakeServer();
  connectRefuseBudget = 2;

  const mod = await freshModule();
  await assert.rejects(() =>
    mod.callCrawlTool({ url: 'https://example.com/a' }),
  );

  assert.equal(
    refusedConnectAttempts,
    2,
    'exactly two failed connect attempts — the original and the one bounded retry — no third attempt',
  );
  assert.equal(acceptedConnectAttempts, 0);

  await mod.closeCrawl4AIClient();
});

test('an operation RequestTimeout is not retried, and does not reset the live client', async () => {
  resetFakeServer();
  const mod = await freshModule();

  // Establish a live client first.
  await mod.callCrawlTool({ url: 'https://example.com/a' });
  assert.equal(acceptedConnectAttempts, 1);

  // The next call's tools/call is never answered, so the SDK's own request
  // timeout — bound to Config.crawl4ai.callTimeoutMs (TEST_TIMEOUT_MS for
  // this file), since call() now passes it explicitly — fires client-side
  // with McpError(RequestTimeout).
  defaultCallBehavior = { kind: 'never' };
  toolCallAttempts = 0;
  await assert.rejects(
    () => mod.callCrawlTool({ url: 'https://example.com/b' }),
    (err: unknown) => {
      assert.ok(err instanceof McpError, 'expected an McpError');
      assert.equal((err as McpError).code, ErrorCode.RequestTimeout);
      return true;
    },
  );
  assert.equal(
    toolCallAttempts,
    1,
    'a full-timeout answer is not a safe repeat: exactly one tools/call attempt must reach the server, no retry',
  );

  // The shared client was not reset: the next call succeeds without a new
  // connect, proving a slow operation did not tear down a live connection.
  defaultCallBehavior = { kind: 'ok' };
  const recovered = (await mod.callCrawlTool({
    url: 'https://example.com/c',
  })) as ToolResult;
  assert.ok(!recovered.isError);
  assert.equal(
    acceptedConnectAttempts,
    1,
    'the live client was reused, not reconnected, after an operation-level RequestTimeout',
  );

  await mod.closeCrawl4AIClient();
});

// ── Requirement: concurrent calls are not cross-contaminated by one failure ──

test('an operation-level failure (McpError, non-timeout) of one concurrent call leaves a concurrent call on the same client untouched: no retry, no reset', async () => {
  resetFakeServer();
  const mod = await freshModule();

  // Establish a live client shared by both concurrent calls below.
  await mod.callCrawlTool({ url: 'https://example.com/a' });
  assert.equal(acceptedConnectAttempts, 1);

  callBehaviorByCase.set('fails', { kind: 'protocol_error' });
  callBehaviorByCase.set('succeeds', { kind: 'ok' });

  const [failing, succeeding] = await Promise.allSettled([
    mod.callCrawlTool({ url: 'https://example.com/b', _case: 'fails' }),
    mod.callMdTool({ url: 'https://example.com/c', _case: 'succeeds' }),
  ]);

  assert.equal(failing.status, 'rejected');
  assert.ok(
    (failing as PromiseRejectedResult).reason instanceof McpError,
    'the failing call must reject with the raw McpError, unwrapped',
  );
  assert.notEqual(
    (failing as PromiseRejectedResult).reason.code,
    ErrorCode.RequestTimeout,
  );

  assert.equal(succeeding.status, 'fulfilled');
  assert.ok(!(succeeding as PromiseFulfilledResult<ToolResult>).value.isError);

  assert.equal(
    acceptedConnectAttempts,
    1,
    'neither the operation-level failure nor the concurrent success reset the shared client',
  );

  await mod.closeCrawl4AIClient();
});

test('a connection-level failure affecting two concurrent callers is bounded and self-healing: both ultimately resolve', async () => {
  resetFakeServer();
  const mod = await freshModule();
  const preExisting = new Set(openTransports);

  // Establish a live client (T1) shared by both concurrent calls below.
  await mod.callCrawlTool({ url: 'https://example.com/a' });
  assert.equal(acceptedConnectAttempts, 1);
  const mine = [...openTransports].filter(t => !preExisting.has(t));
  assert.equal(mine.length, 1, 'exactly one new server-side session for T1');

  // Poison T1's specific session: every POST addressed to it fails at the
  // connection level, no matter how many of the two concurrent callers'
  // attempts land on it or in what order (see the doc comment on
  // `poisonedSessionId` for why a blind attempt-count budget is not safe
  // here). Each call's one bounded retry reconnects onto a genuinely new,
  // unpoisoned session and succeeds.
  poisonedSessionId = mine[0]!.sessionId;

  const [a, b] = await Promise.allSettled([
    mod.callCrawlTool({ url: 'https://example.com/b' }),
    mod.callMdTool({ url: 'https://example.com/c' }),
  ]);

  assert.equal(
    a.status,
    'fulfilled',
    'the first concurrent caller must ultimately resolve',
  );
  assert.equal(
    b.status,
    'fulfilled',
    'the second concurrent caller must ultimately resolve',
  );
  assert.ok(!(a as PromiseFulfilledResult<ToolResult>).value.isError);
  assert.ok(!(b as PromiseFulfilledResult<ToolResult>).value.isError);

  // T1 was discarded (by whichever caller's resetClient() won the
  // ownership race — the other's own resetClient() call is a no-op) and
  // both callers' single-flight retries converged on ONE re-established
  // connection (T2), not two racing reconnects.
  assert.equal(
    acceptedConnectAttempts,
    2,
    "both callers' retries converged on a single fresh connection, not two",
  );

  await mod.closeCrawl4AIClient();
});
