/**
 * Requirement: "The CLI's flag mapping keeps working end to end" — drives
 * the real `registerCrawlCommand` (commands/crawl.ts, unchanged by this
 * unit) against an in-process MCP capture server, proving the CLI's
 * existing flag-to-config mapping still reaches Crawl4AI in the
 * upstream-accepted canonical envelope after `web_crawl`'s config handling
 * was reworked. No CLI production source is modified for this test.
 *
 * `packages/toolkit/src/config.ts` parses the environment at import time,
 * so `CRAWL4AI_URL` is set and the capture server is listening *before*
 * `./commands/crawl.js` (which transitively imports the toolkit) is
 * loaded, via a top-level `await import(...)`. The `crawl` action calls
 * `process.exit(1)` and writes to `console` on its error branch, so both
 * are stubbed for the duration of each parse and restored afterward.
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
import { Command } from 'commander';

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

const { registerCrawlCommand } = await import('./commands/crawl.js');
const { closeCrawl4AIClient } = await import('@web-tools/toolkit');

after(async () => {
  // Close the client connection first — an open SSE connection would
  // otherwise keep this test file's process alive indefinitely (or hang
  // capture.close() waiting on it). See crawl4ai.ts for why this export
  // exists.
  await closeCrawl4AIClient();
  await capture.close();
});

/** Builds a root Command the way packages/cli/src/index.ts wires the crawl subcommand. */
function buildProgram(): Command {
  const program = new Command();
  program
    .name('web-tools')
    .description('CLI for web search, scraping, and archival tools')
    .version('0.1.0')
    .option('--json', 'Output raw JSON (default: pretty-printed)');
  // See packages/cli/src/search.test.ts for why exitOverride() must be set
  // before registering the subcommand.
  program.exitOverride();
  registerCrawlCommand(program);
  return program;
}

/** Runs the CLI action, stubbing process.exit and console for the duration. */
async function runCli(
  args: string[],
): Promise<{ exitCodes: number[]; stdout: string[]; stderr: string[] }> {
  const exitCodes: number[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;

  process.exit = ((code?: number) => {
    exitCodes.push(code ?? 0);
    return undefined as never;
  }) as typeof process.exit;
  console.log = (...a: unknown[]) => {
    stdout.push(a.map(String).join(' '));
  };
  console.error = (...a: unknown[]) => {
    stderr.push(a.map(String).join(' '));
  };

  try {
    const program = buildProgram();
    await program.parseAsync(args, { from: 'user' });
  } finally {
    process.exit = originalExit;
    console.log = originalLog;
    console.error = originalError;
  }

  return { exitCodes, stdout, stderr };
}

describe("The CLI's flag mapping keeps working end to end", () => {
  test('--screenshot reaches Crawl4AI in the accepted canonical form', async () => {
    const { exitCodes } = await runCli([
      'crawl',
      '--screenshot',
      'https://example.com',
    ]);
    assert.deepEqual(exitCodes, [], 'the crawl must not exit non-zero');

    const last = capture.calls[capture.calls.length - 1]!;
    assert.deepEqual(last.arguments.crawler_config, {
      type: 'CrawlerRunConfig',
      params: { screenshot: true },
    });
  });

  test('--selector and --timeout reach Crawl4AI in the accepted canonical form', async () => {
    const { exitCodes } = await runCli([
      'crawl',
      '--selector',
      'main',
      '--timeout',
      '30000',
      'https://example.com',
    ]);
    assert.deepEqual(exitCodes, [], 'the crawl must not exit non-zero');

    const last = capture.calls[capture.calls.length - 1]!;
    assert.deepEqual(last.arguments.crawler_config, {
      type: 'CrawlerRunConfig',
      params: { css_selector: 'main', page_timeout: 30000 },
    });
  });

  // ── Gaps filled by QA beyond the spec's 1:1 scenario list ────────────

  test('--pdf and --wait-for reach Crawl4AI in the accepted canonical form', async () => {
    const { exitCodes } = await runCli([
      'crawl',
      '--pdf',
      '--wait-for',
      '#done',
      'https://example.com',
    ]);
    assert.deepEqual(exitCodes, [], 'the crawl must not exit non-zero');

    const last = capture.calls[capture.calls.length - 1]!;
    assert.deepEqual(last.arguments.crawler_config, {
      type: 'CrawlerRunConfig',
      params: { pdf: true, wait_for: '#done' },
    });
  });

  test('a flagless crawl sends no crawler_config and the stealth browser_config default', async () => {
    const { exitCodes } = await runCli(['crawl', 'https://example.com']);
    assert.deepEqual(exitCodes, [], 'the crawl must not exit non-zero');

    const last = capture.calls[capture.calls.length - 1]!;
    assert.ok(
      !('crawler_config' in last.arguments),
      'the CLI omits crawler_config entirely when no flag sets one',
    );
    assert.deepEqual(last.arguments.browser_config, {
      type: 'BrowserConfig',
      params: { headless: true, enable_stealth: true },
    });
  });

  test('multiple URLs are forwarded as given', async () => {
    await runCli(['crawl', 'https://a.example', 'https://b.example']);
    const last = capture.calls[capture.calls.length - 1]!;
    assert.deepEqual(last.arguments.urls, [
      'https://a.example',
      'https://b.example',
    ]);
  });
});

describe('--magic fails loudly instead of returning a 400 as page content', () => {
  // Deviation 2 in docs/specs/normalize-crawl4ai-config-payloads.md: `magic`
  // is on the pinned image's CrawlerRunConfig forbidden list (probe F), so
  // `--magic` fails today and still fails after this change — but the
  // failure must now be an explicit non-zero exit naming the field instead
  // of an apparent success carrying `{"error": 400, ...}` as content. The
  // flag-to-config mapping itself is deliberately unchanged.
  test('--magic exits 1, names the field on stderr, and sends no request', async () => {
    const before = capture.calls.length;
    const { exitCodes, stderr } = await runCli([
      'crawl',
      '--magic',
      'https://example.com',
    ]);

    // Note: stdout is deliberately not asserted here. The stubbed
    // process.exit returns instead of terminating, so the action falls
    // through to its content loop — an artifact of the stub, not of the
    // shipped CLI, where process.exit(1) ends the process at that line.
    assert.deepEqual(exitCodes, [1], 'the crawl must exit non-zero');
    const text = stderr.join('\n');
    assert.match(text, /magic/, 'the error must name the offending field');
    assert.match(text, /untrusted request/i);
    assert.equal(
      capture.calls.length,
      before,
      'no crawl invocation must reach the MCP server',
    );
  });
});
