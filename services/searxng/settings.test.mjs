/**
 * Static, dependency-free structural tests for `services/searxng/settings.yml`.
 *
 * These assert the invariants from the
 * `searxng-engine-set-and-suspension-policy` spec that can be checked from
 * the checked-in text alone: no container, no network, no YAML-parsing
 * dependency (Node has none built in). A minimal targeted reader below
 * extracts just the shapes this file is known to have — it is not a general
 * YAML parser.
 *
 * Runtime scenarios (GET /config, a live search, the PROXY_URL-unset boot,
 * and the image build) are QA/acceptance-owned per the spec's
 * Test-execution boundary and are not covered here.
 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const settingsPath = join(__dirname, 'settings.yml');
const text = readFileSync(settingsPath, 'utf8');

const EXPECTED_KEEP_ONLY = [
  'google cse',
  'brave',
  'duckduckgo web',
  'bing',
  'mojeek',
  'yandex',
  'dogpile',
  'gmx',
  'wikipedia',
];

/**
 * These engines are forbidden, not merely absent — each was measured broken
 * in a way that re-adding would silently or loudly degrade search:
 *
 * - `google`: upstream ships it `inactive: true` because its HTML endpoint is
 *   JS-gated: every response is Google's "enablejs" interstitial, the XPath
 *   selectors match nothing, and *nothing raises* — a successful search with
 *   zero results on every query.
 * - `qwant`: Datadome bot protection CAPTCHAs every request from any IP;
 *   upstream has no fix (searxng/searxng#3929, removed here 2026-07-24).
 * - `duckduckgo`: the html.duckduckgo.com lite scraper draws a CAPTCHA after
 *   ~2 queries even from a clean residential IP; replaced by `duckduckgo web`
 *   (the links.duckduckgo.com/d.js JSON API), which sustained 6/6.
 * - `startpage`: instant CAPTCHA on first contact (probed 2026-07-24).
 *
 * `google cse` was on this list while it was an unintended engine loaded by the
 * old scalar `use_default_settings: true`; it is now a deliberate choice and so
 * moved to EXPECTED_KEEP_ONLY.
 */
const FORBIDDEN_ENGINES = ['wikidata', 'startpage', 'google', 'qwant', 'duckduckgo'];

const SUSPENDED_TIMES_KEYS = [
  'SearxEngineCaptcha',
  'SearxEngineTooManyRequests',
  'SearxEngineAccessDenied',
  'cf_SearxEngineCaptcha',
  'cf_SearxEngineAccessDenied',
  'recaptcha_SearxEngineCaptcha',
];

const UPSTREAM_24H_DEFAULT = 86400;

/**
 * Split the file into its top-level (column-0) `key:` sections, in order.
 * `settings.yml`'s top-level keys are exactly `use_default_settings`,
 * `server`, `redis`, `search`, `outgoing`, and `engines` — none of them are
 * indented, so a column-0 `word:` match is an unambiguous section boundary.
 */
function topLevelSections(fileText) {
  const re = /^([A-Za-z_][\w-]*):/gm;
  const matches = [...fileText.matchAll(re)];
  assert.ok(matches.length > 0, 'no top-level keys found in settings.yml');
  const sections = {};
  for (let i = 0; i < matches.length; i += 1) {
    const key = matches[i][1];
    const start = matches[i].index;
    const end = i + 1 < matches.length ? matches[i + 1].index : fileText.length;
    sections[key] = { text: fileText.slice(start, end), start, end };
  }
  return sections;
}

/** Extract the `- item` list following the given `listKey:` marker in `block`. */
function parseYamlList(block, listKey) {
  const idx = block.indexOf(listKey);
  assert.ok(idx >= 0, `"${listKey}" not found in block`);
  const rest = block.slice(idx + listKey.length).split('\n').slice(1);
  const items = [];
  for (const line of rest) {
    const m = /^\s*-\s*(\S.*?)\s*$/.exec(line);
    if (m) {
      items.push(m[1]);
    } else if (line.trim() === '') {
      continue;
    } else {
      break;
    }
  }
  return items;
}

/** Read a plain `key: <integer>` scalar, anchored so prefixed keys (e.g. `cf_X` vs `X`) never collide. */
function getIntValue(block, key) {
  const re = new RegExp(`^[ \\t]*${key}:[ \\t]*(-?\\d+)[ \\t]*$`, 'm');
  const m = re.exec(block);
  assert.ok(m, `"${key}" not found (or not a plain integer scalar) in block`);
  return Number(m[1]);
}

