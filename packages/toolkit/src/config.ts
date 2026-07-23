import { z } from 'zod';

const envSchema = z.object({
  SEARXNG_URL: z.string().default('http://searxng.railway.internal:8080'),
  SEARXNG_ENGINES: z.string().optional(),
  SEARXNG_CATEGORIES: z.string().optional(),
  // Optional so a local stack runs with no credentials at all. When it is
  // unset the API serves every route unauthenticated — see the startup
  // warning in packages/api/src/index.ts. Deployed environments must set it;
  // Railway generates one via `${{secret()}}`.
  API_KEY: z.string().min(1).optional(),
  CRAWL4AI_URL: z.string().default('http://crawl4ai.railway.internal:11235'),
  CRAWL4AI_API_TOKEN: z.string().optional(),
  CRAWL4AI_CALL_TIMEOUT_MS: z.coerce.number().int().positive().default(150000),
  PROXY_SERVER: z.string().optional(),
  PROXY_USERNAME: z.string().optional(),
  PROXY_PASSWORD: z.string().optional(),
});

const env = envSchema.parse(process.env);

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
    callTimeoutMs: env.CRAWL4AI_CALL_TIMEOUT_MS,
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
  /**
   * Per-search client budget, in seconds, for a SearXNG request.
   *
   * Must stay strictly above SearXNG's own `outgoing.max_request_timeout:
   * 20.0` (`services/searxng/settings.yml`). At the previous value of 15 it
   * exactly matched that file's `outgoing.request_timeout: 15.0`, leaving
   * zero headroom: SearXNG waits for its slowest engine before aggregating,
   * so any engine set containing one slow engine aborted here first. That
   * discarded the results healthy engines had already returned — a
   * `bing,duckduckgo` search yielded nothing while `bing` alone succeeded.
   */
  requestTimeout: 30,
} as const;
