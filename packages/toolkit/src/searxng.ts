import { Config } from './config.js';
import type { SearchResult } from './types.js';

type SearXNGResult = {
  url: string;
  title: string;
  content: string;
};

/** Loosely-typed upstream body; every field is validated before use. */
type SearXNGResponse = {
  results?: unknown;
  unresponsive_engines?: unknown;
};

/**
 * Safe, structured, machine-readable cause of a failed SearXNG attempt.
 * Never carries an API key, secret, or raw upstream response body.
 */
export type SearXNGFailureReason =
  | { cause: 'http_status'; status: number }
  | { cause: 'invalid_response' }
  | { cause: 'timeout' }
  | { cause: 'network_error' }
  | { cause: 'all_engines_unresponsive'; engines: string[] };

type FetchOutcome =
  | { kind: 'ok'; results: SearXNGResult[]; hasContent: boolean }
  | { kind: 'empty' }
  | { kind: 'failed'; reason: SearXNGFailureReason };

/**
 * Thrown by `searchSearXNG` when every parallel SearXNG attempt fails (a
 * total upstream outage), as opposed to a genuine no-match. Carries the
 * per-attempt safe reasons as a structured property for programmatic use.
 * `message` is actionable but never contains a secret or raw upstream body.
 */
export class SearchProviderError extends Error {
  readonly reasons: SearXNGFailureReason[];

  constructor(message: string, reasons: SearXNGFailureReason[]) {
    super(message);
    this.name = 'SearchProviderError';
    this.reasons = reasons;
  }
}

/** Emits one single-line JSON record to stderr per SearXNG attempt outcome. */
function logOutcome(attempt: number, outcome: FetchOutcome): void {
  const record: Record<string, unknown> = {
    event: 'searxng_attempt_outcome',
    attempt,
    kind: outcome.kind,
  };
  if (outcome.kind === 'ok') {
    record.results = outcome.results.length;
    record.hasContent = outcome.hasContent;
  } else if (outcome.kind === 'failed') {
    record.reason = outcome.reason;
  }
  process.stderr.write(JSON.stringify(record) + '\n');
}

/**
 * Defensively extracts engine names from SearXNG's `unresponsive_engines`
 * field.
 *
 * Verified present (2026-07-19) against the upstream `searxng/searxng`
 * `master` branch on GitHub, which the deployed image's `:latest` tag
 * tracks (`services/searxng/Dockerfile`): in `searx/webapp.py`, the
 * `output_format == 'json'` branch calls
 * `webutils.get_json_response(search_query, result_container)`
 * (searx/webapp.py:672-674), and `get_json_response` in
 * `searx/webutils.py:162-174` always includes
 * `'unresponsive_engines': get_translated_errors(rc.unresponsive_engines)`
 * in the JSON body. `get_translated_errors` (searx/webutils.py:70-82)
 * returns a list of `[engine_name, translated_error_message]` pairs
 * (serialized as 2-element JSON arrays), sorted by engine name, and empty
 * when nothing is unresponsive. So the field is present and its shape is
 * as classified below.
 *
 * Because `:latest` is a rolling tag and not a version-pinned contract,
 * this parse stays fully defensive regardless: anything that doesn't match
 * the expected shape is treated as "not reported" rather than an error, so
 * its absence or malformation can never turn a genuine `empty` into a
 * `failed`.
 */
function extractUnresponsiveEngines(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const engines: string[] = [];
  for (const entry of value) {
    if (Array.isArray(entry) && typeof entry[0] === 'string' && entry[0]) {
      engines.push(entry[0]);
    } else if (typeof entry === 'string' && entry) {
      engines.push(entry);
    }
  }
  return engines;
}

