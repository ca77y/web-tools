import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { Config } from './config.js';
import type { DependencyProbeResult } from './readiness.js';

let client: Client | null = null;
let connecting: Promise<Client> | null = null;
// Reference to the transport the in-flight or most recent `getClient()`
// attempt constructed. Exists solely so `resetClient()` (below) can close
// it; see the amendment in the spec for why this is necessary.
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
      eventSourceInit: { fetch: (url, init) => fetch(url, { ...init, headers: { ...headers, ...(init?.headers as Record<string, string>) } }) },
      requestInit: { headers },
    });
    activeTransport = transport;

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

/**
 * Best-effort closes the transport the in-flight or most recent
 * `getClient()` attempt constructed, then clears the shared `client` /
 * `connecting` / `activeTransport` state.
 *
 * Authorized by the spec's post-integration-review amendment: closing the
 * transport aborts its underlying EventSource, which (a) cancels any
 * reconnect timer `eventsource` has scheduled after a refused connection —
 * without this, that timer retries roughly every 3s *forever*, orphaned
 * once `client`/`connecting` are nulled, since `SSEClientTransport`'s own
 * error path never calls `close()` — and (b) aborts the in-flight fetch of
 * a connect that is still pending against a hung upstream, so a probe
 * timeout can no longer leave `connecting` wedged for every later caller
 * of `call()`.
 *
 * Swallows a close error: this function's job is to guarantee the shared
 * state ends up clear, not to report how the close went.
 */
async function resetClient(): Promise<void> {
  const abandoned = connecting;
  const transport = activeTransport;

  client = null;
  connecting = null;
  activeTransport = null;

  // The connect this function is abandoning may still settle later (it is
  // not necessarily aborted by the close below). Once `connecting` is
  // nulled here, nothing else is awaiting that promise, so attach a no-op
  // handler now — otherwise a late rejection would surface as an
  // unhandled promise rejection.
  abandoned?.catch(() => {});

  if (transport) {
    try {
      await transport.close();
    } catch {
      // Ignore: the transport may already be closing or closed.
    }
  }
}

async function call(name: string, args: Record<string, unknown>) {
  const c = await getClient();
  try {
    return await c.callTool({ name, arguments: args });
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
 */
export async function probeCrawl4AI(
  timeoutMs: number,
): Promise<DependencyProbeResult> {
  const start = performance.now();
  const latencyMs = () => Math.max(0, Math.round(performance.now() - start));

  let c: Client;
  try {
    c = await withConnectTimeout(getClient(), timeoutMs);
  } catch (err) {
    const detail =
      err instanceof McpError && err.code === ErrorCode.RequestTimeout
        ? 'timeout'
        : err instanceof McpError
          ? 'protocol_error'
          : 'network_error';

    await resetClient();

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
    // no longer live — reset, same as a connect-step failure.
    await resetClient();

    return {
      status: 'unhealthy',
      latency_ms: latencyMs(),
      detail: 'network_error',
    };
  }
}
