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

// Every field value passed to logEvent()/logOperation() is routed through
// this before it is written — this is deliberate, not incidental: several
// call sites across the toolkit pass raw upstream text into a log record
// (a Crawl4AI/Playwright error message, an SSE transport error, a SearXNG
// unresponsive-engines list), and any of those can embed the caller's own
// target URL — query string, tokens, and all — or grow unboundedly (a
// thrown error's message can, in principle, carry an entire page body, and
// that text is attacker-influenceable: it is the crawled page's own error
// content on at least one path). Rather than trust every current and
// future call site to remember to sanitize its own free-text fields, the
// writer sanitizes everything by default: a new field, or a new level of
// nesting, cannot opt out by omission.
//
// Fields that are already safe (targetUrl via safeUrl(), baseUrl from
// Config, userAgent/query already truncated) pass through unchanged, since
// redacting an embedded URL is a no-op when there is no query string to
// strip, and truncating an already-short value is a no-op. Structured
// values (arrays and plain objects — e.g. a SearXNG attempt's `reason`) are
// walked recursively up to a bounded depth rather than skipped outright, so
// a secret or an unbounded string cannot hide one level down; short enums
// and numbers inside them (e.g. `reason.cause`, `reason.status`) still come
// through byte-identical because sanitizing a value that needs no
// sanitizing is a no-op.

// Exported so tests can pin assertions to the real bound rather than a
// hand-copied guess that could silently drift from it.
export const MAX_FIELD_LENGTH = 500;
export const MAX_ARRAY_ITEMS = 25;
export const MAX_SANITIZE_DEPTH = 4;

const TRUNCATION_MARKER = '…[truncated]';

// Bounds how much of a value the redaction regex ever has to scan,
// independent of `MAX_FIELD_LENGTH` (the *output* bound) and independent of
// how large the raw value actually is. This is what keeps the regex's own
// work bounded against a multi-megabyte hostile input before the regex is
// even run — generous enough that nothing within the eventual
// MAX_FIELD_LENGTH-truncated output is ever lost by cutting here first; a
// URL-shaped run that gets cut mid-query by this bound is still fully
// redacted (the query group matches to end-of-string when unterminated).
const PRE_REDACTION_CEILING = 8000;

// Matches a URL-shaped substring anywhere inside free text and captures
// just the scheme and the host+path portion, so userinfo, query string,
// and fragment — the parts that can carry secrets — can be dropped without
// reparsing/reconstructing the URL (which could otherwise normalize an
// already-clean value, e.g. adding a trailing slash to a bare origin).
//
// The userinfo group's character class deliberately excludes "/", "?", and
// "#" (not just whitespace/quotes): per RFC 3986 userinfo cannot contain
// any of those, so excluding them confines the group to the authority
// component. Two previous bugs both traced to the same root cause — the
// old class did not exclude them, so the lazy `*?` scan could span past the
// real host into unrelated text containing a later "@" (e.g. an email
// address or a "notify=user@host" query fragment elsewhere in the same
// message) and fabricate an attribution to the wrong host, while
// overlapping with the following host+path group's own territory is
// exactly the shape that produces catastrophic (quadratic) backtracking on
// adversarial input. The explicit {0,128} bound is defense in depth on top
// of the charset fix, not a substitute for it.
const EMBEDDED_URL_RE =
  /(\bhttps?:\/\/)([^\s"')/?#]{0,128}@)?([^\s"')?#]+)(\?[^\s"')#]*)?(#[^\s"')]*)?/gi;

function redactUrlsInText(text: string): string {
  const bounded =
    text.length > PRE_REDACTION_CEILING
      ? text.slice(0, PRE_REDACTION_CEILING)
      : text;
  return bounded.replace(
    EMBEDDED_URL_RE,
    (
      _match,
      scheme: string,
      _userinfo: string | undefined,
      hostAndPath: string,
    ) => `${scheme}${hostAndPath}`,
  );
}

/**
 * Redacts, then bounds, a single string field. When truncation actually
 * happens, the cut is marked rather than silent — "cut at 500" must be
 * distinguishable from "the error was exactly this", or a reader chasing a
 * truncated `cause` down would have no way to know it was truncated at all.
 * The marker is reserved out of the same budget, so the total stays within
 * `MAX_FIELD_LENGTH` either way.
 */
function sanitizeString(value: string): string {
  const redacted = redactUrlsInText(value);
  if (redacted.length <= MAX_FIELD_LENGTH) return redacted;
  const keep = Math.max(0, MAX_FIELD_LENGTH - TRUNCATION_MARKER.length);
  return redacted.slice(0, keep) + TRUNCATION_MARKER;
}

function sanitizeFieldValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return sanitizeString(value);
  if (typeof value !== 'object' || value === null) return value; // number, boolean, undefined

  if (depth >= MAX_SANITIZE_DEPTH) {
    // Never emit unsanitized nested content past the depth budget — collapse
    // rather than pass through raw.
    return '[nested value omitted: exceeds sanitize depth]';
  }

  if (Array.isArray(value)) {
    return value
      .slice(0, MAX_ARRAY_ITEMS)
      .map(v => sanitizeFieldValue(v, depth + 1));
  }

  const sanitized: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    sanitized[key] = sanitizeFieldValue(v, depth + 1);
  }
  return sanitized;
}

function sanitizeFields<T extends Record<string, unknown>>(fields: T): T {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    sanitized[key] = sanitizeFieldValue(value);
  }
  return sanitized as T;
}

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
    ...sanitizeFields(fields),
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
    ...sanitizeFields(fields),
    requestId: sanitizeString(requestId),
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
