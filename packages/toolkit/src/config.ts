import { z } from 'zod';

const envSchema = z.object({
  SEARXNG_URL: z.string().default('http://searxng.railway.internal:8080'),
  SEARXNG_ENGINES: z.string().optional(),
  SEARXNG_CATEGORIES: z.string().optional(),
  API_KEY: z.string().min(1, 'API_KEY is required'),
  CRAWL4AI_URL: z.string().default('http://crawl4ai.railway.internal:11235'),
  CRAWL4AI_API_TOKEN: z.string().optional(),
  CRAWL4AI_CALL_TIMEOUT_MS: z.coerce.number().int().positive().optional(),
  PROXY_SERVER: z.string().optional(),
  PROXY_USERNAME: z.string().optional(),
  PROXY_PASSWORD: z.string().optional(),
});

const env = envSchema.parse(process.env);

// Default per-call MCP timeout (milliseconds) for every Crawl4AI `callTool`
// in `crawl4ai.ts`. Exported so call sites and tests can reference the exact
// default without re-deriving it. Must stay strictly greater than the
// largest crawl budget the toolkit itself requests: functions.ts's
// `web_fetch` asks Crawl4AI for `page_timeout: 120_000` plus the default
// `delay_before_return_html` of 15s (120_000 + 15_000 = 135_000ms). Below
// that budget, a legitimately slow-but-successful crawl would always fail
// client-side before Crawl4AI itself could finish — the exact failure mode
// behind the 2026-07-18 production `MCP error -32001` incidents. 150_000ms
// leaves a comfortable margin over that worst case while still bounding a
// single call, per ARCHITECTURE.md's Failure Model ("Cancellation and
// timeout signals should propagate through the toolkit to provider clients
// where supported").
export const DEFAULT_CRAWL4AI_CALL_TIMEOUT_MS = 150_000;

export const Config = {
  apiKey: env.API_KEY,
  searxng: {
    url: env.SEARXNG_URL,
    engines: env.SEARXNG_ENGINES,
    categories: env.SEARXNG_CATEGORIES,
  },
  crawl4ai: {
    url: env.CRAWL4AI_URL,
    apiToken: env.CRAWL4AI_API_TOKEN,
    callTimeoutMs:
      env.CRAWL4AI_CALL_TIMEOUT_MS ?? DEFAULT_CRAWL4AI_CALL_TIMEOUT_MS,
  },
  proxy:
    env.PROXY_SERVER && env.PROXY_USERNAME
      ? {
          server: env.PROXY_SERVER,
          username: env.PROXY_USERNAME,
          password: env.PROXY_PASSWORD ?? '',
        }
      : null,
  parallelRequests: 3,
  requestTimeout: 15,
} as const;
