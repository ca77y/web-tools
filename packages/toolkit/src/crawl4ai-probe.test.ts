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
 * `resetClient()` (crawl4ai.ts) now closes the transport a failed
 * connect abandoned on every failure branch, including a connect-level
 * timeout, so the two hazards the post-integration-review amendment
 * describes can now be exercised directly and safely:
 *   - `refused` mode destroys the socket on `GET /mcp/sse` (a genuine
 *     network-level rejection, not a clean HTTP response), which is the
 *     path `eventsource`'s internal reconnect-forever loop actually takes
 *     in production — a clean status response never reaches that code at
 *     all. Before `resetClient()` existed, leaving this loop running
 *     would keep `node --test` alive forever; the reconnect-loop test
 *     below proves it does not.
 *   - `connect_hangs` mode accepts the connection but never answers at
 *     all — not even headers — simulating an upstream that TCP-accepted
 *     and then went silent (the card's manual step 5). Unlike `silent`
 *     mode below (which completes the connect and only withholds the
 *     `tools/list` answer, exercising the MCP SDK's own request-level
 *     timeout), this exercises `probeCrawl4AI`'s own connect-level
 *     timeout, since `getClient()`'s connect step has no timeout of its
 *     own otherwise.
 * `connect_unavailable` mode (a clean, immediate 503) is kept alongside
 * these: it is a distinct, legitimately terminal failure shape covered by
 * probeCrawl4AI's existing recovery test.
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
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
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
 * - `ok`                 : answers `tools/list` normally
 * - `protocol_error`     : answers `tools/list` with a JSON-RPC error
 * - `silent`             : accepts `tools/list` and never answers it
 * - `connect_unavailable`: answers `GET /mcp/sse` with a clean 503
 * - `refused`            : destroys the socket on `GET /mcp/sse` — a
 *                          genuine network-level rejection, the production
 *                          path a refused/reset connection actually takes
 * - `connect_hangs`      : accepts `GET /mcp/sse` and never responds at all
 * - `malformed_pending`  : holds a `tools/list` request open until
 *                          `releasePendingToolsList()` is called, then
 *                          answers with a result that fails the SDK's own
 *                          `ListToolsResultSchema` validation — a
 *                          rejection that is *not* an `McpError`, without
 *                          any transport-level error/close ever firing.
 *                          See the ownership-token test below for why this
 *                          decoupling (from any transport event) matters.
 */
let mode:
  | 'ok'
  | 'protocol_error'
  | 'silent'
  | 'connect_unavailable'
  | 'refused'
  | 'connect_hangs'
  | 'malformed_pending' = 'ok';

/** Resolves the `tools/list` request `mode === 'malformed_pending'` is holding open. */
let releaseGate: (() => void) | null = null;

/**
 * Releases a `tools/list` request the fake server is holding open under
 * `mode === 'malformed_pending'`. A no-op if nothing is pending.
 */
function releasePendingToolsList(): void {
  const release = releaseGate;
  releaseGate = null;
  release?.();
}

/** Counts `GET /mcp/sse` hits while `mode === 'refused'`. */
let refusedConnectAttempts = 0;

/** Counts every successful SSE handshake (a real `SSEServerTransport` created). */
let successfulConnectAttempts = 0;

const openTransports = new Set<SSEServerTransport>();
/** `res` objects left hanging by `connect_hangs` mode; cleaned up in `after()`. */
const hungResponses = new Set<ServerResponse>();
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
    if (mode === 'malformed_pending') {
      // Hold the request open until the test explicitly releases it, then
      // answer with a payload missing the required `tools` array. That
      // fails `ListToolsResultSchema` validation client-side, surfacing as
      // a rejection that is not an `McpError` — the same shape a genuine
      // "transport broke mid-request" failure produces — without this
      // fake ever tearing down the connection itself.
      await new Promise<void>(resolve => {
        releaseGate = resolve;
      });
      await transport.send({
        jsonrpc: '2.0',
        id: message.id,
        result: { not_a_valid_tools_list_result: true },
      } as unknown as JSONRPCMessage);
      return;
    }
    await transport.send({
      jsonrpc: '2.0',
      id: message.id,
      result: { tools: [] },
    } as unknown as JSONRPCMessage);
    return;
  }

  if (message.method === 'tools/call') {
    // Always a fast, deterministic JSON-RPC error — this fake doesn't
    // implement any real tool. Used only to make `call()`'s own catch
    // (crawl4ai.ts) fire on demand.
    await transport.send({
      jsonrpc: '2.0',
      id: message.id,
      error: { code: -32000, message: 'fake server rejects every tool call' },
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
    if (mode === 'refused') {
      refusedConnectAttempts++;
      req.socket.destroy();
      return;
    }
    if (mode === 'connect_hangs') {
      hungResponses.add(res);
      res.on('close', () => hungResponses.delete(res));
      return;
    }
    successfulConnectAttempts++;
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
  for (const res of hungResponses) res.destroy();
  hungResponses.clear();
  await new Promise(resolve => setTimeout(resolve, RECONNECT_HINT_MS * 10));

  httpServer.closeAllConnections?.();
  await new Promise<void>(resolve => httpServer.close(() => resolve()));
});

/** Fresh `crawl4ai.js` instance so its memoised client starts cold. */
let instance = 0;
async function freshModule(): Promise<typeof import('./crawl4ai.js')> {
  instance++;
  return (await import(
    `./crawl4ai.js?probe-test-instance=${instance}`
  )) as typeof import('./crawl4ai.js');
}

async function freshProbe(): Promise<
  (timeoutMs: number) => Promise<ProbeResult>
> {
  return (await freshModule()).probeCrawl4AI;
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

test('a protocol_error on tools/list does not reset the live connection: no new connect attempt follows', async () => {
  mode = 'protocol_error';
  successfulConnectAttempts = 0;
  const probeCrawl4AI = await freshProbe();

  const failed = await probeCrawl4AI(3000);
  assert.equal(failed.status, 'unhealthy');
  assert.equal(failed.detail, 'protocol_error');
  assert.equal(
    successfulConnectAttempts,
    1,
    'the connect itself succeeded; only tools/list returned a protocol error',
  );

  // The connect succeeded, so `client` is a live, shared transport that
  // `call()` and concurrent tool invocations may also be using. A single
  // probe's protocol-level failure must not tear that down: proving this
  // means proving the NEXT probe reuses the existing connection rather
  // than opening a new one.
  mode = 'ok';
  const recovered = await probeCrawl4AI(3000);
  assert.equal(recovered.status, 'ok');
  assert.equal(
    successfulConnectAttempts,
    1,
    'a tools/list-level protocol_error must not reset the shared client: the next probe should reuse the existing connection, not reconnect',
  );
});

test('a tools/list-level timeout does not reset the live connection: no new connect attempt follows', async () => {
  mode = 'silent';
  successfulConnectAttempts = 0;
  const probeCrawl4AI = await freshProbe();

  const timedOut = await probeCrawl4AI(500);
  assert.equal(timedOut.status, 'unhealthy');
  assert.equal(timedOut.detail, 'timeout');
  assert.equal(
    successfulConnectAttempts,
    1,
    'the connect itself succeeded; only the tools/list request timed out',
  );

  // Same distinction as the protocol_error case above, for the other
  // McpError-shaped tools/list failure: a slow answer to one probe request
  // is not evidence the connection is unusable, so it must not be reset —
  // unlike a connect-level timeout (see the `connect_hangs` test above),
  // which always resets because the connect itself never finished.
  mode = 'ok';
  const recovered = await probeCrawl4AI(3000);
  assert.equal(recovered.status, 'ok');
  assert.equal(
    successfulConnectAttempts,
    1,
    'a tools/list-level timeout must not reset the shared client: the next probe should reuse the existing connection, not reconnect',
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

// ── Amendment: resetClient() must stop the reconnect loop, and unwedge a
// hung connect (see the spec's post-integration-review amendment) ───────

test('a genuinely refused connection does not leave an orphaned reconnect loop: attempts stay bounded by explicit probe calls, not runaway retries', async () => {
  mode = 'refused';
  refusedConnectAttempts = 0;
  const probeCrawl4AI = await freshProbe(); // one instance across every round below

  const rounds = 3;
  for (let i = 0; i < rounds; i++) {
    const result = await probeCrawl4AI(1000);
    assert.equal(result.status, 'unhealthy');
    assert.equal(result.detail, 'network_error');
  }

  const attemptsAfterRounds = refusedConnectAttempts;
  assert.ok(
    attemptsAfterRounds >= rounds && attemptsAfterRounds <= rounds + 1,
    `expected roughly one connection attempt per explicit probe call, got ${attemptsAfterRounds} for ${rounds} rounds`,
  );

  // eventsource's default reconnect interval is ~3s. If resetClient() had
  // failed to close what a failed connect abandoned, that orphaned client
  // would still be quietly retrying here, growing the count with no
  // further probe call from this test — exactly the hazard the amendment
  // describes: orphans accumulating without bound under a sustained
  // outage.
  await new Promise(resolve => setTimeout(resolve, 3200));
  assert.equal(
    refusedConnectAttempts,
    attemptsAfterRounds,
    'no further connection attempts after probing stopped: no orphaned reconnect loop',
  );
});

test('a connect that receives no response at all times out within the passed bound, and a later probe recovers to ok once the upstream responds', async () => {
  mode = 'connect_hangs';
  const probeCrawl4AI = await freshProbe(); // one instance across both calls

  const start = Date.now();
  const hung = await probeCrawl4AI(500);
  const elapsed = Date.now() - start;

  assert.equal(hung.status, 'unhealthy');
  assert.equal(
    hung.detail,
    'timeout',
    'a connect has no timeout of its own (unlike tools/list); probeCrawl4AI must still bound it by the passed timeoutMs',
  );
  assert.ok(
    elapsed < 3000,
    `probe must honour its own timeoutMs, took ${elapsed}ms`,
  );

  mode = 'ok';
  const recovered = await probeCrawl4AI(3000);
  assert.equal(
    recovered.status,
    'ok',
    'a hung connect must not leave the shared client wedged permanently: a later probe must succeed once the upstream responds, without a process restart',
  );
  assert.equal(recovered.detail, undefined);
});

test('resetClient() swallows a close() error: the probe still resolves a classified verdict and shared state still clears', async () => {
  mode = 'refused';
  refusedConnectAttempts = 0;
  const probeCrawl4AI = await freshProbe();

  // Patch the SDK's own transport class so the transport resetClient()
  // abandons throws on close(). This is the only way to exercise the
  // "swallowing a close error" clause of resetClient() (crawl4ai.ts): the
  // fake server above can make a *connect* fail, but it cannot make the
  // *client-side* `SSEClientTransport.close()` call itself throw, since
  // that method's own body (abort the AbortController, close the
  // EventSource) never throws for any server behaviour this fake can
  // produce.
  //
  // Crucially, the patch still *performs* the real close (aborts the
  // AbortController, closes the EventSource) before throwing — it must
  // not skip that. `close()`'s real job is exactly what stops
  // `eventsource`'s internal reconnect-after-a-refused-connect timer (the
  // amendment's hazard 1); a patch that replaced the body outright rather
  // than augmenting it would silently defeat that and orphan a real
  // reconnect loop, which is the one thing this test must not do. This
  // models a `close()` that fails *after* doing its real cleanup (e.g. an
  // unrelated exception on the way out), which is the only shape
  // `resetClient()`'s swallow needs to tolerate.
  const originalClose = SSEClientTransport.prototype.close;
  SSEClientTransport.prototype.close = async function patchedClose(
    ...args: unknown[]
  ) {
    await (originalClose as (...a: unknown[]) => Promise<void>).apply(
      this,
      args,
    );
    throw new Error('close() itself failed');
  };

  try {
    const first = await probeCrawl4AI(1000);
    assert.equal(
      first.status,
      'unhealthy',
      'a close() failure must not surface as an unhandled rejection or change the classified verdict',
    );
    assert.equal(first.detail, 'network_error');

    const attemptsAfterFirst = refusedConnectAttempts;

    // Prove resetClient() still cleared the shared client/connecting/
    // activeTransport state despite close() throwing: a second probe must
    // open a genuinely NEW connect attempt rather than hanging on, or
    // silently reusing, whatever the first attempt abandoned. Deliberately
    // stays in `refused` mode (never reaches a live `ok` connection) so
    // this test cannot itself leave an open SSE stream for `after()` to
    // race against during teardown.
    const second = await probeCrawl4AI(1000);
    assert.equal(second.status, 'unhealthy');
    assert.equal(second.detail, 'network_error');
    assert.equal(
      refusedConnectAttempts,
      attemptsAfterFirst + 1,
      'a second probe after a close()-throwing reset must make a fresh connect attempt, proving state was cleared',
    );
  } finally {
    SSEClientTransport.prototype.close = originalClose;
  }
});

test('two probes racing the same failing connect share one connect attempt and do not crash resetting the shared abandoned transport', async () => {
  mode = 'refused';
  refusedConnectAttempts = 0;
  const probeCrawl4AI = await freshProbe(); // one instance so both calls share getClient()'s state

  // Both calls race the exact same in-flight `connecting` promise
  // (getClient()'s single-flight), so both catch blocks call
  // resetClient() around the same rejection: this exercises "a probe call
  // arriving while resetClient() is mid-close" without needing to
  // fabricate a slow close() — the two callers' resetClient() calls
  // interleave naturally because they share one abandoned transport.
  const [a, b] = await Promise.all([
    probeCrawl4AI(1000),
    probeCrawl4AI(1000),
  ]);

  for (const result of [a, b]) {
    assert.equal(result.status, 'unhealthy');
    assert.equal(result.detail, 'network_error');
  }

  // Only one underlying connect attempt for two concurrent callers.
  assert.equal(
    refusedConnectAttempts,
    1,
    'two concurrent probes against a cold client share one connect attempt',
  );

  // Neither concurrent resetClient() call corrupted the shared state or
  // left it wedged: a later probe still makes a genuinely fresh connect
  // attempt rather than hanging or silently reusing dead state. Stays in
  // `refused` mode throughout (never reaches a live `ok` connection), so
  // this test cannot itself leave an open SSE stream for `after()` to race
  // against during teardown.
  const recovered = await probeCrawl4AI(1000);
  assert.equal(recovered.status, 'unhealthy');
  assert.equal(recovered.detail, 'network_error');
  assert.equal(
    refusedConnectAttempts,
    2,
    'a later probe after the race must open a fresh connect attempt',
  );
});

// ── Second amendment: transport ownership ────────────────────────────────
// resetClient() must act only on the transport the caller's own connect
// attempt is tied to, never on whatever `activeTransport` happens to hold
// when the caller finally gets around to failing. Both scenarios below are
// impossible to construct through `mode` alone: they need a failure that
// resets shared state (`onerror`/`onclose`, or a "transport broke
// mid-request" reset) to fire against a transport that a *different*,
// already-established connection has superseded.

test('an established connection dropped by the server is closed, not merely dereferenced: no reconnect loop survives, and a later probe opens exactly one new connection', async () => {
  mode = 'ok';
  successfulConnectAttempts = 0;
  refusedConnectAttempts = 0;
  // `openTransports` is shared across this whole file's tests, and
  // earlier tests routinely leave their own (idle, harmless) sessions
  // open past their own completion. Diff against the pre-existing set so
  // this test only ever touches the session its own connect below opens.
  const preExisting = new Set(openTransports);
  const probeCrawl4AI = await freshProbe();

  const first = await probeCrawl4AI(3000);
  assert.equal(first.status, 'ok');
  assert.equal(successfulConnectAttempts, 1);
  const mine = [...openTransports].filter(t => !preExisting.has(t));
  assert.equal(
    mine.length,
    1,
    'exactly one new server-side SSE session was opened by this test',
  );

  // Simulate the server side of an established, idle connection dropping
  // out from under the client -- a Crawl4AI restart or crash, with no
  // probe in flight. Switch to `refused` first so that if the fix failed
  // to close the client-side transport (leaving `eventsource`'s own
  // reconnect-after-drop timer running), the retry would hit a
  // distinguishable, countable failure instead of silently
  // re-establishing a session this test would then have to reason about.
  mode = 'refused';
  for (const transport of mine) {
    void transport.close();
    openTransports.delete(transport);
  }

  // Give eventsource's reconnect timer (shrunk to RECONNECT_HINT_MS via
  // the `retry:` hint sent on connect) several chances to fire. If the
  // `onerror`/`onclose` handlers only nulled `client`/`connecting`
  // without closing the transport, the retry loop would survive
  // independently of any probe and this count would climb above zero.
  await new Promise(resolve => setTimeout(resolve, RECONNECT_HINT_MS * 6));
  assert.equal(
    refusedConnectAttempts,
    0,
    'no background reconnect attempt survives a properly closed transport',
  );

  mode = 'ok';
  const recovered = await probeCrawl4AI(3000);
  assert.equal(recovered.status, 'ok');
  assert.equal(
    successfulConnectAttempts,
    2,
    'exactly one new connection is established by the next probe, not a pile-up of reconnects',
  );
});

test("a probe abandoned mid-request does not reset a newer round's transport once a fresh connect has already replaced it", async () => {
  mode = 'ok';
  successfulConnectAttempts = 0;
  const mod = await freshModule();
  const { probeCrawl4AI, callCrawlTool } = mod;

  // Establish T1 cleanly.
  const warm = await probeCrawl4AI(3000);
  assert.equal(warm.status, 'ok');
  assert.equal(successfulConnectAttempts, 1);

  // Start a straggler probe against the same, already-connected client.
  // The fake server holds its tools/list request open rather than
  // answering it -- modelling readiness.ts's outer deadline abandoning a
  // probe that is still waiting on a slow tools/list answer: the probe
  // itself keeps running in the background even once its caller has
  // stopped awaiting it.
  mode = 'malformed_pending';
  const straggler = probeCrawl4AI(10000);

  // Let the request actually reach the server and register its release
  // gate, so it is genuinely held open, not merely queued locally.
  await new Promise(resolve => setTimeout(resolve, 50));

  // A concurrent tool call fails for an unrelated reason. `call()`'s own
  // catch (crawl4ai.ts; out of this unit's scope to change) nulls the
  // shared `client`/`connecting` on any rejection without closing or
  // touching `activeTransport` -- so it leaves T1 dangling exactly as a
  // superseded transport is left after readiness.ts abandons a probe and
  // its TTL later rotates to a fresh round.
  await assert.rejects(() => callCrawlTool({ url: 'https://example.invalid/' }));

  // A later probe now finds `client`/`connecting` cold and opens a
  // genuinely new, second connection (T2) while the straggler's request
  // is still pending against T1.
  mode = 'ok';
  const roundB = await probeCrawl4AI(3000);
  assert.equal(roundB.status, 'ok');
  assert.equal(
    successfulConnectAttempts,
    2,
    'round B opened a genuinely fresh, second connection',
  );

  // Now let the straggler's stale request fail: the fake server answers
  // with a payload that fails the SDK's own result-schema validation,
  // which surfaces to the caller as a rejection that is not an `McpError`
  // -- the same "transport broke mid-request" shape a real dropped
  // connection produces -- without ever touching round B's transport via
  // `onerror`/`onclose`. The straggler's ownership token still names T1,
  // the transport round B's connect already superseded, so its reset
  // attempt must be a no-op rather than closing round B's live T2.
  releasePendingToolsList();
  const strayResult = await straggler;
  assert.equal(strayResult.status, 'unhealthy');

  // Prove T2 is still open and usable: a further probe reuses it rather
  // than reconnecting.
  mode = 'ok';
  const roundC = await probeCrawl4AI(3000);
  assert.equal(roundC.status, 'ok');
  assert.equal(
    successfulConnectAttempts,
    2,
    "round C reused the still-open connection from round B: the straggler's stale reset did not close it",
  );
});

test("a superseded transport's late onclose does not clear the shared state its replacement owns", async () => {
  // The companion to the two tests above, for the third hazard the second
  // amendment names: the `onerror`/`onclose` handlers wired inside
  // `getClient()` used to write to shared state unconditionally, so a late
  // event from a transport a newer connect had already replaced would null
  // `client`/`connecting` belonging to that replacement. Routing those
  // handlers through the ownership-guarded `resetClient(transport)` makes a
  // stale one a no-op.
  //
  // The discriminator here is deliberately not a connect counter: a stale
  // transport keeps its own `eventsource` retry loop (it is no longer the
  // owner, so nothing closes it -- a pre-existing consequence of `call()`'s
  // catch, out of this unit's scope), and those retries would make any
  // count non-deterministic. Instead the fake is held in `refused` mode for
  // the whole post-drop phase, where a *fresh* connect cannot succeed but
  // an *already-established* session still answers `tools/list` normally
  // (only `GET /mcp/sse` looks at `mode`). So the final probe answering
  // `ok` is positive proof it reused the replacement's live client; had the
  // stale event nulled that state, the probe would have had to reconnect
  // and would have reported `unhealthy`/`network_error` instead.
  mode = 'ok';
  successfulConnectAttempts = 0;
  refusedConnectAttempts = 0;
  const preExisting = new Set(openTransports);
  const { probeCrawl4AI, callCrawlTool } = await freshModule();

  // T1.
  assert.equal((await probeCrawl4AI(3000)).status, 'ok');
  assert.equal(successfulConnectAttempts, 1);
  const first = [...openTransports].filter(t => !preExisting.has(t));
  assert.equal(first.length, 1, 'T1 is the only session this test opened');

  // Supersede T1 without closing it: `call()`'s catch nulls
  // `client`/`connecting` on any rejection and leaves `activeTransport`
  // alone, so the next connect installs a replacement while T1 is still
  // open and still has its handlers wired.
  await assert.rejects(() => callCrawlTool({ url: 'https://example.invalid/' }));

  // T2 -- the replacement, now the owner of the shared state.
  assert.equal((await probeCrawl4AI(3000)).status, 'ok');
  assert.equal(
    successfulConnectAttempts,
    2,
    'the replacement is a genuinely new connection, opened while T1 is still open',
  );

  // Drop T1 server-side. Its client-side `onclose`/`onerror` now fire
  // against a transport that is no longer `activeTransport`.
  mode = 'refused';
  for (const transport of first) {
    void transport.close();
    openTransports.delete(transport);
  }
  await new Promise(resolve => setTimeout(resolve, RECONNECT_HINT_MS * 6));
  assert.ok(
    refusedConnectAttempts > 0,
    'the stale transport did react to the drop, so its late handler really did fire',
  );

  // Still in `refused` mode: only a reused, already-established session can
  // answer this.
  const afterStaleEvent = await probeCrawl4AI(3000);
  assert.equal(
    afterStaleEvent.status,
    'ok',
    "a superseded transport's late close must not null the replacement's client: the probe had to be able to reuse the live connection, which a fresh connect could not have produced in refused mode",
  );
  assert.equal(
    successfulConnectAttempts,
    2,
    'no reconnect was needed, confirming the shared client survived the stale event',
  );

  // Hygiene, not an assertion: drive the stale transport's retry loop into
  // its permanent-failure state (a clean 503) so it stops before the next
  // test, exactly as `after()` does for every other leftover session.
  mode = 'connect_unavailable';
  await new Promise(resolve => setTimeout(resolve, RECONNECT_HINT_MS * 6));
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
