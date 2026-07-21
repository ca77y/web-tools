/**
 * End-to-end capture of the outgoing Crawl4AI MCP tool arguments, per the
 * unit's Validation section: an in-process MCP server is stood up over a
 * real SSE HTTP connection on an ephemeral port (the same transport
 * `packages/toolkit/src/crawl4ai.ts` speaks in production), `CRAWL4AI_URL`
 * is pointed at it, and the real `web_fetch` / `web_crawl` tool entry
 * points are driven against it. The low-level `Server` (not the
 * schema-validating `McpServer` tool() wrapper) is used on the capture
 * side so the captured `arguments` are exactly the raw wire payload — no
 * production test seam.
 *
 * `packages/toolkit/src/config.ts` parses the environment at import time,
 * so `CRAWL4AI_URL` is set and the capture server is listening *before*
 * `./functions.js` (which transitively imports `./config.js`) is loaded,
 * via a top-level `await import(...)`. This scenario needs no proxy env,
 * so it lives in this file; the proxy fail-fast scenarios need
 * PROXY_SERVER/PROXY_USERNAME and live in their own file
 * (web-crawl-proxy.test.ts) per "node --test runs each test file in its
 * own process."
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

const { web_crawl, web_execute_js, web_fetch, web_pdf, web_screenshot } =
  await import('./functions.js');
const { closeCrawl4AIClient } = await import('./crawl4ai.js');

after(async () => {
  // Close the client connection first — closing the capture server while
  // the client's SSE connection is still open would otherwise leave that
  // connection to auto-reconnect (or hang server.close() waiting on it),
  // keeping this test file's process alive indefinitely.
  await closeCrawl4AIClient();
  await capture.close();
});

describe('One canonical outgoing envelope regardless of caller envelope', () => {
  let flatCrawlerConfig: unknown;

  test('flat caller crawler_config is canonicalized', async () => {
    await web_crawl({
      urls: ['https://example.com'],
      crawler_config: { css_selector: 'main' },
    });
    const last = capture.calls[capture.calls.length - 1]!;
    flatCrawlerConfig = last.arguments.crawler_config;
    assert.deepEqual(flatCrawlerConfig, {
      type: 'CrawlerRunConfig',
      params: { css_selector: 'main' },
    });
  });

  test('wrapped caller crawler_config is passed through in canonical form, byte-identical to the flat call', async () => {
    await web_crawl({
      urls: ['https://example.com'],
      crawler_config: {
        type: 'CrawlerRunConfig',
        params: { css_selector: 'main' },
      },
    });
    const last = capture.calls[capture.calls.length - 1]!;
    assert.deepEqual(last.arguments.crawler_config, flatCrawlerConfig);
  });

  test('absent crawler_config is not invented', async () => {
    await web_crawl({ urls: ['https://example.com'] });
    const last = capture.calls[capture.calls.length - 1]!;
    assert.ok(!('crawler_config' in last.arguments));
  });
});

describe('web_fetch and web_crawl emit identical envelopes for equivalent input', () => {
  test('identical browser_config for default input (no proxy configured)', async () => {
    await web_fetch({ url: 'https://example.com' });
    const fetchCall = capture.calls[capture.calls.length - 1]!;

    await web_crawl({ urls: ['https://example.com'] });
    const crawlCall = capture.calls[capture.calls.length - 1]!;

    const expected = {
      type: 'BrowserConfig',
      params: { headless: true, enable_stealth: true },
    };
    assert.deepEqual(fetchCall.arguments.browser_config, expected);
    assert.deepEqual(crawlCall.arguments.browser_config, expected);
  });

  test('identical crawler_config for equivalent input', async () => {
    await web_fetch({ url: 'https://example.com' });
    const fetchCall = capture.calls[capture.calls.length - 1]!;

    await web_crawl({
      urls: ['https://example.com'],
      crawler_config: {
        wait_until: 'load',
        page_timeout: 120000,
        delay_before_return_html: 15,
      },
    });
    const crawlCall = capture.calls[capture.calls.length - 1]!;

    assert.deepEqual(
      fetchCall.arguments.crawler_config,
      crawlCall.arguments.crawler_config,
    );
  });
});

describe('No caller-supplied browser_config key is silently discarded', () => {
  let unwrappedBrowserConfig: unknown;

  test('unwrapped caller key is honored', async () => {
    await web_crawl({
      urls: ['https://example.com'],
      browser_config: { headless: false },
    });
    const last = capture.calls[capture.calls.length - 1]!;
    unwrappedBrowserConfig = last.arguments.browser_config;
    const params = last.arguments.browser_config as {
      params: Record<string, unknown>;
    };
    assert.equal(params.params.headless, false);
  });

  test('wrapped caller key is honored, byte-identical to the unwrapped call', async () => {
    await web_crawl({
      urls: ['https://example.com'],
      browser_config: { type: 'BrowserConfig', params: { headless: false } },
    });
    const last = capture.calls[capture.calls.length - 1]!;
    assert.deepEqual(last.arguments.browser_config, unwrappedBrowserConfig);
  });

  test('caller keys merge with defaults rather than replacing them', async () => {
    await web_crawl({
      urls: ['https://example.com'],
      browser_config: { viewport_width: 1920 },
    });
    const last = capture.calls[capture.calls.length - 1]!;
    const params = (
      last.arguments.browser_config as { params: Record<string, unknown> }
    ).params;
    assert.equal(params.viewport_width, 1920);
    assert.equal(params.headless, true);
    assert.equal(params.enable_stealth, true);
  });

  test('default stealth behavior is preserved when no browser_config is supplied and no proxy is configured', async () => {
    await web_crawl({ urls: ['https://example.com'] });
    const last = capture.calls[capture.calls.length - 1]!;
    assert.deepEqual(last.arguments.browser_config, {
      type: 'BrowserConfig',
      params: { headless: true, enable_stealth: true },
    });
  });
});

describe('No request carrying a field the pinned image forbids is sent', () => {
  test('a forbidden crawler field is rejected before the request is sent', async () => {
    const before = capture.calls.length;
    const result = await web_crawl({
      urls: ['https://example.com'],
      crawler_config: { magic: true },
    });
    assert.equal(result.isError, true);
    const text = result.content?.[0]?.text ?? '';
    assert.match(text, /magic/);
    assert.match(text, /untrusted request/i);
    assert.equal(
      capture.calls.length,
      before,
      'no crawl invocation must reach the MCP server',
    );
  });

  test('a forbidden browser field is rejected before the request is sent', async () => {
    const before = capture.calls.length;
    const result = await web_crawl({
      urls: ['https://example.com'],
      browser_config: { cdp_url: 'http://127.0.0.1:9222' },
    });
    assert.equal(result.isError, true);
    const text = result.content?.[0]?.text ?? '';
    assert.match(text, /cdp_url/);
    assert.equal(
      capture.calls.length,
      before,
      'no crawl invocation must reach the MCP server',
    );
  });

  test('an unknown but non-forbidden key is forwarded unchanged', async () => {
    await web_crawl({
      urls: ['https://example.com'],
      crawler_config: { css_selector: 'main', not_a_real_key: 1 },
    });
    const last = capture.calls[capture.calls.length - 1]!;
    assert.deepEqual(last.arguments.crawler_config, {
      type: 'CrawlerRunConfig',
      params: { css_selector: 'main', not_a_real_key: 1 },
    });
  });
});

describe('WebFetchInput no longer publishes session_id', () => {
  test('a session_id value passed to web_fetch is not emitted in the outgoing crawler_config', async () => {
    await web_fetch({ url: 'https://example.com', session_id: 'abc' });
    const last = capture.calls[capture.calls.length - 1]!;
    const params = (
      last.arguments.crawler_config as { params: Record<string, unknown> }
    ).params;
    assert.ok(!('session_id' in params));
  });
});

// ── Gaps filled by QA beyond the spec's 1:1 scenario list ───────────────

describe('the normalizer covers every tool routed through call(), not just crawl', () => {
  // The Design section states normalizeCrawl4AIArgs is applied inside the
  // shared `call(name, args)` "so crawl, md, screenshot, pdf, and
  // execute_js are all covered. The last three carry no config keys today,
  // so for them it is a pass-through." Both halves are asserted here: the
  // pass-through must not invent config keys, and a config key that *is*
  // present on one of those paths must still fail fast.
  test('web_screenshot forwards its args untouched and invents no config keys', async () => {
    await web_screenshot({
      url: 'https://example.com',
      screenshot_wait_for: 2,
    });
    const last = capture.calls[capture.calls.length - 1]!;
    assert.equal(last.name, 'screenshot');
    assert.deepEqual(last.arguments, {
      url: 'https://example.com',
      screenshot_wait_for: 2,
    });
  });

  test('web_pdf forwards its args untouched and invents no config keys', async () => {
    await web_pdf({ url: 'https://example.com' });
    const last = capture.calls[capture.calls.length - 1]!;
    assert.equal(last.name, 'pdf');
    assert.deepEqual(last.arguments, { url: 'https://example.com' });
  });

  test('web_execute_js forwards its args untouched and invents no config keys', async () => {
    await web_execute_js({
      url: 'https://example.com',
      scripts: ['return 1;'],
    });
    const last = capture.calls[capture.calls.length - 1]!;
    assert.equal(last.name, 'execute_js');
    assert.deepEqual(last.arguments, {
      url: 'https://example.com',
      scripts: ['return 1;'],
    });
  });

  test('a flat config on a non-crawl tool is canonicalized too', async () => {
    await web_screenshot({
      url: 'https://example.com',
      browser_config: { viewport_width: 1920 },
    });
    const last = capture.calls[capture.calls.length - 1]!;
    assert.deepEqual(last.arguments.browser_config, {
      type: 'BrowserConfig',
      params: { viewport_width: 1920 },
    });
  });

  test('a forbidden field on a non-crawl tool is rejected before the request is sent', async () => {
    const before = capture.calls.length;
    const result = await web_screenshot({
      url: 'https://example.com',
      browser_config: { cookies: [] },
    });
    assert.equal(result.isError, true);
    assert.match(result.content?.[0]?.text ?? '', /cookies/);
    assert.equal(capture.calls.length, before);
  });
});

describe('web_fetch config construction after the rework', () => {
  test('the outgoing call is the crawl tool with the requested url', async () => {
    await web_fetch({ url: 'https://example.com/page' });
    const last = capture.calls[capture.calls.length - 1]!;
    assert.equal(last.name, 'crawl');
    assert.deepEqual(last.arguments.urls, ['https://example.com/page']);
  });

  test('the default crawler_config is exactly the documented three fields', async () => {
    await web_fetch({ url: 'https://example.com' });
    const last = capture.calls[capture.calls.length - 1]!;
    assert.deepEqual(last.arguments.crawler_config, {
      type: 'CrawlerRunConfig',
      params: {
        wait_until: 'load',
        page_timeout: 120000,
        delay_before_return_html: 15,
      },
    });
  });

  test('a caller-supplied delay overrides delay_before_return_html', async () => {
    await web_fetch({ url: 'https://example.com', delay: 3 });
    const last = capture.calls[capture.calls.length - 1]!;
    const params = (
      last.arguments.crawler_config as { params: Record<string, unknown> }
    ).params;
    assert.equal(params.delay_before_return_html, 3);
  });

  test('a non-finite delay falls back to the 15s default', async () => {
    await web_fetch({ url: 'https://example.com', delay: Number.NaN });
    const last = capture.calls[capture.calls.length - 1]!;
    const params = (
      last.arguments.crawler_config as { params: Record<string, unknown> }
    ).params;
    assert.equal(params.delay_before_return_html, 15);
  });
});

describe('caller browser_config edge cases on the web_crawl path', () => {
  test('a caller may override a stealth default, and only that key changes', async () => {
    await web_crawl({
      urls: ['https://example.com'],
      browser_config: { enable_stealth: false },
    });
    const last = capture.calls[capture.calls.length - 1]!;
    assert.deepEqual(last.arguments.browser_config, {
      type: 'BrowserConfig',
      params: { headless: true, enable_stealth: false },
    });
  });

  test('a wrapped caller browser_config merges with the defaults rather than replacing them', async () => {
    await web_crawl({
      urls: ['https://example.com'],
      browser_config: {
        type: 'BrowserConfig',
        params: { viewport_width: 1920 },
      },
    });
    const last = capture.calls[capture.calls.length - 1]!;
    assert.deepEqual(last.arguments.browser_config, {
      type: 'BrowserConfig',
      params: { headless: true, enable_stealth: true, viewport_width: 1920 },
    });
  });

  test('a forbidden field inside a wrapped caller crawler_config is rejected end to end', async () => {
    const before = capture.calls.length;
    const result = await web_crawl({
      urls: ['https://example.com'],
      crawler_config: {
        type: 'CrawlerRunConfig',
        params: { js_code: 'alert(1)' },
      },
    });
    assert.equal(result.isError, true);
    assert.match(result.content?.[0]?.text ?? '', /js_code/);
    assert.equal(capture.calls.length, before);
  });

  test('other caller keys still reach the wire alongside the merged browser_config', async () => {
    await web_crawl({
      urls: ['https://a.example', 'https://b.example'],
      crawler_config: { css_selector: 'main' },
      browser_config: { viewport_width: 800 },
    });
    const last = capture.calls[capture.calls.length - 1]!;
    assert.deepEqual(last.arguments.urls, [
      'https://a.example',
      'https://b.example',
    ]);
    assert.deepEqual(last.arguments.crawler_config, {
      type: 'CrawlerRunConfig',
      params: { css_selector: 'main' },
    });
  });
});
