// Shared structured logging for the toolkit and its transport adapters.
//
// Every record is one JSON object per line, written to stderr only. Two
// record kinds:
//   - "event": diagnostic / lifecycle lines with no measurable outcome
//     (process startup, shutdown, transport errors, pre-dispatch summaries).
//   - "operation": anything with a measurable outcome. Every operation
//     record carries requestId, operation, outcome ("ok" | "empty" |
//     "error"), and durationMs.
//
// `kind` is reserved for this record-type discriminator; per-domain
// classifications (e.g. a SearXNG attempt's ok/empty/error result) live in
// `outcome`, never in `kind`.
//
// A per-request correlation ID is carried ambiently via AsyncLocalStorage so
// toolkit code can read it without any public tool signature change.

import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

// ── Request correlation context ──────────────────────────────────────

type RequestContext = { requestId: string };

const storage = new AsyncLocalStorage<RequestContext>();

const REQUEST_ID_MAX_LENGTH = 200;
const REQUEST_ID_DISALLOWED_RE = /[^A-Za-z0-9._:-]/g;

/**
 * Bounds and strips an untrusted (caller-supplied) request ID candidate.
 * Anything outside `[A-Za-z0-9._:-]` is removed and the result is capped at
 * 200 characters; if nothing survives, a fresh ID is minted. This is what
 * keeps a hostile `X-Request-Id` header from forging a log line (no
 * newlines survive) or growing unbounded.
 */
export function sanitizeRequestId(raw: string | undefined | null): string {
  if (!raw) return randomUUID();
  const bounded = raw.slice(0, REQUEST_ID_MAX_LENGTH);
  const stripped = bounded.replace(REQUEST_ID_DISALLOWED_RE, '');
  return stripped.length > 0 ? stripped : randomUUID();
}

/** Adopts an inbound `X-Request-Id` header value, or mints a fresh one. */
export function adoptOrMintRequestId(
  header: string | string[] | undefined,
): string {
  const raw = Array.isArray(header) ? header[0] : header;
  return sanitizeRequestId(raw);
}

/** Reads the ambient request ID, or mints a one-off fallback if none is active. */
export function getRequestId(): string {
  return storage.getStore()?.requestId ?? randomUUID();
}

/** Runs `fn` inside a request context carrying the given (already-sanitized) ID. */
export function runInRequestContext<T>(requestId: string, fn: () => T): T {
  return storage.run({ requestId }, fn);
}

/**
 * Joins the ambient request context if one is active, otherwise mints a
 * fresh one and runs `fn` inside it. This is what makes context-free
 * toolkit calls (CLI, direct toolkit use, background work) correlate their
 * own records without ever requiring a public tool signature change.
 */
export function withRequestContext<T>(fn: (requestId: string) => T): T {
  const existing = storage.getStore();
  if (existing) return fn(existing.requestId);
  const requestId = randomUUID();
  return storage.run({ requestId }, () => fn(requestId));
}

// ── Writer ────────────────────────────────────────────────────────────

function write(record: Record<string, unknown>): void {
  process.stderr.write(JSON.stringify(record) + '\n');
}

type Level = 'info' | 'warn' | 'error';

/** Emits a diagnostic / lifecycle record: no measurable outcome. */
export function logEvent(
  event: string,
  fields: Record<string, unknown> = {},
  level: Level = 'info',
): void {
  write({
    ts: new Date().toISOString(),
    event,
    ...fields,
    kind: 'event',
    level,
  });
}

export type OperationFields = {
  operation: string;
  outcome: 'ok' | 'empty' | 'error';
  durationMs: number;
  requestId?: string;
  [key: string]: unknown;
};

/**
 * Emits an operation record: `kind` is always "operation" and `requestId`,
 * `operation`, `outcome`, and `durationMs` are always present. `requestId`
 * defaults to the ambient one when the caller doesn't supply it.
 */
export function logOperation(event: string, fields: OperationFields): void {
  const requestId = fields.requestId ?? getRequestId();
  const level: Level = fields.outcome === 'error' ? 'error' : 'info';
  write({
    ts: new Date().toISOString(),
    event,
    ...fields,
    requestId,
    kind: 'operation',
    level,
  });
}

// ── Timing ────────────────────────────────────────────────────────────

/** Starts a timer; call the returned function to get elapsed milliseconds. */
export function startTimer(): () => number {
  const start = performance.now();
  return () => Math.round(performance.now() - start);
}

// ── Safe value helpers ───────────────────────────────────────────────

const MAX_PATH_LENGTH = 200;

/**
 * Reduces a URL to scheme + host + pathname (truncated to 200 chars),
 * stripping userinfo, query string, and fragment — the caller's own query
 * values are the plausible carrier of tokens and credentials, so they are
 * never logged. `hasQuery` records whether a query string was present, so
 * "the target is identifiable" survives even though the query itself
 * doesn't. A value that doesn't parse as a URL is reported as
 * "(unparseable)" rather than echoed.
 */
export function safeUrl(raw: string | null | undefined): {
  url: string | null;
  hasQuery: boolean;
} {
  if (!raw) return { url: null, hasQuery: false };
  try {
    const parsed = new URL(raw);
    const hasQuery = parsed.search.length > 0;
    const pathname =
      parsed.pathname.length > MAX_PATH_LENGTH
        ? parsed.pathname.slice(0, MAX_PATH_LENGTH)
        : parsed.pathname;
    return { url: `${parsed.protocol}//${parsed.host}${pathname}`, hasQuery };
  } catch {
    return { url: '(unparseable)', hasQuery: false };
  }
}

type ArgShapeToken =
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'object'
  | `array[${number}]`;

/**
 * Maps each top-level key of an outgoing Crawl4AI argument object to a type
 * token only — never a value. Nesting is never descended: this is what
 * structurally guarantees that proxy credentials (nested at
 * `browser_config.params.proxy_config.params`) and script bodies can never
 * leak through this summary.
 */
export function summarizeArgShape(
  args: Record<string, unknown>,
): Record<string, ArgShapeToken> {
  const shape: Record<string, ArgShapeToken> = {};
  for (const [key, value] of Object.entries(args)) {
    if (value === null) {
      shape[key] = 'null';
    } else if (Array.isArray(value)) {
      shape[key] = `array[${value.length}]`;
    } else {
      shape[key] = typeof value as ArgShapeToken;
    }
  }
  return shape;
}

/** Truncates a string to at most `maxLength` characters. */
export function truncate(value: string, maxLength: number): string {
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}
