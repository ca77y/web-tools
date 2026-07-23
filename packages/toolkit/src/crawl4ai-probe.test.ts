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
 * - `post_fails`         : an already-open session's `POST /messages`
 *                          answers 500 instead of delegating to the
 *                          transport — the shape `SSEClientTransport.send()`
 *                          throws a plain `Error` (not an `SseError`) for,
 *                          used to prove the `onerror` gate in crawl4ai.ts
 *                          leaves an otherwise-live connection open.
 */
let mode:
  | 'ok'
  | 'protocol_error'
  | 'silent'
  | 'connect_unavailable'
  | 'refused'
  | 'connect_hangs'
  | 'malformed_pending'
  | 'post_fails' = 'ok';

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
    if (mode === 'post_fails') {
      res.writeHead(500).end('fake server rejects this POST');
      return;
    }
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
  const [a, b] = await Promise.all([probeCrawl4AI(1000), probeCrawl4AI(1000)]);

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

// The two tests formerly here, "a probe abandoned mid-request does not
// reset a newer round's transport once a fresh connect has already
// replaced it" and "a superseded transport's late onclose does not clear
// the shared state its replacement owns", both relied on `call()`'s pre-fix
// catch (`client = null; connecting = null;` with no reset) to supersede T1
// while deliberately leaving it open and still wired, so a *later*,
// independent event against T1 (a straggler's own pending request settling,
// or a server-side drop) could be used to fire a stale reset against an
// already-replaced `activeTransport`. Root cause 2
// (crawl4ai-mcp-client-timeout-and-recovery) — a discarded client leaking
// its transport instead of being closed — is exactly what both relied on,
// and it is now fixed: every path that discards the shared client
// (`call()`'s own connection-level branch included) routes through the
// ownership-guarded `resetClient()`, which closes the transport in the same
// step that clears `activeTransport`. There is no longer a code path that
// leaves a superseded transport open and wired, so neither test's fixture
// can be constructed anymore — confirmed empirically while adapting the
// first of the two: closing T1 as part of superseding it also immediately
// terminates the straggler's own pending request against T1 (it rejects
// with a protocol-level `McpError` the moment the transport closes, not
// later via the fake server's release gate), so the "T1 still open, fails
// independently, later" premise cannot survive even with the supersession
// mechanism swapped to a connection-level `call()` failure. Building an
// equivalent fixture would require reaching into a race window inside
// `resetClient()` itself (between its synchronous `activeTransport = null`
// and its awaited `transport.close()`) that this unit does not expose a
// seam for.
//
// The ownership-guard property both tests protected — a stale reset
// attempt against a transport a newer connect has already replaced must be
// a no-op, and the replacement must stay live — is still exercised by
// "two probes racing the same failing connect share one connect attempt
// and do not crash resetting the shared abandoned transport" above and by
// "an established connection dropped by the server is closed, not merely
// dereferenced" above. The replacement test below covers this story's own
// new angle instead: a connection-level `call()` failure that supersedes
// the shared client does not corrupt or hang an unrelated request already
// in flight against the transport it discards.

