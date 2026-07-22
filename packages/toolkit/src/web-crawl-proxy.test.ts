/**
 * Proxy fail-fast scenarios, documented in docs/ARCHITECTURE.md's "Crawl4AI
 * Config Contract" (the "Operator consequence" paragraph): the pinned
 * Crawl4AI image rejects `browser_config.proxy_config` with a 400
 * regardless of envelope, so both `web_fetch` and `web_crawl` must fail
 * fast with an actionable error instead of emitting that request.
 *
 * This scenario needs its own PROXY_SERVER/PROXY_USERNAME environment, and
 * `packages/toolkit/src/config.ts` parses the environment at import time —
 * so it lives in its own test file (`node --test` runs each file in its
 * own process) and sets the proxy env plus `CRAWL4AI_URL` before the
 * top-level `await import('./functions.js')`.
 */
import assert from 'node:assert/strict';
import { createServer as createHttpServer } from 'node:http';
import { after, describe, test } from 'node:test';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';

interface CapturedCall {
  name: string;
  arguments: Record<string, unknown>;
}

async function startCaptureServer(): Promise<{
  url: string;
  calls: CapturedCall[];
  close: () => Promise<void>;
}> {
  const calls: CapturedCall[] = [];
  const mcp = new Server(
    { name: 'capture', version: '1.0.0' },
    { capabilities: { tools: {} } },
  );
  mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [] }));
  mcp.setRequestHandler(CallToolRequestSchema, async req => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    calls.push({ name: req.params.name, arguments: args });
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            results: [
              {
                success: true,
                markdown: {
                  raw_markdown: 'captured',
                  fit_markdown: 'captured',
                },
              },
            ],
          }),
        },
      ],
    };
  });

  let transport: SSEServerTransport | undefined;
  const httpServer = createHttpServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method === 'GET' && url.pathname === '/mcp/sse') {
      transport = new SSEServerTransport('/mcp/messages', res);
      void mcp.connect(transport);
      return;
    }
    if (req.method === 'POST' && url.pathname === '/mcp/messages') {
      if (!transport) {
        res.writeHead(500).end('no transport');
        return;
      }
      void transport.handlePostMessage(req, res);
      return;
    }
    res.writeHead(404).end();
  });

  await new Promise<void>(resolve =>
    httpServer.listen(0, '127.0.0.1', resolve),
  );
  const address = httpServer.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: async () => {
      await mcp.close();
      await new Promise<void>(resolve => httpServer.close(() => resolve()));
    },
  };
}

const capture = await startCaptureServer();
process.env.CRAWL4AI_URL = capture.url;
process.env.PROXY_SERVER = 'http://proxy.example:8080';
process.env.PROXY_USERNAME = 'proxy-user';

const { web_crawl, web_fetch } = await import('./functions.js');
const { closeCrawl4AIClient } = await import('./crawl4ai.js');

after(async () => {
  await closeCrawl4AIClient();
  await capture.close();
});

describe('A configured proxy fails fast instead of being sent or silently dropped', () => {
  test('web_fetch path: proxy_config fails fast with an actionable error naming the field', async () => {
    const before = capture.calls.length;
    const result = await web_fetch({ url: 'https://example.com' });

    assert.equal(result.isError, true);
    const text = result.content?.[0]?.text ?? '';
    assert.match(text, /proxy_config/);
    assert.match(text, /per-request proxy configuration/i);
    assert.equal(
      capture.calls.length,
      before,
      'no crawl invocation must reach the MCP server',
    );
  });

  test('web_crawl path: proxy_config fails fast even though the caller supplied no browser_config', async () => {
    const before = capture.calls.length;
    const result = await web_crawl({ urls: ['https://example.com'] });

    assert.equal(result.isError, true);
    const text = result.content?.[0]?.text ?? '';
    assert.match(text, /proxy_config/);
    assert.equal(
      capture.calls.length,
      before,
      'no crawl invocation must reach the MCP server',
    );
  });

  // ── Gaps filled by QA beyond the spec's 1:1 scenario list ────────────

  test('a caller-supplied browser_config does not smuggle the default proxy past the check', async () => {
    // The pre-change code only injected the proxy when the caller had not
    // set one (`needProxy = Config.proxy && !bcParams.proxy_config`). The
    // reworked merge applies the defaults first, so a caller browser_config
    // that does not mention the proxy must still fail fast rather than
    // silently sending the datacenter IP.
    const before = capture.calls.length;
    const result = await web_crawl({
      urls: ['https://example.com'],
      browser_config: { viewport_width: 1920 },
    });
    assert.equal(result.isError, true);
    assert.match(result.content?.[0]?.text ?? '', /proxy_config/);
    assert.equal(capture.calls.length, before);
  });

  test('a caller-supplied proxy_config is rejected by name, not silently dropped', async () => {
    const before = capture.calls.length;
    const result = await web_crawl({
      urls: ['https://example.com'],
      browser_config: {
        proxy_config: { server: 'http://other.example:3128' },
      },
    });
    assert.equal(result.isError, true);
    assert.match(result.content?.[0]?.text ?? '', /proxy_config/);
    assert.match(result.content?.[0]?.text ?? '', /per-request proxy/i);
    assert.equal(capture.calls.length, before);
  });

  test('the proxy credentials never appear in the error handed back to the caller', async () => {
    const result = await web_crawl({ urls: ['https://example.com'] });
    const text = result.content?.[0]?.text ?? '';
    assert.ok(!text.includes('proxy-user'), 'must not leak the proxy username');
    assert.ok(
      !text.includes('proxy.example'),
      'must not leak the proxy server',
    );
  });

  test('a non-crawl tool is also fail-fast free of the proxy default', async () => {
    // web_screenshot builds no browser_config, so a configured proxy must
    // not make it fail — the proxy default only exists on the two entry
    // points that build one.
    const before = capture.calls.length;
    const { web_screenshot } = await import('./functions.js');
    const result = await web_screenshot({ url: 'https://example.com' });
    assert.notEqual(result.isError, true);
    assert.equal(capture.calls.length, before + 1);
    assert.ok(!('browser_config' in capture.calls[before]!.arguments));
  });
});
