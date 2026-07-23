import { probeCrawl4AI } from './crawl4ai.js';
import { probeSearXNG } from './searxng.js';

/**
 * Explicit, short per-probe timeout for readiness checks. Deliberately NOT
 * `Config.requestTimeout` (a 30s per-search budget): a health probe must
 * answer far faster than a user query, so `GET /ready` never becomes the
 * slowest thing in the stack.
 */
export const PROBE_TIMEOUT_MS = 3000;

/**
 * Maximum age of a cached readiness report before a new probe round runs.
 * Bounds upstream request volume against SearXNG and Crawl4AI so polling
 * `/ready` cannot itself become a load amplifier. Per the story card, this
 * must never exceed 5000ms.
 */
export const READINESS_CACHE_TTL_MS = 5000;

export type DependencyProbeStatus = 'ok' | 'unhealthy';

/**
 * Closed set of safe, machine-readable failure causes. Never free-form
 * upstream text, a URL, a header, or an exception message, so no
 * configured URL, credential, or token can reach a caller of `GET /ready`.
 */
export type DependencyProbeDetail =
  | 'timeout'
  | 'network_error'
  | 'protocol_error'
  | `http_status:${number}`;

export type DependencyProbeResult = {
  status: DependencyProbeStatus;
  latency_ms: number;
  detail?: DependencyProbeDetail;
};

export type ReadinessStatus = 'ok' | 'degraded' | 'unhealthy';

export type ReadinessReport = {
  status: ReadinessStatus;
  checked_at: string;
  dependencies: {
    searxng: DependencyProbeResult;
    crawl4ai: DependencyProbeResult;
  };
};

/**
 * Races a single probe against readiness's own timeout bound, on top of
 * whatever native timeout the probe already applies. This is a backstop,
 * not the primary timeout mechanism: if a probe implementation ever
 * ignored its `timeoutMs` argument, this still guarantees
 * `checkReadiness()` cannot hang past `PROBE_TIMEOUT_MS`. A probe that
 * settles after this bound fires keeps running in the background;
 * `probeSearXNG` simply discards its result, and `probeCrawl4AI` still
 * runs its own connect/reset handling when it eventually settles.
 */
function withDeadline(
  probe: Promise<DependencyProbeResult>,
  start: number,
  timeoutMs: number,
): Promise<DependencyProbeResult> {
  return new Promise<DependencyProbeResult>(resolve => {
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({
        status: 'unhealthy',
        latency_ms: Math.max(0, Math.round(performance.now() - start)),
        detail: 'timeout',
      });
    }, timeoutMs);

    probe.then(
      result => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      },
      () => {
        // probeSearXNG / probeCrawl4AI already catch their own errors and
        // resolve a classified outcome, so a rejection here is
        // unexpected. checkReadiness() must never reject either way, so
        // classify it defensively rather than letting it propagate.
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({
          status: 'unhealthy',
          latency_ms: Math.max(0, Math.round(performance.now() - start)),
          detail: 'network_error',
        });
      },
    );
  });
}

/**
 * Captures the start time, starts one probe, and applies readiness.ts's
 * own deadline bound to it. The start time is captured before the probe is
 * invoked, matching how each probe times its own success/error latency.
 */
function deadlinedProbe(
  probe: (timeoutMs: number) => Promise<DependencyProbeResult>,
): Promise<DependencyProbeResult> {
  const start = performance.now();
  return withDeadline(probe(PROBE_TIMEOUT_MS), start, PROBE_TIMEOUT_MS);
}

async function runProbes(): Promise<ReadinessReport> {
  const [searxng, crawl4ai] = await Promise.all([
    deadlinedProbe(probeSearXNG),
    deadlinedProbe(probeCrawl4AI),
  ]);

  const okCount =
    Number(searxng.status === 'ok') + Number(crawl4ai.status === 'ok');
  const status: ReadinessStatus =
    okCount === 2 ? 'ok' : okCount === 0 ? 'unhealthy' : 'degraded';

  return {
    status,
    checked_at: new Date().toISOString(),
    dependencies: { searxng, crawl4ai },
  };
}

let cached: { report: ReadinessReport; cachedAt: number } | null = null;
let inFlight: Promise<ReadinessReport> | null = null;

/**
 * Runs (or reuses) a bounded, cached readiness check across SearXNG and
 * Crawl4AI. Never rejects: every probe outcome, including an unexpected
 * throw, is classified into the returned report.
 *
 * - A cached report younger than `READINESS_CACHE_TTL_MS` is returned
 *   without issuing any upstream request.
 * - A probe round already in flight is shared (single-flight): a burst of
 *   concurrent callers triggers exactly one round of upstream probes.
 * - Otherwise a fresh round runs, is cached, and is returned.
 */
export function checkReadiness(): Promise<ReadinessReport> {
  const now = Date.now();
  if (cached && now - cached.cachedAt < READINESS_CACHE_TTL_MS) {
    return Promise.resolve(cached.report);
  }
  if (inFlight) {
    return inFlight;
  }

  inFlight = runProbes()
    .then(report => {
      cached = { report, cachedAt: Date.now() };
      return report;
    })
    .finally(() => {
      inFlight = null;
    });

  return inFlight;
}
