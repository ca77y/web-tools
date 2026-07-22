/**
 * `Config` is parsed once at import time from `process.env`
 * (`config.ts`'s top-level `envSchema.parse(process.env)`), so exercising
 * two different `CRAWL4AI_CALL_TIMEOUT_MS` values needs two distinct
 * module instances: a dynamic import with a cache-busting query string,
 * the same technique `crawl4ai.ts`'s own tests use for its memoised
 * client.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

let instance = 0;
async function freshConfig(): Promise<typeof import('./config.js')> {
  instance++;
  return (await import(
    `./config.js?config-test-instance=${instance}`
  )) as typeof import('./config.js');
}

// functions.ts's web_fetch default recipe: page_timeout: 120_000 plus the
// default delay_before_return_html of 15s (15_000ms) — transcribed here
// rather than imported, mirroring the existing convention in
// crawl4ai.test.ts that transcribes the forbidden-field lists from
// ARCHITECTURE.md rather than importing them, so this test fails loudly if
// the two ever drift apart instead of silently tracking a changed budget.
const CRAWL_BUDGET_MS = 120_000 + 15_000;

test("the default Crawl4AI call timeout exceeds the toolkit's own largest crawl budget", async () => {
  delete process.env.CRAWL4AI_CALL_TIMEOUT_MS;
  const { Config, DEFAULT_CRAWL4AI_CALL_TIMEOUT_MS } = await freshConfig();

  assert.ok(
    Config.crawl4ai.callTimeoutMs > CRAWL_BUDGET_MS,
    `expected the default call timeout (${Config.crawl4ai.callTimeoutMs}ms) to exceed the crawl budget (${CRAWL_BUDGET_MS}ms)`,
  );
  assert.equal(Config.crawl4ai.callTimeoutMs, DEFAULT_CRAWL4AI_CALL_TIMEOUT_MS);
});

test('CRAWL4AI_CALL_TIMEOUT_MS overrides the default', async () => {
  process.env.CRAWL4AI_CALL_TIMEOUT_MS = '5000';
  try {
    const { Config } = await freshConfig();
    assert.equal(Config.crawl4ai.callTimeoutMs, 5000);
  } finally {
    delete process.env.CRAWL4AI_CALL_TIMEOUT_MS;
  }
});
