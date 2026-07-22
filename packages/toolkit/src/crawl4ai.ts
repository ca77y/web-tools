import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport, SseError } from '@modelcontextprotocol/sdk/client/sse.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';

import { Config } from './config.js';
import {
  getRequestId,
  logEvent,
  logOperation,
  startTimer,
  summarizeArgShape,
} from './logging.js';
import type { DependencyProbeResult } from './readiness.js';

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
// Reference to the transport the in-flight or most recent `getClient()`
// attempt constructed. Doubles as the ownership token `resetClient()`
// (below) checks against: whichever caller captured this exact reference
// when its connect attempt started is the only caller allowed to close and
// null it. See the spec's second amendment ("transport ownership") for why
// this is necessary — without it, a caller holding a stale reference could
// close and null a transport a newer connect attempt already replaced.
let activeTransport: SSEClientTransport | null = null;

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
      eventSourceInit: {
        fetch: (url, init) =>
          fetch(url, {
            ...init,
            headers: {
              ...headers,
              ...(init?.headers as Record<string, string>),
            },
          }),
      },
      requestInit: { headers },
    });
    activeTransport = transport;

    const c = new Client({
      name: 'web_tools_crawl4ai_proxy',
      version: '1.0.0',
    });

    // Routed through the same ownership-guarded `resetClient()` used by
    // `probeCrawl4AI`'s failure branches (see the spec's second amendment).
    // Passing this closure's own `transport` — not the module-global — is
    // what makes this safe to leave wired unconditionally: a stale
    // handler from a transport a newer connect attempt already replaced
    // becomes a no-op instead of closing/nulling the replacement, and an
    // established connection that drops (a Crawl4AI restart or crash)
    // gets its transport actually closed via this path, not merely
    // dereferenced. This guarantee is scoped to callers that go through
    // `resetClient()`: `call()`'s own catch below still nulls `client`/
    // `connecting` directly without clearing `activeTransport`, which can
    // still orphan a transport and its reconnect timer on that path —
    // tracked as a known gap owned by the sibling
    // `normalize-crawl4ai-config-payloads` story, not this one.
    //
    // `onerror` is deliberately gated on `err instanceof SseError`. The SDK
    // funnels several unrelated failure shapes through this same callback,
    // and only one of them means the shared stream itself is unusable:
    //
    // - The underlying EventSource erroring — a refused/reset connect, or
    //   an established stream dropping — always constructs an `SseError`
    //   before calling this handler, and is the *only* path that ever
    //   schedules `eventsource`'s internal reconnect timer. This is the
    //   one case the gate lets through, and it is what fixes hazard 1 (the
    //   orphaned reconnect-forever loop the spec's amendments describe).
    // - `send()` (used by every individual tool request, e.g.
    //   `web_crawl`) calls this same handler with a plain `Error` on a
    //   failed or non-2xx POST. This is one request's failure on an
    //   otherwise-live connection; resetting for it would abort every
    //   other concurrent tool call riding this transport — exactly the
    //   blast radius `probeCrawl4AI`'s own `tools/list` branch below is
    //   careful to avoid. The gate excludes it.
    // - The endpoint-URL parse failure during connect and a rejected
    //   `_authThenStart` (unreachable here — no `authProvider` is
    //   configured) also pass a plain `Error`. Both are connect-time-only
    //   and self-compensate: the endpoint-parse path calls `this.close()`
    //   itself right after, which reaches `resetClient()` via `onclose`
    //   below regardless of this gate.
    // - A malformed SSE message that fails `JSONRPCMessageSchema` parsing
    //   in `onmessage` also passes a plain `Error` here and is excluded by
    //   the gate. Unlike the pre-story baseline (which nulled `client`/
    //   `connecting` unconditionally on any `onerror`), a bad frame no
    //   longer resets shared state: the connection itself is presumed
    //   still live — the same "don't tear down a shared connection over
    //   one bad exchange" reasoning as `send()`'s case above — and the
    //   in-flight request it broke recovers on its own timeout bound
    //   (`timeoutMs` for `probeCrawl4AI`; the SDK's default for `call()`).
    transport.onerror = err => {
      logEvent('crawl4ai_transport_error', { message: err.message }, 'error');
      if (err instanceof SseError) {
        void resetClient(transport);
      }
    };

    transport.onclose = () => {
      void resetClient(transport);
    };

    await c.connect(transport);
    client = c;
    connecting = null;
    return c;
  })();

  return connecting;
}

