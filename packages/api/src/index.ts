import { createHash, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { Express, Request, Response } from 'express';
import { Config, checkReadiness, getStats, tools } from '@web-tools/toolkit';
import { createServer } from './mcp.js';
import { toolHandler } from './handler.js';

// Constant-time API key check. Hash both sides to fixed-length digests so the
// compare never leaks length and timingSafeEqual can't throw on mismatch.
const keyMatches = (provided: string | undefined, expected: string): boolean => {
  if (!provided) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
};

const log = (...args: unknown[]) => {
  process.stderr.write(
    args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n',
  );
};

log('Environment check:', { searxngUrl: Config.searxng.url });

export const app: Express = express();
app.use(express.json());

// ── Auth middleware (skips /health) ──────────────────────────────────

app.use((req: Request, res: Response, next) => {
  if (req.path === '/health') return next();

  const provided =
    req.headers.authorization?.replace(/^Bearer\s+/i, '') ||
    (req.query.api_key as string);

  if (!keyMatches(provided, Config.apiKey)) {
    res.status(403).json({
      error: 'forbidden',
      error_description: 'Invalid or missing API key',
    });
    return;
  }

  next();
});

// ── MCP endpoint ────────────────────────────────────────────────────

app.post('/mcp', async (req: Request, res: Response) => {
  const server = createServer();
  try {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);

    res.on('close', () => {
      log('Request closed');
      transport.close();
      server.close();
    });
  } catch (error) {
    log('Error handling MCP request:', error);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: null,
      });
    }
  }
});

app.get('/mcp', async (_req: Request, res: Response) => {
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    }),
  );
});

app.delete('/mcp', async (_req: Request, res: Response) => {
  res.writeHead(405).end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: 'Method not allowed.' },
      id: null,
    }),
  );
});

// ── REST API v0 ─────────────────────────────────────────────────────

app.get('/api/v0', (_req: Request, res: Response) => {
  res.json({
    tools: tools.map((t) => ({
      name: t.name,
      description: t.description,
    })),
  });
});

for (const tool of tools) {
  app.post(`/api/v0/${tool.name}`, toolHandler(tool.name));
}

// ── Health ───────────────────────────────────────────────────────────
// GET /health is Railway's platform health check path for the `Tools`
// service (project `Agentic-Search`, environment `production`) — both its
// deploy gate and its ongoing container check. It MUST stay a pure,
// dependency-free liveness probe: no network I/O, and always HTTP 200
// while the process is alive, including when every upstream is
// unreachable. Making this deep would restart-loop healthy containers and
// block deploys during an upstream outage. Dependency state belongs to
// the authenticated GET /ready below instead — do not add dependency
// checks or new body fields here.

app.get('/health', (_req: Request, res: Response) => {
  res.json({ status: 'ok' });
});

// ── Readiness ────────────────────────────────────────────────────────
// GET /ready is the authenticated dependency probe (SearXNG, Crawl4AI).
// It always answers HTTP 200 — callers read dependency state from the
// body, never the status code — and must never be configured as a
// platform health check path; see the comment on GET /health above.
app.get('/ready', async (_req: Request, res: Response) => {
  const report = await checkReadiness();
  res.status(200).json(report);
});

// ── Stats / cost monitoring ─────────────────────────────────────────
// Process-local counters. In-memory; resets on container restart
// (started_at reveals the reset). Same shape as the web_usage_stats
// MCP tool — a plain GET so dashboards / cron can poll cheaply.
app.get('/stats', (_req: Request, res: Response) => {
  res.json(getStats());
});

// ── Start ────────────────────────────────────────────────────────────

const PORT = parseInt(process.env.PORT || '3000', 10);
export const server = app.listen(PORT, () => {
  log(`Web Tools server listening on port ${PORT}`);
  log(`  MCP:    POST /mcp`);
  log(`  API:    POST /api/v0/{tool_name}`);
  log(`  Health: GET  /health`);
});

process.on('SIGINT', async () => {
  log('Shutting down server...');
  process.exit(0);
});
