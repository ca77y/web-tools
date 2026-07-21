import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { Config } from './config.js';
import type { DependencyProbeResult } from './readiness.js';

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
 * Cheap Crawl4AI MCP reachability probe for `GET /ready`. Reuses the
 * shared memoised client (`getClient()`) rather than opening a second
 * connection, and issues a `tools/list` protocol call bounded by
 * `timeoutMs`.
 *
 * Discriminating "timeout" from "rejection" is exact, not a judgement
 * call: an MCP request timeout also surfaces as a rejection (a request
 * that exceeds its timeout rejects with an `McpError` whose code is
 * `ErrorCode.RequestTimeout`), so classifying purely on "it rejected"
 * would be wrong. `timeout` fires only for that specific `McpError` code
 * (or when readiness.ts's own outer race bound wins the race instead —
 * see readiness.ts). Every other rejection is either a `network_error`
 * (not an `McpError`, so the failure happened before/outside the MCP
 * protocol — a failed `getClient()` connect or a transport-level error) or
 * a `protocol_error` (an `McpError` with some other code, meaning the
 * connection succeeded and the server itself returned a protocol-level
 * error).
 *
 * Only a non-timeout failure resets the shared `client`/`connecting`
 * state, mirroring `call()`'s existing catch but deliberately wider:
 * `call()` leaves `await getClient()` outside its own try, so a
 * connect-level rejection there isn't reset by `call()` and instead relies
 * on `transport.onerror`/`onclose`. `probeCrawl4AI` wraps both the connect
 * and the `tools/list` call, so it resets on a connect-level rejection
 * too. A timeout resets nothing: a connect that is still pending is left
 * to settle on its own (`transport.onerror`/`onclose` already clear it on
 * a real transport failure), since clearing shared state under a hung
 * connect would abandon an in-flight SSE connection on every probe
 * interval.
 */
export async function probeCrawl4AI(
  timeoutMs: number,
): Promise<DependencyProbeResult> {
  const start = performance.now();
  try {
    const c = await getClient();
    await c.listTools(undefined, { timeout: timeoutMs });
    return {
      status: 'ok',
      latency_ms: Math.max(0, Math.round(performance.now() - start)),
    };
  } catch (err) {
    const latency_ms = Math.max(0, Math.round(performance.now() - start));

    if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
      return { status: 'unhealthy', latency_ms, detail: 'timeout' };
    }

    client = null;
    connecting = null;
    return {
      status: 'unhealthy',
      latency_ms,
      detail: err instanceof McpError ? 'protocol_error' : 'network_error',
    };
  }
}
