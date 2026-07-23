/**
 * QA-added coverage (crawl4ai-mcp-client-timeout-and-recovery) for two
 * classification branches in `call()` (crawl4ai.ts) that the coder's
 * `crawl4ai-lifecycle.test.ts` exercises only indirectly / timing-dependently
 * or not at all:
 *
 *  1. The `McpError(ErrorCode.ConnectionClosed)` carve-out — the single most
 *     subtle line of `call()`'s connection-level-vs-operation-level split. The
 *     SDK's `Protocol._onclose()` synthesizes exactly this error client-side
 *     for any request still pending when the transport closes, so `call()`
 *     deliberately routes it to the connection-level (reset + one retry)
 *     branch rather than the operation-level (rethrow, no retry) branch every
 *     other `McpError` takes. The lifecycle suite's concurrency self-heal test
 *     only reaches this shape when a sibling's POST has *already succeeded* and
 *     its response is still pending at the instant the shared transport closes
 *     — but that suite poisons the session so both callers' POSTs fail at
 *     `send()` with a plain `Error` (the non-`McpError` branch) first, so the
 *     ConnectionClosed branch is not guaranteed to run. This test pins it
 *     directly and deterministically.
 *
 *  2. A local validation failure (`Crawl4AIConfigError` from a forbidden
 *     field) is computed *before* `call()`'s try/attempt block, so it must
 *     neither open a connection, reset shared state, nor retry — the spec's
 *     "local validation failures are outside the retry/reset scope entirely"
 *     guarantee, which had no direct test.
 *
 * Both stub the SDK `Client` prototype directly (no fake MCP server needed):
 * `connect` is made a resolving no-op and `callTool` is scripted, which keeps
 * each test fully deterministic and free of real network or timing. Each test
 * restores the prototype methods and closes its fresh module's client in a
 * `finally`/`after` so no stub or open handle leaks into another test.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

type ToolResult = { isError?: unknown };

let instance = 0;
async function freshModule(): Promise<typeof import('./crawl4ai.js')> {
  instance++;
  return (await import(
    `./crawl4ai.js?call-classification-test-instance=${instance}`
  )) as typeof import('./crawl4ai.js');
}

test('a callTool rejection with McpError(ConnectionClosed) is classified connection-level and retried exactly once, then resolves', async () => {
  const mod = await freshModule();

  const originalConnect = Client.prototype.connect;
  const originalCallTool = Client.prototype.callTool;
  let callToolCount = 0;

  // A resolving no-op connect: getClient() still constructs a real
  // SSEClientTransport and sets `activeTransport` synchronously before this
  // runs, so the ownership-guarded resetClient() path is genuinely exercised
  // — only the actual network handshake is skipped.
  Client.prototype.connect = (async function patchedConnect(this: Client) {
    // no-op: pretend the handshake succeeded
  }) as typeof Client.prototype.connect;

  Client.prototype.callTool = (async function patchedCallTool(this: Client) {
    callToolCount++;
    if (callToolCount === 1) {
      // Exactly the shape Protocol._onclose() synthesizes for a request left
      // pending when the transport closes under it.
      throw new McpError(ErrorCode.ConnectionClosed, 'Connection closed');
    }
    return { content: [{ type: 'text', text: 'ok' }] };
  }) as unknown as typeof Client.prototype.callTool;

  try {
    const result = (await mod.callCrawlTool({
      url: 'https://example.com/a',
    })) as ToolResult;
    assert.ok(
      !result.isError,
      'the retry against a fresh client must resolve the operation',
    );
    assert.equal(
      callToolCount,
      2,
      'McpError(ConnectionClosed) must be treated as connection-level: exactly one retry, so two callTool attempts total — not rethrown as an operation-level McpError',
    );
  } finally {
    Client.prototype.connect = originalConnect;
    Client.prototype.callTool = originalCallTool;
    await mod.closeCrawl4AIClient();
  }
});

test('a second McpError(ConnectionClosed) on the retry surfaces the raw McpError, with no third attempt', async () => {
  const mod = await freshModule();

  const originalConnect = Client.prototype.connect;
  const originalCallTool = Client.prototype.callTool;
  let callToolCount = 0;

  Client.prototype.connect = (async function patchedConnect(this: Client) {
    // no-op
  }) as typeof Client.prototype.connect;

  Client.prototype.callTool = (async function patchedCallTool(this: Client) {
    callToolCount++;
    throw new McpError(ErrorCode.ConnectionClosed, 'Connection closed');
  }) as unknown as typeof Client.prototype.callTool;

  try {
    await assert.rejects(
      () => mod.callCrawlTool({ url: 'https://example.com/a' }),
      (err: unknown) => {
        // The bounded-retry unwrap must surface the original McpError, not the
        // internal Crawl4AIConnectionFailure wrapper.
        assert.ok(err instanceof McpError, 'expected the raw McpError');
        assert.equal((err as McpError).code, ErrorCode.ConnectionClosed);
        return true;
      },
    );
    assert.equal(
      callToolCount,
      2,
      'the retry is bounded to exactly one: the original attempt plus one retry, no third attempt',
    );
  } finally {
    Client.prototype.connect = originalConnect;
    Client.prototype.callTool = originalCallTool;
    await mod.closeCrawl4AIClient();
  }
});

test('a forbidden-field Crawl4AIConfigError is thrown before any connect/callTool: no connection is opened, nothing is dispatched, and no retry occurs', async () => {
  const mod = await freshModule();

  const originalConnect = Client.prototype.connect;
  const originalCallTool = Client.prototype.callTool;
  let connectCount = 0;
  let callToolCount = 0;

  Client.prototype.connect = (async function patchedConnect(this: Client) {
    connectCount++;
  }) as typeof Client.prototype.connect;

  Client.prototype.callTool = (async function patchedCallTool(this: Client) {
    callToolCount++;
    return { content: [] };
  }) as unknown as typeof Client.prototype.callTool;

  try {
    await assert.rejects(
      () =>
        // `proxy` is a forbidden BrowserConfig field: normalizeCrawl4AIArgs
        // rejects it before call()'s try/attempt block is ever entered.
        mod.callCrawlTool({
          url: 'https://example.com/a',
          browser_config: { proxy: 'http://someproxy:8080' },
        }),
      (err: unknown) => {
        // Cache-busted dynamic import means the module's Crawl4AIConfigError
        // class identity differs from any statically imported one, so assert
        // on the stable `name` rather than instanceof.
        assert.equal(
          (err as Error).name,
          'Crawl4AIConfigError',
          'a forbidden field must surface as a Crawl4AIConfigError',
        );
        return true;
      },
    );
    assert.equal(
      connectCount,
      0,
      'a local validation failure must not open a connection',
    );
    assert.equal(
      callToolCount,
      0,
      'a local validation failure must not dispatch a tool call or trigger any retry',
    );
  } finally {
    Client.prototype.connect = originalConnect;
    Client.prototype.callTool = originalCallTool;
    await mod.closeCrawl4AIClient();
  }
});