/**
 * Determine, for each `KEY: <int>` line in `block`, whether it is "covered"
 * by an explanatory comment: either a `#` comment line immediately above it
 * (possibly separated by other comment lines / blank lines), or — for
 * values that share one rationale comment as a group (e.g. the three
 * cf_/recaptcha_ keys under one shared comment) — by being contiguously
 * adjacent (no blank line, no unrelated line) to a covered value line above.
 */
function commentCoverage(block) {
  const coverage = {};
  let commentSeenSinceLastValue = false;
  let prevValueCovered = false;
  for (const rawLine of block.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('#')) {
      commentSeenSinceLastValue = true;
      continue;
    }
    if (line === '') {
      continue;
    }
    const m = /^([A-Za-z_][\w-]*):\s*(-?\d+)\s*$/.exec(line);
    if (m) {
      const key = m[1];
      const isCovered = commentSeenSinceLastValue || prevValueCovered;
      coverage[key] = isCovered;
      prevValueCovered = isCovered;
      commentSeenSinceLastValue = false;
    } else {
      // Any other content (e.g. the `suspended_times:` header itself) breaks the chain.
      commentSeenSinceLastValue = false;
      prevValueCovered = false;
    }
  }
  return coverage;
}

const sections = topLevelSections(text);

describe('services/searxng/settings.yml — engine allowlist', () => {
  test('use_default_settings is the mapping form with engines.keep_only, not the scalar true', () => {
    const block = sections.use_default_settings.text;
    assert.ok(
      !/^use_default_settings:\s*true\s*$/m.test(block),
      'use_default_settings must not be the scalar `true`',
    );
    assert.match(block, /^\s*engines:\s*$/m);
    assert.match(block, /^\s*keep_only:\s*$/m);
  });

  test('keep_only contains exactly the nine intended engines (order-independent)', () => {
    const keepOnly = parseYamlList(sections.use_default_settings.text, 'keep_only:');
    assert.deepStrictEqual(
      [...keepOnly].sort(),
      [...EXPECTED_KEEP_ONLY].sort(),
    );
  });

  test('the local engines: list names are a subset of keep_only', () => {
    const keepOnly = new Set(
      parseYamlList(sections.use_default_settings.text, 'keep_only:'),
    );
    // `(\S.*?)` rather than `(\S+)`: engine names may contain spaces
    // ("google cse"), and a `\S+` capture silently fails to match those lines
    // entirely, dropping them from the check instead of testing them.
    const localNames = [
      ...sections.engines.text.matchAll(/^\s*-\s*name:\s*(\S.*?)\s*$/gm),
    ].map((m) => m[1]);
    assert.ok(localNames.length > 0, 'no local engine names found');
    for (const name of localNames) {
      assert.ok(
        keepOnly.has(name),
        `local engines: entry "${name}" is not in keep_only`,
      );
    }
  });

  test('forbidden engines (wikidata, startpage, google, qwant, duckduckgo) are absent from keep_only and engines:', () => {
    const keepOnly = parseYamlList(sections.use_default_settings.text, 'keep_only:');
    const localNames = [
      ...sections.engines.text.matchAll(/^\s*-\s*name:\s*(\S.*?)\s*$/gm),
    ].map((m) => m[1]);
    for (const forbidden of FORBIDDEN_ENGINES) {
      assert.ok(
        !keepOnly.includes(forbidden),
        `keep_only must not contain "${forbidden}"`,
      );
      assert.ok(
        !localNames.includes(forbidden),
        `engines: must not declare "${forbidden}"`,
      );
    }
  });

  test('the JS-gated google engine is not declared anywhere in engines:', () => {
    // Guards the removal, not just the allowlist: a `- name: google` entry
    // would be a no-op today (it is not in keep_only) but would come back to
    // life the moment anyone re-added it there.
    const localNames = [
      ...sections.engines.text.matchAll(/^\s*-\s*name:\s*(\S.*?)\s*$/gm),
    ].map((m) => m[1]);
    assert.ok(
      !localNames.includes('google'),
      'engines: must not declare the plain "google" engine — it returns Google\'s ' +
        '"enablejs" interstitial with HTTP 200, yielding zero results and raising nothing',
    );
  });

  test('google cse needs no inactive override, unlike the google engine it replaced', () => {
    // `google` required an explicit `inactive: false` because upstream marks it
    // inactive. `google cse` is active in upstream's defaults, so an override
    // here would be cargo-culted noise — and would mask a future upstream
    // deactivation exactly like the one that made `google` fail silently.
    const entry = /-\s*name:\s*google cse\b[\s\S]*?(?=\n\s*- name:|\n*$)/.exec(
      sections.engines.text,
    );
    assert.ok(entry, 'no "- name: google cse" entry found in engines:');
    assert.ok(
      !/^\s*inactive:\s*/m.test(entry[0]),
      'google cse must not carry an inactive: override',
    );
    assert.match(entry[0], /^\s*engine:\s*google_cse\s*$/m);
  });

  test('default_lang is auto, and the mojeek locale-cookie trap is documented', () => {
    // `default_lang: en` resolves to mojeek locale cookies `lb=en; arc=us`,
    // which trip mojeek's bot detection into the silent-empty failure mode
    // (0 results, nothing raised — measured 2026-07-24, single-variable test
    // on the stock image: 6/6 with auto, 0/6 with en, same IP). Anyone
    // "restoring" an English default must find this rationale in the file.
    const searchBlock = sections.search.text;
    assert.match(searchBlock, /^\s*default_lang:\s*auto\s*$/m);
    const langRegion = searchBlock.slice(0, searchBlock.indexOf('default_lang:'));
    assert.match(langRegion, /mojeek/i);
    assert.match(langRegion, /lb=en/);
  });

  test('the third-party CX that google cse depends on is documented as a risk', () => {
    // Upstream hard-codes someone else's Programmable Search id in
    // searx/engines/google_cse.py. That is a real availability dependency and
    // must not be adopted silently.
    const entryRegion = sections.engines.text.slice(
      0,
      sections.engines.text.indexOf('- name: google cse'),
    );
    assert.match(entryRegion, /partner-pub-8993703457585266/);
    assert.match(entryRegion, /third-party/i);
  });
});

