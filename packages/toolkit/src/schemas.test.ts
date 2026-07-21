/**
 * Requirement: "The published schema describes only what is actually
 * accepted" — static, structural checks of the Zod schemas themselves,
 * plus a normalization check proving every key `WebCrawlInput` still
 * declares survives `normalizeCrawl4AIArgs` untouched. No network, no
 * config env dependency beyond `API_KEY` (already set by this package's
 * `test` script) — `crawl4ai.ts`'s only env-sensitive code path
 * (`getClient`) is never exercised here, only the pure
 * `normalizeCrawl4AIArgs` helper, so a plain static import is safe.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { ZodObject, ZodOptional } from 'zod';

import { normalizeCrawl4AIArgs } from './crawl4ai.js';
import { WebCrawlInput, WebFetchInput } from './schemas.js';

// The pinned image's CrawlerRunConfig forbidden set (crawl4ai.ts is the
// source of truth; duplicated here as literal strings so this test fails
// loudly, rather than vacuously, if the schema and the forbidden set ever
// drift back together).
const FORBIDDEN_CRAWLER_KEYS = [
  'js_code',
  'magic',
  'override_navigator',
  'session_id',
  'simulate_user',
];
// Keys absent from the pinned image's UNTRUSTED_FIELD_ALLOWLIST — accepted
// but silently dropped rather than rejected. See docs/ARCHITECTURE.md,
// "Crawl4AI Config Contract" ("unknown fields are silently dropped").
const DROPPED_CRAWLER_KEYS = ['js_only', 'semaphore_count'];

// The complete CrawlerRunConfig forbidden set from docs/ARCHITECTURE.md's
// "Crawl4AI Config Contract", not only the five the requirement names. The
// published schema must not advertise any of them, however they got there.
const ALL_FORBIDDEN_CRAWLER_KEYS = [
  'base_url',
  'c4a_script',
  'deep_crawl_strategy',
  'experimental',
  'fallback_fetch_function',
  'js_code',
  'js_code_before_wait',
  'magic',
  'override_navigator',
  'process_in_browser',
  'proxy_config',
  'proxy_rotation_strategy',
  'proxy_session_auto_release',
  'proxy_session_id',
  'proxy_session_ttl',
  'session_id',
  'shared_data',
  'simulate_user',
];

// Keys the shipped code paths depend on: the CLI's flag mapping
// (packages/cli/src/commands/crawl.ts) and web_fetch's own defaults. The
// schema pass must not have deleted more than the forbidden/dropped set.
const REQUIRED_CRAWLER_KEYS = [
  'screenshot',
  'pdf',
  'css_selector',
  'wait_for',
  'page_timeout',
  'wait_until',
  'delay_before_return_html',
];

function crawlerConfigShapeKeys(): string[] {
  const crawlerConfigSchema = WebCrawlInput.shape.crawler_config;
  assert.ok(
    crawlerConfigSchema instanceof ZodOptional,
    'crawler_config must be optional',
  );
  const inner = crawlerConfigSchema.unwrap();
  assert.ok(inner instanceof ZodObject, 'crawler_config must be a ZodObject');
  return Object.keys(inner.shape);
}

describe('WebCrawlInput no longer documents forbidden or dropped keys', () => {
  const declaredKeys = crawlerConfigShapeKeys();

  for (const key of [...FORBIDDEN_CRAWLER_KEYS, ...DROPPED_CRAWLER_KEYS]) {
    test(`does not declare '${key}'`, () => {
      assert.ok(
        !declaredKeys.includes(key),
        `WebCrawlInput.crawler_config must not declare '${key}'`,
      );
    });
  }
});

describe('WebCrawlInput declares no key from the full forbidden set', () => {
  const declaredKeys = crawlerConfigShapeKeys();

  test('none of the 18 CrawlerRunConfig forbidden fields is declared', () => {
    const leaked = ALL_FORBIDDEN_CRAWLER_KEYS.filter(k =>
      declaredKeys.includes(k),
    );
    assert.deepEqual(leaked, []);
  });

  test('the keys the CLI flag mapping and web_fetch defaults rely on survive', () => {
    const missing = REQUIRED_CRAWLER_KEYS.filter(
      k => !declaredKeys.includes(k),
    );
    assert.deepEqual(
      missing,
      [],
      'the schema pass must not delete keys that are still emitted',
    );
  });
});

describe('WebCrawlInput documents the flat shape at the nesting level the implementation accepts', () => {
  test('a crawler_config built strictly from the declared keys, at the top level, is normalized and sent with no key rejected or dropped by Web Tools', () => {
    const declaredKeys = crawlerConfigShapeKeys();
    assert.ok(
      declaredKeys.length > 0,
      'expected WebCrawlInput to declare at least one crawler_config key',
    );

    const callerCrawlerConfig = Object.fromEntries(
      declaredKeys.map(key => [key, true]),
    );

    let normalized: Record<string, unknown>;
    assert.doesNotThrow(() => {
      normalized = normalizeCrawl4AIArgs({
        crawler_config: callerCrawlerConfig,
      });
    });

    const wrapped = normalized!.crawler_config as {
      type: string;
      params: Record<string, unknown>;
    };
    assert.equal(wrapped.type, 'CrawlerRunConfig');
    assert.deepEqual(Object.keys(wrapped.params).sort(), declaredKeys.sort());
  });
});

describe('WebFetchInput no longer publishes session_id', () => {
  test('WebFetchInput declares no session_id parameter', () => {
    assert.ok(
      !('session_id' in WebFetchInput.shape),
      'WebFetchInput must not declare a session_id parameter',
    );
  });

  test('the other web_fetch parameters the handler still reads survive', () => {
    for (const key of ['url', 'f', 'q', 'c', 'delay']) {
      assert.ok(
        key in WebFetchInput.shape,
        `WebFetchInput must still declare '${key}'`,
      );
    }
  });

  test('no WebFetchInput parameter description advertises session_id', () => {
    // The requirement is that the *published schema* describes only what is
    // actually accepted. A description telling callers to reuse a
    // `session_id` still advertises a parameter that no longer exists and
    // that the pinned image rejects with a 400 — `session_id` is on
    // CrawlerRunConfig's forbidden list in docs/ARCHITECTURE.md's "Crawl4AI
    // Config Contract".
    const offenders = Object.entries(WebFetchInput.shape)
      .filter(([, schema]) => (schema.description ?? '').includes('session_id'))
      .map(([key]) => key);
    assert.deepEqual(offenders, []);
  });
});
