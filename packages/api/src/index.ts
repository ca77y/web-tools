import { createHash, timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import express, { Express, Request, Response } from 'express';
import {
  Config,
  checkReadiness,
  getStats,
  logEvent,
  tools,
} from '@web-tools/toolkit';
import type { ReadinessReport } from '@web-tools/toolkit';
import { createServer } from './mcp.js';
import { toolHandler } from './handler.js';
import { requestLogMiddleware } from './request-log.js';

// Constant-time API key check. Hash both sides to fixed-length digests so the
// compare never leaks length and timingSafeEqual can't throw on mismatch.
const keyMatches = (provided: string | undefined, expected: string): boolean => {
  if (!provided) return false;
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return timingSafeEqual(a, b);
};

logEvent('startup_check', { searxngUrl: Config.searxng.url });

// An unset API_KEY disables authentication entirely. That is intended for a
// local stack (no credentials to manage), and dangerous anywhere reachable,
// so it is announced loudly rather than passing silently.
if (!Config.apiKey) {
  logEvent('auth_disabled', {
    warning:
      'API_KEY is not set — every route except /health is served WITHOUT authentication. Set API_KEY for any non-local deployment.',
  });
}

export const app: Express = express();
app.use(requestLogMiddleware);
app.use(express.json());

// ── Auth middleware (skips /health) ──────────────────────────────────

app.use((req: Request, res: Response, next) => {
  if (req.path === '/health') return next();
  // No key configured — run open. See the startup warning above.
  if (!Config.apiKey) return next();

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
      logEvent('mcp_request_closed', {});
      transport.close();
      server.close();
    });
  } catch (error) {
    logEvent(
      'mcp_request_error',
      { message: error instanceof Error ? error.message : String(error) },
      'error',
    );
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
  try {
    const report = await checkReadiness();
    res.status(200).json(report);
  } catch {
    // Defence in depth: `checkReadiness()` never rejects by construction
    // (every probe resolves, and `withDeadline` only resolves), so this
    // branch is unreachable today. It exists because the always-200
    // contract is this endpoint's promise, and on Express 5 an escaped
    // rejection would be forwarded to the default error handler as a
    // 500 — putting dependency state back into status-code space, which
    // is exactly what this split removed. Keeping the guarantee local to
    // the route means a future regression inside readiness.ts degrades
    // the body, never the status code.
    const unknown = { status: 'unhealthy', latency_ms: 0 } as const;
    res.status(200).json({
      status: 'unhealthy',
      checked_at: new Date().toISOString(),
      dependencies: { searxng: unknown, crawl4ai: unknown },
    } satisfies ReadinessReport);
  }
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
  logEvent('server_listening', { port: PORT });
});

process.on('SIGINT', async () => {
  logEvent('server_shutdown', {});
  process.exit(0);
});