describe('services/searxng/settings.yml — suspension policy', () => {
  const searchBlock = sections.search.text;
  const suspendedTimesIdx = searchBlock.indexOf('suspended_times:');
  assert.ok(suspendedTimesIdx >= 0, 'suspended_times: not found in search: block');
  const suspendedTimesToEnd = searchBlock.slice(suspendedTimesIdx);

  test('all six suspended_times classes are positive integers under the 24h upstream default', () => {
    for (const key of SUSPENDED_TIMES_KEYS) {
      const value = getIntValue(suspendedTimesToEnd, key);
      assert.ok(value > 0, `${key} must be > 0, got ${value}`);
      assert.ok(
        value < UPSTREAM_24H_DEFAULT,
        `${key} must be < ${UPSTREAM_24H_DEFAULT} (upstream 24h default), got ${value}`,
      );
    }
  });

  test('suspension durations follow the rotation-recoverability ordering: Captcha < TooManyRequests < AccessDenied', () => {
    const captcha = getIntValue(suspendedTimesToEnd, 'SearxEngineCaptcha');
    const tooMany = getIntValue(suspendedTimesToEnd, 'SearxEngineTooManyRequests');
    const accessDenied = getIntValue(suspendedTimesToEnd, 'SearxEngineAccessDenied');
    assert.ok(captcha < tooMany, `SearxEngineCaptcha (${captcha}) must be < SearxEngineTooManyRequests (${tooMany})`);
    assert.ok(
      tooMany < accessDenied,
      `SearxEngineTooManyRequests (${tooMany}) must be < SearxEngineAccessDenied (${accessDenied})`,
    );
  });

  test('the generic per-fail ban is bounded non-zero', () => {
    const banTimeOnFail = getIntValue(searchBlock, 'ban_time_on_fail');
    const maxBanTimeOnFail = getIntValue(searchBlock, 'max_ban_time_on_fail');
    assert.ok(banTimeOnFail > 0, `ban_time_on_fail must be > 0, got ${banTimeOnFail}`);
    assert.ok(
      maxBanTimeOnFail >= banTimeOnFail,
      `max_ban_time_on_fail (${maxBanTimeOnFail}) must be >= ban_time_on_fail (${banTimeOnFail})`,
    );
  });

  test('every suspended_times value and the ban_time_on_fail/max_ban_time_on_fail values carry an explanatory comment', () => {
    const coverage = commentCoverage(suspendedTimesToEnd);
    for (const key of [...SUSPENDED_TIMES_KEYS, 'ban_time_on_fail', 'max_ban_time_on_fail']) {
      assert.ok(coverage[key], `"${key}" has no preceding explanatory comment`);
    }
  });

  test('a comment explains why the CAPTCHA class is kept small', () => {
    // The CAPTCHA-specific rationale comment must mention it stays small
    // because the rotation-recovery paths bypass it with an explicit
    // suspended_time=0, not this config value.
    const captchaCommentRegion = suspendedTimesToEnd.slice(
      0,
      suspendedTimesToEnd.indexOf('SearxEngineCaptcha:'),
    );
    assert.match(captchaCommentRegion, /suspended_time=0/);
    assert.match(captchaCommentRegion, /rotation-recoverable/i);
  });
});

