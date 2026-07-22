/**
 * Direct unit tests of the config-normalization helper documented in
 * docs/ARCHITECTURE.md, "Crawl4AI Config Contract" (under Runtime Services
 * → Crawl4AI): `normalizeCrawl4AIArgs`, `unwrapCrawl4AIConfig`, and
 * `Crawl4AIConfigError`. These exercise the
 * helper in isolation — no network, no MCP server — leaving the
 * end-to-end "what actually goes out on the wire" scenarios to
 * web-crawl-envelope.test.ts (default env) and web-crawl-proxy.test.ts
 * (PROXY_SERVER/PROXY_USERNAME env), which capture the real outgoing MCP
 * tool arguments per the unit's Validation section.
 *
 * A plain static import is safe here: this file never touches
 * `Config.crawl4ai.url`, so `config.ts`'s import-time env parsing (which
 * only needs `API_KEY`, already set by the package's `test` script) is not
 * a concern.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import {
  Crawl4AIConfigError,
  normalizeCrawl4AIArgs,
  unwrapCrawl4AIConfig,
} from './crawl4ai.js';

// The pinned image's UNTRUSTED_FORBIDDEN_FIELDS, transcribed literally from
// the forbidden-field lists in docs/ARCHITECTURE.md's "Crawl4AI Config
// Contract", so this test fails if crawl4ai.ts's constants ever drift from
// the recorded evidence (a typo in one field name would otherwise let that
// field through).
const FORBIDDEN_BROWSER_FIELDS = [
  'browser_context_id',
  'cdp_url',
  'channel',
  'chrome_channel',
  'cookies',
  'debugging_port',
  'extra_args',
  'headers',
  'host',
  'init_scripts',
  'proxy',
  'proxy_config',
  'storage_state',
  'target_id',
  'user_data_dir',
];
const FORBIDDEN_CRAWLER_FIELDS = [
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

describe('unwrapCrawl4AIConfig', () => {
  test('returns undefined for an absent value', () => {
    assert.equal(unwrapCrawl4AIConfig(undefined, 'BrowserConfig'), undefined);
  });

  test('throws Crawl4AIConfigError, naming the config key, for a present non-object value', () => {
    for (const junk of ['nope', 42, true]) {
      assert.throws(
        () => unwrapCrawl4AIConfig(junk, 'BrowserConfig'),
        (err: unknown) => {
          assert.ok(err instanceof Crawl4AIConfigError);
          assert.equal(err.field, 'browser_config');
          assert.equal(err.typeName, 'BrowserConfig');
          assert.match(err.message, /browser_config/);
          return true;
        },
        `expected a Crawl4AIConfigError for: ${JSON.stringify(junk)}`,
      );
    }
    // The other config key names itself correctly too.
    assert.throws(
      () => unwrapCrawl4AIConfig('nope', 'CrawlerRunConfig'),
      (err: unknown) => {
        assert.ok(err instanceof Crawl4AIConfigError);
        assert.equal(err.field, 'crawler_config');
        assert.equal(err.typeName, 'CrawlerRunConfig');
        return true;
      },
    );
  });

  test('treats a flat object as flat', () => {
    assert.deepEqual(
      unwrapCrawl4AIConfig({ headless: false }, 'BrowserConfig'),
      {
        headless: false,
      },
    );
  });

  test('unwraps a wrapped object with matching type and a params object', () => {
    assert.deepEqual(
      unwrapCrawl4AIConfig(
        { type: 'BrowserConfig', params: { headless: false } },
        'BrowserConfig',
      ),
      { headless: false },
    );
  });

  test('a type field alone, with no params object, is not treated as wrapped', () => {
    assert.deepEqual(
      unwrapCrawl4AIConfig({ type: 'CrawlerRunConfig' }, 'CrawlerRunConfig'),
      { type: 'CrawlerRunConfig' },
    );
  });

  test('a mismatched type name is not treated as wrapped', () => {
    assert.deepEqual(
      unwrapCrawl4AIConfig(
        { type: 'BrowserConfig', params: { headless: false } },
        'CrawlerRunConfig',
      ),
      { type: 'BrowserConfig', params: { headless: false } },
    );
  });

  test('throws for null and for an array — neither is a config-shaped object', () => {
    // `typeof null === 'object'`, and an array is an object too, so both
    // need the explicit guards. Neither silently falls back to the
    // stealth defaults: a present `null`/array browser_config is exactly
    // as malformed as a present string or number, and gets the same
    // Crawl4AIConfigError naming the field rather than a silent default.
    for (const junk of [null, [1, 2]]) {
      assert.throws(
        () => unwrapCrawl4AIConfig(junk, 'BrowserConfig'),
        (err: unknown) => {
          assert.ok(err instanceof Crawl4AIConfigError);
          assert.equal(err.field, 'browser_config');
          return true;
        },
        `expected a Crawl4AIConfigError for: ${JSON.stringify(junk)}`,
      );
    }
  });

  test('a non-object params is not treated as wrapped', () => {
    // Upstream's predicate requires `params` to be a mapping; a string
    // `params` falls through to the raw-dict branch, so we must too.
    assert.deepEqual(
      unwrapCrawl4AIConfig(
        { type: 'CrawlerRunConfig', params: 'not-an-object' },
        'CrawlerRunConfig',
      ),
      { type: 'CrawlerRunConfig', params: 'not-an-object' },
    );
  });
});

describe('every field on the pinned image forbidden sets is rejected', () => {
  for (const field of FORBIDDEN_BROWSER_FIELDS) {
    test(`browser_config.${field} is rejected`, () => {
      assert.throws(
        () => normalizeCrawl4AIArgs({ browser_config: { [field]: 'x' } }),
        (err: unknown) => {
          assert.ok(err instanceof Crawl4AIConfigError);
          assert.equal(err.field, field);
          assert.equal(err.typeName, 'BrowserConfig');
          assert.match(err.message, new RegExp(field));
          return true;
        },
      );
    });
  }

  for (const field of FORBIDDEN_CRAWLER_FIELDS) {
    test(`crawler_config.${field} is rejected`, () => {
      assert.throws(
        () => normalizeCrawl4AIArgs({ crawler_config: { [field]: 'x' } }),
        (err: unknown) => {
          assert.ok(err instanceof Crawl4AIConfigError);
          assert.equal(err.field, field);
          assert.equal(err.typeName, 'CrawlerRunConfig');
          assert.match(err.message, new RegExp(field));
          return true;
        },
      );
    });
  }

  test('the forbidden sets are per type, not shared', () => {
    // `magic`/`session_id` are CrawlerRunConfig-only; `cdp_url`/`headers`
    // are BrowserConfig-only. Applying one set to the other type would
    // both over-reject and under-reject.
    assert.doesNotThrow(() =>
      normalizeCrawl4AIArgs({ browser_config: { magic: true } }),
    );
    assert.doesNotThrow(() =>
      normalizeCrawl4AIArgs({ browser_config: { session_id: 'abc' } }),
    );
    assert.doesNotThrow(() =>
      normalizeCrawl4AIArgs({ crawler_config: { cdp_url: 'x' } }),
    );
    assert.doesNotThrow(() =>
      normalizeCrawl4AIArgs({ crawler_config: { headers: {} } }),
    );
  });
});

describe('normalizeCrawl4AIArgs', () => {
  test('a flat config carrying a field named type is not mistaken for a wrapper', () => {
    const result = normalizeCrawl4AIArgs({
      crawler_config: { type: 'CrawlerRunConfig' },
    });
    assert.deepEqual(result.crawler_config, {
      type: 'CrawlerRunConfig',
      params: { type: 'CrawlerRunConfig' },
    });
  });

  test('wraps a flat crawler_config into the canonical envelope', () => {
    const result = normalizeCrawl4AIArgs({
      crawler_config: { css_selector: 'main' },
    });
    assert.deepEqual(result.crawler_config, {
      type: 'CrawlerRunConfig',
      params: { css_selector: 'main' },
    });
  });

  test('an already-wrapped crawler_config is passed through in canonical form', () => {
    const result = normalizeCrawl4AIArgs({
      crawler_config: {
        type: 'CrawlerRunConfig',
        params: { css_selector: 'main' },
      },
    });
    assert.deepEqual(result.crawler_config, {
      type: 'CrawlerRunConfig',
      params: { css_selector: 'main' },
    });
  });

  test('does not invent a crawler_config key when none is present', () => {
    const result = normalizeCrawl4AIArgs({ urls: ['https://example.com'] });
    assert.ok(!('crawler_config' in result));
  });

  test('does not invent a browser_config key when none is present', () => {
    const result = normalizeCrawl4AIArgs({ urls: ['https://example.com'] });
    assert.ok(!('browser_config' in result));
  });

  test('every other key passes through untouched', () => {
    const result = normalizeCrawl4AIArgs({
      urls: ['https://example.com'],
      extra: 42,
    });
    assert.deepEqual(result.urls, ['https://example.com']);
    assert.equal(result.extra, 42);
  });

  test('an unknown but non-forbidden key is forwarded unchanged', () => {
    const result = normalizeCrawl4AIArgs({
      crawler_config: { css_selector: 'main', not_a_real_key: 1 },
    });
    assert.deepEqual(result.crawler_config, {
      type: 'CrawlerRunConfig',
      params: { css_selector: 'main', not_a_real_key: 1 },
    });
  });

  test('throws Crawl4AIConfigError naming a forbidden crawler_config field', () => {
    assert.throws(
      () => normalizeCrawl4AIArgs({ crawler_config: { magic: true } }),
      (err: unknown) => {
        assert.ok(err instanceof Crawl4AIConfigError);
        assert.equal(err.field, 'magic');
        assert.equal(err.typeName, 'CrawlerRunConfig');
        assert.match(err.message, /magic/);
        assert.match(err.message, /untrusted request/i);
        return true;
      },
    );
  });

  test('throws Crawl4AIConfigError naming a forbidden browser_config field', () => {
    assert.throws(
      () =>
        normalizeCrawl4AIArgs({
          browser_config: { cdp_url: 'http://127.0.0.1:9222' },
        }),
      (err: unknown) => {
        assert.ok(err instanceof Crawl4AIConfigError);
        assert.equal(err.field, 'cdp_url');
        assert.equal(err.typeName, 'BrowserConfig');
        assert.match(err.message, /cdp_url/);
        return true;
      },
    );
  });

  test('throws a proxy_config-specific message naming the field and the per-request-proxy limitation', () => {
    assert.throws(
      () =>
        normalizeCrawl4AIArgs({
          browser_config: {
            proxy_config: { server: 'x', username: 'y', password: 'z' },
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof Crawl4AIConfigError);
        assert.equal(err.field, 'proxy_config');
        assert.match(err.message, /proxy_config/);
        assert.match(err.message, /per-request proxy configuration/i);
        return true;
      },
    );
  });

  test('does not mutate the caller-supplied args object', () => {
    const args = {
      urls: ['https://example.com'],
      crawler_config: { css_selector: 'main' },
    };
    const snapshot = JSON.parse(JSON.stringify(args));
    normalizeCrawl4AIArgs(args);
    assert.deepEqual(args, snapshot);
  });

  test('a present but non-object crawler_config is rejected, not silently coerced to an empty config', () => {
    for (const junk of ['junk', null, ['array'], 42, true]) {
      assert.throws(
        () => normalizeCrawl4AIArgs({ crawler_config: junk }),
        (err: unknown) => {
          assert.ok(err instanceof Crawl4AIConfigError);
          assert.equal(err.field, 'crawler_config');
          assert.equal(err.typeName, 'CrawlerRunConfig');
          assert.match(err.message, /crawler_config/);
          return true;
        },
        `expected a Crawl4AIConfigError for crawler_config: ${JSON.stringify(junk)}`,
      );
    }
  });

  test('a present but non-object browser_config is rejected, not silently coerced to an empty config', () => {
    for (const junk of ['junk', null, ['array'], 42, true]) {
      assert.throws(
        () => normalizeCrawl4AIArgs({ browser_config: junk }),
        (err: unknown) => {
          assert.ok(err instanceof Crawl4AIConfigError);
          assert.equal(err.field, 'browser_config');
          assert.equal(err.typeName, 'BrowserConfig');
          assert.match(err.message, /browser_config/);
          return true;
        },
        `expected a Crawl4AIConfigError for browser_config: ${JSON.stringify(junk)}`,
      );
    }
  });

  test('an absent config is still a no-op — only a present malformed value is rejected', () => {
    const result = normalizeCrawl4AIArgs({ urls: ['https://example.com'] });
    assert.ok(!('crawler_config' in result));
    assert.ok(!('browser_config' in result));
  });

  test('a forbidden field in a wrapped envelope is still caught', () => {
    assert.throws(
      () =>
        normalizeCrawl4AIArgs({
          crawler_config: {
            type: 'CrawlerRunConfig',
            params: { session_id: 'abc' },
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof Crawl4AIConfigError);
        assert.equal(err.field, 'session_id');
        return true;
      },
    );
  });
});