/**
 * Best-effort closes `transport` and clears the shared `client` /
 * `connecting` / `activeTransport` state — but only if `transport` is
 * still the module's *current* transport (`transport === activeTransport`).
 * A stale `transport` (one a newer connect attempt has already superseded)
 * makes this a no-op: the caller holding it is not the transport's owner
 * any more and must not touch state that now belongs to a different,
 * possibly healthy, connection.
 *
 * This ownership check is what the spec's second amendment ("transport
 * ownership") requires: every caller — `probeCrawl4AI`'s failure branches
 * and the `transport.onerror` / `onclose` handlers set up in `getClient()`
 * — passes the exact transport reference it captured when *its* connect
 * attempt started, never the module-global directly. Without it, a
 * straggler probe abandoned by `readiness.ts`'s outer deadline could
 * return later and close a newer round's healthy transport out from under
 * it, or a late `onerror`/`onclose` from a superseded transport could null
 * shared state belonging to its replacement.
 *
 * Authorized by the spec's post-integration-review amendment: closing the
 * transport aborts its underlying EventSource, which (a) cancels any
 * reconnect timer `eventsource` has scheduled after a refused connection or
 * a dropped established connection — without this, that timer retries
 * roughly every 3s *forever*, orphaned once `client`/`connecting` are
 * nulled, since `SSEClientTransport`'s own error path never calls
 * `close()` — and (b) aborts the in-flight fetch of a connect that is
 * still pending against a hung upstream, so a probe timeout can no longer
 * leave `connecting` wedged for every later caller of `call()`.
 *
 * Swallows a close error: this function's job is to guarantee the shared
 * state ends up clear, not to report how the close went.
 */
async function resetClient(transport: SSEClientTransport | null): Promise<void> {
  if (!transport || transport !== activeTransport) return;

  const abandoned = connecting;

  client = null;
  connecting = null;
  activeTransport = null;

  // The connect this function is abandoning may still settle later (it is
  // not necessarily aborted by the close below). Once `connecting` is
  // nulled here, nothing else is awaiting that promise, so attach a no-op
  // handler now — otherwise a late rejection would surface as an
  // unhandled promise rejection.
  abandoned?.catch(() => {});

  try {
    await transport.close();
  } catch {
    // Ignore: the transport may already be closing or closed.
  }
}

