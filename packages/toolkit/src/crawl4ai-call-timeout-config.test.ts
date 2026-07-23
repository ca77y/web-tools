/**
 * Direct unit coverage of the `CRAWL4AI_CALL_TIMEOUT_MS` env-backed config
 * field (config.ts), decoupled from crawl4ai.ts / any MCP server. This only
 * needs `Config.crawl4ai.callTimeoutMs`, sourced fresh per test via a
 * cache-busting dynamic import() — the pattern already established for
 * `Config` elsewhere in this suite (e.g. `crawl4ai-probe.test.ts`'s
 * `freshModule()`) — so each test can set its own `CRAWL4AI_CALL_TIMEOUT_MS`
 * value independent of the others, and independent of whatever
 * `crawl4ai-lifecycle.test.ts` fixes for its own process (`node --test`
 * gives each test file its own process, so the two files' different values
 * never collide).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

let instance = 0;
async function freshConfig(): Promise<typeof import('./config.js')> {
  instance++;
  return (await import(
    `./config.js?call-timeout-config-test-instance=${instance}`
  )) as typeof import('./config.js');
}

test('Config.crawl4ai.callTimeoutMs defaults to 150000ms when CRAWL4AI_CALL_TIMEOUT_MS is unset, strictly greater than the largest crawl budget (page_timeout 120000 + delay_before_return_html 15000 = 135000)', async () => {
  delete process.env.CRAWL4AI_CALL_TIMEOUT_MS;
  const { Config } = await freshConfig();
  assert.equal(Config.crawl4ai.callTimeoutMs, 150000);
  assert.ok(
    Config.crawl4ai.callTimeoutMs > 135000,
    'the default must strictly exceed the toolkit largest crawl budget of 135000ms',
  );
});

test('CRAWL4AI_CALL_TIMEOUT_MS overrides the default, coerced to a positive integer', async () => {
  process.env.CRAWL4AI_CALL_TIMEOUT_MS = '42000';
  const { Config } = await freshConfig();
  assert.equal(Config.crawl4ai.callTimeoutMs, 42000);
  delete process.env.CRAWL4AI_CALL_TIMEOUT_MS;
});

test('a numeric-string override coerces via z.coerce.number(), not string comparison', async () => {
  process.env.CRAWL4AI_CALL_TIMEOUT_MS = '7500';
  const { Config } = await freshConfig();
  assert.strictEqual(Config.crawl4ai.callTimeoutMs, 7500);
  assert.equal(typeof Config.crawl4ai.callTimeoutMs, 'number');
  delete process.env.CRAWL4AI_CALL_TIMEOUT_MS;
});

test('Config.crawl4ai.callTimeoutMs is grouped with the existing crawl4ai.url/apiToken fields, distinct from the unrelated, SearXNG-specific Config.requestTimeout', async () => {
  delete process.env.CRAWL4AI_CALL_TIMEOUT_MS;
  const { Config } = await freshConfig();
  assert.ok(
    'callTimeoutMs' in Config.crawl4ai,
    'callTimeoutMs must live on Config.crawl4ai, alongside url/apiToken',
  );
  assert.ok('url' in Config.crawl4ai);
  assert.ok('apiToken' in Config.crawl4ai);
  // requestTimeout is SearXNG-specific (30 seconds, not milliseconds) and
  // must remain untouched and unrelated: reusing it for Crawl4AI would be
  // exactly the defect the spec calls out for the acceptance gate to reject.
  assert.equal(Config.requestTimeout, 30);
  assert.notEqual(Config.crawl4ai.callTimeoutMs, Config.requestTimeout);
});
