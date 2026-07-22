import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { Config } from './config.js';

// ── Crawl4AI config normalization ───────────────────────────────────────
//
// The pinned Crawl4AI image accepts two outgoing shapes for `browser_config`
// and `crawler_config` identically (flat, or wrapped as
// `{ type, params }`), but silently drops any field absent from its own
// per-type allowlist and answers a *forbidden* field with a 400. See
// docs/ARCHITECTURE.md, "Crawl4AI Config Contract" (under Runtime Services →
// Crawl4AI), for the empirical evidence and the forbidden-field lists.
// `normalizeCrawl4AIArgs` is the single choke point that canonicalizes both
// config keys into the wrapped form the pinned image's own `dump()`/`load()`
// uses, and fails fast on a forbidden field instead of letting Web Tools
// emit a request the image will reject.

export type Crawl4AIConfigTypeName = 'BrowserConfig' | 'CrawlerRunConfig';

export class Crawl4AIConfigError extends Error {
  constructor(
    public readonly field: string,
    public readonly typeName: Crawl4AIConfigTypeName,
    message: string,
  ) {
    super(message);
    this.name = 'Crawl4AIConfigError';
  }
}

// Fields forbidden on BrowserConfig by the pinned image. Source:
// unclecode/crawl4ai:0.9.1, crawl4ai/async_configs.py:UNTRUSTED_FORBIDDEN_FIELDS.
// Revisit this set whenever the pinned Crawl4AI image is bumped.
const FORBIDDEN_BROWSER_CONFIG_FIELDS = new Set([
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
]);

// Fields forbidden on CrawlerRunConfig by the pinned image. Source:
// unclecode/crawl4ai:0.9.1, crawl4ai/async_configs.py:UNTRUSTED_FORBIDDEN_FIELDS.
// Revisit this set whenever the pinned Crawl4AI image is bumped.
const FORBIDDEN_CRAWLER_CONFIG_FIELDS = new Set([
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
]);

const FORBIDDEN_FIELDS: Record<Crawl4AIConfigTypeName, Set<string>> = {
  BrowserConfig: FORBIDDEN_BROWSER_CONFIG_FIELDS,
  CrawlerRunConfig: FORBIDDEN_CRAWLER_CONFIG_FIELDS,
};

// The two config keys `call()` normalizes on every outgoing Crawl4AI call.
const CONFIG_KEYS: ReadonlyArray<
  readonly ['browser_config' | 'crawler_config', Crawl4AIConfigTypeName]
> = [
  ['browser_config', 'BrowserConfig'],
  ['crawler_config', 'CrawlerRunConfig'],
];

// Reverse of CONFIG_KEYS, so unwrapCrawl4AIConfig — which only receives the
// Crawl4AIConfigTypeName, not the outer caller-facing key — can still name
// the malformed key (`browser_config` / `crawler_config`) in an error.
const CONFIG_KEY_NAME_BY_TYPE: Record<
  Crawl4AIConfigTypeName,
  'browser_config' | 'crawler_config'
> = {
  BrowserConfig: 'browser_config',
  CrawlerRunConfig: 'crawler_config',
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function describeValueKind(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

/**
 * Mirrors upstream's own wrapped-detection predicate
 * (`from_serializable_dict`): a value is wrapped iff it is a plain object
 * whose `type` is the expected class name AND which has a `params` object.
 * Everything else — including a flat config that happens to carry a field
 * named `type` but no `params` — is treated as flat.
 */
function isWrapped(
  value: Record<string, unknown>,
  typeName: Crawl4AIConfigTypeName,
): value is { type: string; params: Record<string, unknown> } {
  return value.type === typeName && isPlainObject(value.params);
}

/**
 * Unwraps a caller-supplied `browser_config` / `crawler_config` value to
 * its flat field map, accepting either the flat or the wrapped
 * `{ type, params }` caller envelope. Returns `undefined` only when
 * `value` is genuinely absent (`undefined`) — a caller who supplied
 * *something* that isn't a config-shaped object (a string, number,
 * boolean, `null`, or array) gets a `Crawl4AIConfigError` naming the
 * config key, not a silent fallback to an empty config. Silently
 * replacing "the caller asked for a specific configuration" with "the
 * defaults" is exactly the failure mode this story exists to eliminate,
 * so every caller of this helper shares the same rejection instead of
 * each reimplementing (or forgetting) its own `?? {}` fallback.
 */
export function unwrapCrawl4AIConfig(
  value: unknown,
  typeName: Crawl4AIConfigTypeName,
): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) {
    const configKey = CONFIG_KEY_NAME_BY_TYPE[typeName];
    throw new Crawl4AIConfigError(
      configKey,
      typeName,
      `Crawl4AI config rejected: '${configKey}' must be an object — either flat ` +
        `${typeName} fields, or wrapped as { type: '${typeName}', params }. ` +
        `Got ${describeValueKind(value)}.`,
    );
  }
  if (isWrapped(value, typeName)) return value.params;
  return value;
}

