import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';

import { Config } from './config.js';
import { getRequestId, logEvent, summarizeArgShape } from './logging.js';

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

    const c = new Client({
      name: 'web_tools_crawl4ai_proxy',
      version: '1.0.0',
    });

    transport.onerror = err => {
      logEvent('crawl4ai_transport_error', { message: err.message }, 'error');
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
  // Emitted before getClient()/callTool are attempted: the upstream
  // MCP-to-REST bridge can reject a request with no correlatable detail of
  // its own (see docs/issues/crawl4ai-400-burst-root-cause-unrecoverable.md),
  // so our own record of what we sent must already exist by the time that
  // happens.
  logEvent('crawl4ai_request_shape', {
    requestId: getRequestId(),
    operation: `crawl4ai.${name}`,
    argShape: summarizeArgShape(args),
  });

  const c = await getClient();
  try {
    return await c.callTool({ name, arguments: args });
  } catch (err) {
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