async function call(name: string, args: Record<string, unknown>) {
  const requestId = getRequestId();
  const operation = `crawl4ai.${name}`;

  // Emitted before normalizeCrawl4AIArgs (which itself can reject a
  // forbidden field) and before getClient()/callTool are attempted: the
  // upstream MCP-to-REST bridge can reject a request with no correlatable
  // detail of its own (see
  // docs/issues/crawl4ai-400-burst-root-cause-unrecoverable.md), so our own
  // record of what was attempted must already exist by the time that
  // happens — and the same is true of a request our own normalization
  // rejects before it is ever sent. Logs the caller-supplied args' shape,
  // not the normalized one: summarizeArgShape only reports top-level type
  // tokens (`object`, `array[n]`, ...), which is identical whether
  // browser_config/crawler_config are flat or normalizeCrawl4AIArgs's
  // wrapped { type, params } form, so logging before normalization loses
  // no information.
  logEvent('crawl4ai_request_shape', {
    requestId,
    operation,
    argShape: summarizeArgShape(args),
  });

  // Deliberately outside the try/catch below: a rejection here (a
  // forbidden field — see assertNoForbiddenFields) is a local validation
  // failure, not a dispatch failure, so it must not reset the shared
  // client/connecting state or be misreported as a 'crawl4ai_dispatch'
  // outcome. It propagates directly to the caller, where functions.ts's
  // proxyCrawl4AI catches it and turns it into an isError result naming
  // the field, before any request is sent.
  const normalizedArgs = normalizeCrawl4AIArgs(args);

  // A second record after the call carries the outcome and duration at
  // this dispatch layer — distinct from (and emitted for every
  // Crawl4AI-backed call, unlike) functions.ts's proxyCrawl4AI, which adds
  // target-URL context but only wraps five of the six Crawl4AI-backed
  // tools. web_archive reaches Crawl4AI through this function directly
  // (getArchivedPage -> callMdTool), never through proxyCrawl4AI, so this
  // is the only place its Crawl4AI call gets any outcome/duration
  // attribution at all.
  const elapsed = startTimer();
  try {
    const c = await getClient();
    const result = await c.callTool({ name, arguments: normalizedArgs });
    logOperation('crawl4ai_dispatch', {
      operation,
      requestId,
      outcome: (result as { isError?: unknown })?.isError ? 'error' : 'ok',
      durationMs: elapsed(),
    });
    return result;
  } catch (err) {
    logOperation('crawl4ai_dispatch', {
      operation,
      requestId,
      outcome: 'error',
      durationMs: elapsed(),
      cause: err instanceof Error ? err.message : String(err),
    });
    client = null;
    connecting = null;
    throw err;
  }
}

export const callCrawlTool = (args: Record<string, unknown>) =>
  call('crawl', args);
export const callMdTool = (args: Record<string, unknown>) => call('md', args);
export const callScreenshotTool = (args: Record<string, unknown>) =>
  call('screenshot', args);
export const callPdfTool = (args: Record<string, unknown>) => call('pdf', args);
export const callExecuteJsTool = (args: Record<string, unknown>) =>
  call('execute_js', args);

/**
 * Races `getClient()`'s connect step against `timeoutMs`. Unlike the
 * `tools/list` call below, which the MCP SDK itself bounds via its own
 * `timeout` option, a connect has no timeout of its own —
 * `SSEClientTransport.start()` waits indefinitely for the server's
 * `endpoint` SSE event, so a peer that accepts the TCP connection and then
 * never responds (the card's manual step 5) would otherwise hang this
 * probe, and therefore `getClient()`'s shared `connecting` promise,
 * forever. Rejects with the same `McpError`/`RequestTimeout` shape a
 * `tools/list` timeout produces, so the classification below handles both
 * uniformly. The raced-away `connecting` promise is left to the caller to
 * abandon safely (see `resetClient()`).
 */