/** Single SearXNG request. Classifies the attempt as ok / empty / failed. */
async function fetchSearXNG(
  query: string,
  options: { engines?: string; timeout: number },
  attempt: number,
): Promise<FetchOutcome> {
  let outcome: FetchOutcome;

  try {
    const {
      url: baseUrl,
      engines: defaultEngines,
      categories,
    } = Config.searxng;
    const params = new URLSearchParams({ q: query, format: 'json' });

    const engines = options.engines || defaultEngines;
    if (engines) params.set('engines', engines);
    if (categories) params.set('categories', categories);

    const response = await fetch(`${baseUrl}/search?${params.toString()}`, {
      signal: AbortSignal.timeout(options.timeout * 1000),
      headers: { Accept: 'application/json' },
    });

    if (!response.ok) {
      outcome = {
        kind: 'failed',
        reason: { cause: 'http_status', status: response.status },
      };
      logOutcome(attempt, outcome);
      return outcome;
    }

    let body: SearXNGResponse;
    try {
      body = (await response.json()) as SearXNGResponse;
    } catch {
      outcome = { kind: 'failed', reason: { cause: 'invalid_response' } };
      logOutcome(attempt, outcome);
      return outcome;
    }

    if (!Array.isArray(body.results)) {
      outcome = { kind: 'failed', reason: { cause: 'invalid_response' } };
      logOutcome(attempt, outcome);
      return outcome;
    }

    const valid = (body.results as SearXNGResult[]).filter(
      r => r && r.title && r.url,
    );

    if (valid.length === 0) {
      // Zero valid results. Distinguish "SearXNG answered but every engine
      // that ran failed" (failed) from a genuine no-match (empty) using
      // unresponsive_engines when it's reported; see
      // extractUnresponsiveEngines for the verification of its presence
      // and shape on the deployed image.
      //
      // The JSON response carries no field listing the full roster of
      // engines that ran (get_json_response in searx/webutils.py returns
      // only query/results/answers/corrections/infoboxes/suggestions/
      // unresponsive_engines — verified above), so "every engine that ran
      // is unresponsive" is only decidable against the engine set this
      // attempt actually requested. A response can legitimately have zero
      // results with only SOME engines listed unresponsive — the other,
      // responsive engines simply matched nothing, which is a genuine
      // empty, not a failure. Only when every one of the requested engines
      // appears in unresponsive_engines is the zero-result count fully
      // explained by failure. When no explicit engine list was requested
      // (SearXNG's own default set applies), the roster is unknown to us
      // and this signal cannot be verified — per the defensive principle
      // above, an unverifiable signal must never turn a genuine empty into
      // a failed, so it falls back to `empty`.
      const unresponsiveEngines = extractUnresponsiveEngines(
        body.unresponsive_engines,
      );
      const requestedEngines = engines
        ? engines
            .split(',')
            .map(e => e.trim().toLowerCase())
            .filter(Boolean)
        : [];
      const unresponsiveSet = new Set(
        unresponsiveEngines.map(e => e.toLowerCase()),
      );
      const allRequestedUnresponsive =
        requestedEngines.length > 0 &&
        requestedEngines.every(e => unresponsiveSet.has(e));

      if (allRequestedUnresponsive) {
        outcome = {
          kind: 'failed',
          reason: {
            cause: 'all_engines_unresponsive',
            engines: unresponsiveEngines,
          },
        };
      } else {
        outcome = { kind: 'empty' };
      }
      logOutcome(attempt, outcome);
      return outcome;
    }

    const withContent = valid.filter(r => r.content?.trim());
    outcome = {
      kind: 'ok',
      results: valid,
      hasContent: withContent.length > 0,
    };
    logOutcome(attempt, outcome);
    return outcome;
  } catch (err) {
    // AbortSignal.timeout rejects with a DOMException named 'TimeoutError'.
    // Classify on err.name, not message text, to distinguish a timeout
    // from a generic network/fetch error.
    const isTimeout =
      err instanceof DOMException && err.name === 'TimeoutError';
    outcome = {
      kind: 'failed',
      reason: { cause: isTimeout ? 'timeout' : 'network_error' },
    };
    logOutcome(attempt, outcome);
    return outcome;
  }
}

function describeCause(reason: SearXNGFailureReason): string {
  switch (reason.cause) {
    case 'http_status':
      return `http_status:${reason.status}`;
    case 'all_engines_unresponsive':
      return 'all_engines_unresponsive';
    default:
      return reason.cause;
  }
}