describe('services/searxng/settings.yml — proxy entrypoint preservation', () => {
  test('proxies: and PROXY_URL} each occur exactly once, both after the suspended_times block', () => {
    const proxiesMatches = [...text.matchAll(/proxies:/g)];
    const proxyUrlMatches = [...text.matchAll(/PROXY_URL}/g)];
    assert.strictEqual(proxiesMatches.length, 1, 'expected exactly one "proxies:" occurrence');
    assert.strictEqual(proxyUrlMatches.length, 1, 'expected exactly one "PROXY_URL}" occurrence');

    const searchBlock = sections.search.text;
    const suspendedTimesEndOffset = sections.search.start + searchBlock.length;

    assert.ok(
      proxiesMatches[0].index > suspendedTimesEndOffset,
      '"proxies:" must appear after the suspended_times/search block',
    );
    assert.ok(
      proxyUrlMatches[0].index > suspendedTimesEndOffset,
      '"PROXY_URL}" must appear after the suspended_times/search block',
    );
  });

  test('neither proxies: nor PROXY_URL} appears in the use_default_settings/keep_only or suspended_times content', () => {
    const useDefaultSettingsBlock = sections.use_default_settings.text;
    const searchBlock = sections.search.text;
    assert.ok(!useDefaultSettingsBlock.includes('proxies:'));
    assert.ok(!useDefaultSettingsBlock.includes('PROXY_URL}'));
    assert.ok(!searchBlock.includes('proxies:'));
    assert.ok(!searchBlock.includes('PROXY_URL}'));
  });

  test('the entrypoint still branches on PROXY_URL and reports which branch it took', () => {
    // The boot line is the only way to tell from outside the container whether
    // production is proxied. It is what showed PROXY_URL to be unset in
    // production on 2026-07-23, with every engine but bing and brave blocked.
    const dockerfile = readFileSync(join(__dirname, 'Dockerfile'), 'utf8');
    assert.match(dockerfile, /Proxy: enabled/);
    assert.match(dockerfile, /Proxy: disabled/);
  });

  test('the outgoing: block retries, request_timeout, pool_*, and verify settings are unchanged', () => {
    const outgoingBlock = sections.outgoing.text;
    assert.match(outgoingBlock, /^\s*retries:\s*3\s*$/m);
    assert.match(outgoingBlock, /^\s*request_timeout:\s*15\.0\s*$/m);
    assert.match(outgoingBlock, /^\s*max_request_timeout:\s*20\.0\s*$/m);
    assert.match(outgoingBlock, /^\s*pool_connections:\s*20\s*$/m);
    assert.match(outgoingBlock, /^\s*pool_maxsize:\s*20\s*$/m);
    assert.match(outgoingBlock, /^\s*verify:\s*false\s*$/m);
  });
});

describe('services/searxng/Dockerfile — no build-time source patching', () => {
  const dockerfile = readFileSync(join(__dirname, 'Dockerfile'), 'utf8');

  test('google_sorry_fix.py is gone from the tree', () => {
    assert.ok(
      !existsSync(join(__dirname, 'google_sorry_fix.py')),
      'google_sorry_fix.py patched an engine we no longer run and must stay deleted',
    );
  });

  test('the image does not patch or recompile the upstream searx sources', () => {
    // The patch injected itself by string-replacing google.py's *last*
    // `return results`, which is why it also needed a bytecode recompile. Both
    // are gone; reintroducing either means the base image is being modified
    // again and this test should be revisited deliberately, not silently.
    //
    // Comments are stripped first: the Dockerfile deliberately *names*
    // google_sorry_fix.py to record why it was removed, and that prose must not
    // read as the instruction it is warning about.
    const instructions = dockerfile
      .split('\n')
      .filter((line) => !line.trim().startsWith('#'))
      .join('\n');
    assert.ok(
      !instructions.includes('google_sorry_fix'),
      'Dockerfile must not apply google_sorry_fix.py',
    );
    assert.ok(
      !instructions.includes('compileall'),
      'a compileall step implies the searx sources were modified at build time',
    );
  });
});