function withConnectTimeout(
  pending: Promise<Client>,
  timeoutMs: number,
): Promise<Client> {
  return new Promise<Client>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new McpError(ErrorCode.RequestTimeout, 'crawl4ai connect timed out'));
    }, timeoutMs);
    pending.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      err => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Cheap Crawl4AI MCP reachability probe for `GET /ready`. Reuses the
 * shared memoised client (`getClient()`) rather than opening a second
 * connection, bounds the connect step with `withConnectTimeout` (above),
 * and issues a `tools/list` protocol call bounded by `timeoutMs`.
 *
 * Discriminating "timeout" from "rejection" is exact, not a judgement
 * call: an MCP request timeout also surfaces as a rejection (a request
 * that exceeds its timeout rejects with an `McpError` whose code is
 * `ErrorCode.RequestTimeout`), so classifying purely on "it rejected"
 * would be wrong. `timeout` fires only for that specific `McpError` code
 * (or when readiness.ts's own outer race bound wins the race instead —
 * see readiness.ts). Every other rejection is either a `network_error`
 * (not an `McpError`, so the failure happened before/outside the MCP
 * protocol) or a `protocol_error` (an `McpError` with some other code,
 * meaning the connection succeeded and the server itself returned a
 * protocol-level error).
 *
 * The connect step and the `tools/list` request are handled in two
 * separate `try`/`catch` blocks — deliberately, not merged — because
 * `resetClient()` must only run for a failure that happened *while
 * connecting*:
 *
 * - **Connect-step failure or timeout** (the first `catch` below): the
 *   transport this attempt built, if any, never finished connecting, so
 *   nothing else can be relying on it. Per the spec's post-integration-
 *   review amendment, this always calls `resetClient()` to close what the
 *   attempt abandoned — including on a connect-level timeout, which
 *   supersedes an earlier design where a timeout reset nothing (that
 *   design predates `resetClient()`, when the probe had no way to close
 *   what it abandoned). Left unclosed, a refused connection's transport
 *   keeps `eventsource` retrying roughly every 3s forever, and a hung
 *   connect's transport keeps `connecting` — and therefore every
 *   `call()`-based tool — wedged indefinitely, even after the upstream
 *   recovers.
 * - **`tools/list` failure** (the second `catch` below): the connect
 *   already succeeded, so `c` is a *live* memoised client that `call()`
 *   and any concurrent tool invocation may also be using right now. A
 *   slow or protocol-error answer to this one probe request does not mean
 *   the connection itself is unusable — tearing it down here would let
 *   `/ready` kill unrelated in-flight `web_crawl` / `web_screenshot` /
 *   `web_pdf` / `web_execute_js` calls merely because a single probe was
 *   slow, which is the opposite of what a readiness check should do. So
 *   this only resets when the rejection isn't an `McpError` at all —
 *   meaning the failure happened below the MCP protocol layer, i.e. the
 *   transport itself broke mid-request and is genuinely no longer live.
 *   An `McpError` (`timeout` or `protocol_error`) leaves shared state
 *   untouched, matching the pre-amendment behaviour for this step, which
 *   the amendment never revisited (both of its hazards are about the
 *   connect step).
 *
 * `myTransport` is this call's ownership token: `activeTransport` captured
 * synchronously right after `getClient()` is invoked, i.e. before this
 * call ever awaits anything, so it names the exact transport this attempt
 * started or joined — never whatever `activeTransport` happens to hold
 * later. Both `resetClient()` calls below pass this captured value rather
 * than letting `resetClient()` read the module-global itself, so a probe
 * that was abandoned by `readiness.ts`'s own outer deadline and only fails
 * later cannot reset a newer round's transport out from under it (see the
 * spec's second amendment, "transport ownership").
 */
export async function probeCrawl4AI(
  timeoutMs: number,
): Promise<DependencyProbeResult> {
  const start = performance.now();
  const latencyMs = () => Math.max(0, Math.round(performance.now() - start));

  let c: Client;
  const pending = getClient();
  const myTransport = activeTransport;
  try {
    c = await withConnectTimeout(pending, timeoutMs);
  } catch (err) {
    const detail =
      err instanceof McpError && err.code === ErrorCode.RequestTimeout
        ? 'timeout'
        : err instanceof McpError
          ? 'protocol_error'
          : 'network_error';

    await resetClient(myTransport);

    return { status: 'unhealthy', latency_ms: latencyMs(), detail };
  }

  try {
    await c.listTools(undefined, { timeout: timeoutMs });
    return { status: 'ok', latency_ms: latencyMs() };
  } catch (err) {
    if (err instanceof McpError) {
      const detail =
        err.code === ErrorCode.RequestTimeout ? 'timeout' : 'protocol_error';
      return { status: 'unhealthy', latency_ms: latencyMs(), detail };
    }

    // Not an McpError: the transport itself broke mid-request, so it is
    // no longer live — reset (if this is still the current transport),
    // same as a connect-step failure.
    await resetClient(myTransport);

    return {
      status: 'unhealthy',
      latency_ms: latencyMs(),
      detail: 'network_error',
    };
  }
}

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