/** Builds an actionable, secret-free message summarizing all-failed attempts. */
function buildFailureMessage(reasons: SearXNGFailureReason[]): string {
  const counts = new Map<string, number>();
  for (const reason of reasons) {
    const key = describeCause(reason);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const summary = [...counts.entries()]
    .map(([cause, n]) => `${cause} x${n}`)
    .join(', ');
  return `SearXNG search failed: all ${reasons.length} attempt(s) failed (${summary})`;
}

/** Fire parallel requests to SearXNG, return the first valid response with content. */
export async function searchSearXNG(
  query: string,
  options?: { limit?: number; engines?: string },
): Promise<{ data: SearchResult[] }> {
  const limit = options?.limit ?? 10;
  const timeout = Config.requestTimeout;
  const count = Config.parallelRequests;

  const tasks = Array.from({ length: count }, (_, i) =>
    fetchSearXNG(query, { engines: options?.engines, timeout }, i + 1),
  );

  // Return the first response that has results with content.
  // If none have content, return the first with any results.
  let bestNoContent: SearXNGResult[] | null = null;
  let rawResults: SearXNGResult[] = [];
  let sawOk = false;
  let sawEmpty = false;
  const failures: SearXNGFailureReason[] = [];

  for (const promise of raceAll(tasks)) {
    const outcome = await promise;

    if (outcome.kind === 'ok') {
      sawOk = true;
      if (outcome.hasContent) {
        rawResults = outcome.results;
        break;
      }
      if (bestNoContent === null) {
        bestNoContent = outcome.results;
      }
      continue;
    }

    if (outcome.kind === 'empty') {
      sawEmpty = true;
      continue;
    }

    failures.push(outcome.reason);
  }

  if (rawResults.length === 0) {
    rawResults = bestNoContent ?? [];
  }

  if (!sawOk) {
    if (!sawEmpty) {
      // Every attempt failed: a total upstream outage, not a legitimate
      // no-match. Surface it as an actionable error instead of a silent
      // empty success (docs/PRODUCT.md principle 2: "Failures are data,
      // not empty arrays").
      throw new SearchProviderError(buildFailureMessage(failures), failures);
    }
    // At least one attempt genuinely answered with zero results, and none
    // succeeded: this is a legitimate empty result, not a failure — even
    // if other attempts in this same batch were `failed` (spec scenario
    // "Mixed empty and failed"). Those failures are intentionally not
    // attached to this success return; they were already emitted as
    // their own structured stderr lines by logOutcome when each attempt
    // completed, so the information isn't lost, just not surfaced here.
    rawResults = [];
  }

  // Deduplicate by URL and limit results
  const seen = new Set<string>();
  const data: SearchResult[] = [];

  for (const r of rawResults) {
    if (!r.url || seen.has(r.url)) continue;
    seen.add(r.url);
    data.push({
      url: r.url,
      title: r.title || '',
      description: r.content || '',
    });
    if (data.length >= limit) break;
  }

  return { data };
}

/** Yields promises in the order they resolve (like Promise.race but iterative). */
function raceAll(promises: Promise<FetchOutcome>[]): Promise<FetchOutcome>[] {
  const results: {
    resolve: (value: FetchOutcome) => void;
    promise: Promise<FetchOutcome>;
  }[] = [];
  const pending = new Set<Promise<FetchOutcome>>(promises);

  for (let i = 0; i < promises.length; i++) {
    let resolve!: (value: FetchOutcome) => void;
    const promise = new Promise<FetchOutcome>(r => {
      resolve = r;
    });
    results.push({ resolve, promise });
  }

  let idx = 0;
  for (const p of promises) {
    p.then(
      value => {
        if (pending.delete(p)) {
          results[idx++]!.resolve(value);
        }
      },
      () => {
        // fetchSearXNG catches its own errors, so a rejection here is
        // unexpected. Map it to a failed outcome rather than a bare value
        // (the previous `null as T`), so an unexpected throw can never be
        // silently counted as a non-failure.
        if (pending.delete(p)) {
          results[idx++]!.resolve({
            kind: 'failed',
            reason: { cause: 'network_error' },
          });
        }
      },
    );
  }

  return results.map(r => r.promise);
}
