import {
  adoptOrMintRequestId,
  logOperation,
  runInRequestContext,
  startTimer,
  truncate,
} from '@web-tools/toolkit';
import type { NextFunction, Request, Response } from 'express';

const USER_AGENT_MAX_LENGTH = 200;

/**
 * Adopts (or mints) the request-correlation ID, enters it into the ambient
 * request context for the rest of the request, and emits one `http_request`
 * operation record when the response finishes.
 *
 * Mounted immediately after `express.json()` and strictly before the auth
 * middleware, so a request the auth middleware rejects with 403 — which
 * terminates the chain without calling `next()` — is still logged; that is
 * exactly the traffic the `GET /mcp` 405 probing issue needs attributed.
 *
 * Logs `req.path`, never `req.originalUrl` / `req.url` / `req.query` /
 * `req.headers` wholesale, so neither the `Authorization` header value nor
 * an `api_key` query parameter can ever reach a log line through here.
 */
export function requestLogMiddleware(
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  const requestId = adoptOrMintRequestId(req.headers['x-request-id']);

  runInRequestContext(requestId, () => {
    const elapsed = startTimer();
    const rawUserAgent = req.headers['user-agent'];
    const userAgent = rawUserAgent
      ? truncate(String(rawUserAgent), USER_AGENT_MAX_LENGTH)
      : null;

    res.on('finish', () => {
      logOperation('http_request', {
        operation: 'http.request',
        requestId,
        outcome: res.statusCode >= 400 ? 'error' : 'ok',
        durationMs: elapsed(),
        method: req.method,
        path: req.path,
        status: res.statusCode,
        userAgent,
      });
    });

    next();
  });
}