function assertNoForbiddenFields(
  params: Record<string, unknown>,
  typeName: Crawl4AIConfigTypeName,
): void {
  const forbidden = FORBIDDEN_FIELDS[typeName];
  for (const field of Object.keys(params)) {
    if (!forbidden.has(field)) continue;
    if (field === 'proxy_config') {
      throw new Crawl4AIConfigError(
        field,
        typeName,
        `Crawl4AI config rejected: field 'proxy_config' is not permitted on ${typeName} — ` +
          'the pinned Crawl4AI image does not accept per-request proxy configuration from ' +
          'an untrusted request. Configure egress at the Crawl4AI service level instead.',
      );
    }
    throw new Crawl4AIConfigError(
      field,
      typeName,
      `Crawl4AI config rejected: field '${field}' is not permitted on ${typeName} from an ` +
        'untrusted request — the pinned Crawl4AI image does not permit this field.',
    );
  }
}

/**
 * Canonicalizes `browser_config` and `crawler_config`, when present in
 * `args`, into the wrapped `{ type, params }` envelope — accepting either
 * caller envelope on the way in. Absent keys are left absent (never
 * invented); every other key in `args` passes through untouched. Throws
 * `Crawl4AIConfigError` when a forbidden field is present (see
 * `assertNoForbiddenFields`) or when a present config key is not a
 * config-shaped object — delegated to `unwrapCrawl4AIConfig`, which throws
 * with the malformed key itself (`browser_config` / `crawler_config`) as
 * the error's `field`, so this is the one place that logic lives.
 */
export function normalizeCrawl4AIArgs(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = { ...args };
  for (const [key, typeName] of CONFIG_KEYS) {
    if (!(key in args)) continue;
    const flat = unwrapCrawl4AIConfig(args[key], typeName);
    // args[key] present but literally `undefined` (a caller-side JS
    // artifact — JSON strips explicit `undefined`, so real wire traffic
    // never hits this) round-trips as "no config supplied"; anything else
    // non-object already threw inside unwrapCrawl4AIConfig above.
    if (flat === undefined) continue;
    assertNoForbiddenFields(flat, typeName);
    result[key] = { type: typeName, params: flat };
  }
  return result;
}

let client: Client | null = null;
let connecting: Promise<Client> | null = null;

async function getClient(): Promise<Client> {
  if (client) return client;
  if (connecting) return connecting;

  connecting = (async () => {
    const url = new URL('/mcp/sse', Config.crawl4ai.url);
    const headers: Record<string, string> = {};
    if (Config.crawl4ai.apiToken) {
      headers['Authorization'] = `Bearer ${Config.crawl4ai.apiToken}`;
    }

    const transport = new SSEClientTransport(url, {
      eventSourceInit: { fetch: (url, init) => fetch(url, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string>) } }) },
      requestInit: { headers },
    });

    const c = new Client({ name: 'web_tools_crawl4ai_proxy', version: '1.0.0' });

    transport.onerror = (err) => {
      process.stderr.write(`Crawl4AI transport error: ${err.message}\n`);
      client = null;
      connecting = null;
    };

    transport.onclose = () => {
      client = null;
      connecting = null;
    };

    await c.connect(transport);
    client = c;
    connecting = null;
    return c;
  })();

  return connecting;
}

async function call(name: string, args: Record<string, unknown>) {
  const normalizedArgs = normalizeCrawl4AIArgs(args);
  const c = await getClient();
  try {
    return await c.callTool({ name, arguments: normalizedArgs });
  } catch (err) {
    client = null;
    connecting = null;
    throw err;
  }
}

export const callCrawlTool = (args: Record<string, unknown>) => call('crawl', args);
export const callMdTool = (args: Record<string, unknown>) => call('md', args);
export const callScreenshotTool = (args: Record<string, unknown>) => call('screenshot', args);
export const callPdfTool = (args: Record<string, unknown>) => call('pdf', args);
export const callExecuteJsTool = (args: Record<string, unknown>) => call('execute_js', args);

/**
 * Test-only teardown: closes the singleton Crawl4AI MCP client connection,
 * if one is open, and clears it. No production code path calls this — the
 * production client is meant to stay open for the life of the process.
 * Without it, a test file that drives a real call through `call()` against
 * an in-process capture server leaves an open SSE connection behind, which
 * keeps the test process's event loop alive indefinitely (the client
 * auto-reconnects on any connection loss unless explicitly closed). Test
 * files call this from an `after()` hook alongside closing their capture
 * server.
 */
export async function closeCrawl4AIClient(): Promise<void> {
  const c = client;
  client = null;
  connecting = null;
  if (c) {
    try {
      await c.close();
    } catch {
      // Best-effort: the test process is tearing down regardless.
    }
  }
}