test('a connection-level call() failure that supersedes the shared client also cleanly terminates an unrelated request already in flight against the discarded transport', async () => {
  mode = 'ok';
  successfulConnectAttempts = 0;
  const { probeCrawl4AI, callCrawlTool } = await freshModule();

  // Establish T1 cleanly.
  const warm = await probeCrawl4AI(3000);
  assert.equal(warm.status, 'ok');
  assert.equal(successfulConnectAttempts, 1);

  // Start an unrelated request against the same, already-connected client,
  // and let it actually reach the server so it is genuinely in flight, not
  // merely queued locally. The fake holds its tools/list request open
  // rather than answering it.
  mode = 'malformed_pending';
  const inFlight = probeCrawl4AI(10000);
  await new Promise(resolve => setTimeout(resolve, 50));

  // A concurrent tool call fails at the connection level (the fake's
  // `tools/call` handler always answers with an operation-level JSON-RPC
  // error -- see `answer()` above -- so discarding T1 here requires the
  // call's outgoing POST itself to fail, a plain Error rather than an
  // `McpError`). `call()`'s own catch closes T1 via the ownership-guarded
  // `resetClient()`; its one bounded retry reconnects (T2) and hits the
  // same `post_fails` failure again, so T2 is discarded too and the error
  // surfaces with `client`/`connecting`/`activeTransport` left cold.
  mode = 'post_fails';
  await assert.rejects(() =>
    callCrawlTool({ url: 'https://example.invalid/' }),
  );

  // The in-flight request against T1 does not hang forever waiting for the
  // fake's release gate: closing T1 as part of superseding it terminates
  // it immediately with a classified verdict.
  const inFlightResult = await inFlight;
  assert.equal(inFlightResult.status, 'unhealthy');

  // A later probe finds `client`/`connecting` cold and opens a genuinely
  // fresh connection (T3), unaffected by the now-settled in-flight request.
  mode = 'ok';
  const recovered = await probeCrawl4AI(3000);
  assert.equal(recovered.status, 'ok');
  assert.equal(
    successfulConnectAttempts,
    3,
    'T1 and the retry-created T2 were both discarded above; this probe opens a third connection',
  );

  // Deliberately does not call `releasePendingToolsList()`: T1 is already
  // closed by this point, so releasing it would make the fake's `answer()`
  // try to `transport.send()` on a disconnected session, throwing "Not
  // connected" as an unhandled rejection (it runs via a bare `void answer(
  // ...)` in `onmessage`). Leaving the gate's promise permanently pending
  // is safe -- an unresolved `Promise` holds no timer or I/O handle, so it
  // cannot keep `node --test` alive -- and the next test to use
  // `malformed_pending` mode simply overwrites `releaseGate`.
});

test("onerror's SseError gate does not itself react to a failed tool-call POST, but call()'s own connection-level classification (crawl4ai-mcp-client-timeout-and-recovery) now closes the transport and retries once", async () => {
  // Pins crawl4ai.ts's `err instanceof SseError` gate on `transport.onerror`.
  // `SSEClientTransport.send()` (used by every individual tool request,
  // e.g. `web_crawl`) throws a plain `Error` -- not an `SseError` -- when
  // its outgoing POST fails or gets a non-2xx answer, confirmed by reading
  // the SDK's `send()` source. The gate itself still does not treat this as
  // a stream failure -- proactively resetting from inside `onerror` for
  // this shape would abort every other concurrent tool call riding the
  // transport, the same blast radius `probeCrawl4AI`'s own `tools/list`
  // branch is careful to avoid. What changed (this story) is that `call()`
  // now separately classifies its own `callTool` rejection: a non-`McpError`
  // failure is connection-level, so `call()`'s own catch resets and retries
  // once regardless of what the `onerror` handler did or didn't do. Since
  // this fake always fails every `POST /messages` while `post_fails` mode is
  // set, both the first attempt and the retry hit the same failure, so the
  // transport ends up closed and a second (retry-created) transport is
  // opened and closed too before the error surfaces.
  mode = 'ok';
  successfulConnectAttempts = 0;
  const preExisting = new Set(openTransports);
  const { probeCrawl4AI, callCrawlTool } = await freshModule();

  assert.equal((await probeCrawl4AI(3000)).status, 'ok');
  assert.equal(successfulConnectAttempts, 1);
  const mine = [...openTransports].filter(t => !preExisting.has(t));
  assert.equal(
    mine.length,
    1,
    'exactly one new server-side SSE session was opened by this test',
  );

  mode = 'post_fails';
  await assert.rejects(() =>
    callCrawlTool({ url: 'https://example.invalid/' }),
  );

  // Give the close a moment to propagate: closing client-side ends the
  // underlying HTTP response, which this fake's `openTransports` bookkeeping
  // only updates once the server observes that close -- a real, async I/O
  // event, not something visible the instant `callCrawlTool` rejects.
  await new Promise(resolve => setTimeout(resolve, RECONNECT_HINT_MS * 6));
  assert.ok(
    !openTransports.has(mine[0]!),
    "call()'s connection-level classification must close the transport a failed tool-call POST discarded, not merely dereference it",
  );

  // Two more connects happened during the rejected call above: the retry's
  // own reconnect (also discarded, since the retry hit the same post_fails
  // failure), so the next healthy probe opens the third connection overall.
  mode = 'ok';
  const recovered = await probeCrawl4AI(3000);
  assert.equal(recovered.status, 'ok');
  assert.equal(
    successfulConnectAttempts,
    3,
    "the rejected call's own first attempt and its one bounded retry each opened (and closed) a connection; this probe opens a third",
  );
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
