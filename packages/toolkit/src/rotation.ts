// IP rotation for Crawl4AI. Crawl4AI's Chromium process holds a
// persistent HTTP CONNECT tunnel to the upstream proxy, so EVERY
// request from a given Crawl4AI container egresses on the same
// iProyal IP — regardless of session_id, even with a "rotating"
// proxy config. As that IP accumulates requests against a target,
// CF / WAF rate-limits progressively (we saw 64% 429 after a few
// hundred calls).
//
// Fix: when the upstream returns N consecutive anti-bot signals
// (429 or "Just a moment..." CF challenge), call Crawl4AI's admin
// /monitor/actions/kill_browser on the killable "hot" browser. That
// tears down Chromium's tunnel, so the next /crawl call spawns a
// fresh browser and re-establishes a new TCP connection to the
// proxy → new iProyal IP.
//
// Counter is process-local. Rotation is debounced — only one
// kill_browser in-flight at a time; other workers' simultaneous
// failures count toward the same rotation cycle.

import { Config } from './config.js';

const ROTATE_THRESHOLD = parseInt(process.env.ROTATE_AFTER_429 ?? '3', 10);

let consecutive429 = 0;
let rotating: Promise<void> | null = null;
const stats = {
  rotations: 0,
  last_rotated_at: null as string | null,
  threshold: ROTATE_THRESHOLD,
};

export function getRotationStats() {
  return {
    ...stats,
    consecutive_429: consecutive429,
    rotating: rotating !== null,
  };
}

export function noteBlocked(): void {
  consecutive429++;
  if (consecutive429 >= ROTATE_THRESHOLD && !rotating) {
    rotating = rotate().finally(() => {
      rotating = null;
    });
  }
}

export function noteSuccess(): void {
  consecutive429 = 0;
}

async function rotate(): Promise<void> {
  const headers: Record<string, string> = {};
  if (Config.crawl4ai.apiToken) {
    headers['Authorization'] = `Bearer ${Config.crawl4ai.apiToken}`;
  }
  try {
    const listUrl = new URL('/monitor/browsers', Config.crawl4ai.url);
    const listRes = await fetch(listUrl, { headers });
    if (!listRes.ok) {
      process.stderr.write(`[rotation] /monitor/browsers HTTP ${listRes.status}\n`);
      return;
    }
    const data = (await listRes.json()) as {
      browsers?: Array<{ sig: string; killable: boolean; type: string; hits: number }>;
    };
    const killable = (data.browsers ?? []).filter((b) => b.killable);
    if (killable.length === 0) {
      process.stderr.write('[rotation] no killable browser found\n');
      return;
    }
    for (const b of killable) {
      const killUrl = new URL('/monitor/actions/kill_browser', Config.crawl4ai.url);
      const r = await fetch(killUrl, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sig: b.sig }),
      });
      if (!r.ok) {
        process.stderr.write(
          `[rotation] kill_browser sig=${b.sig} HTTP ${r.status}\n`,
        );
      }
    }
    stats.rotations++;
    stats.last_rotated_at = new Date().toISOString();
    consecutive429 = 0;
    process.stderr.write(
      `[rotation] killed ${killable.length} browser(s) after ${ROTATE_THRESHOLD} consecutive blocks (rotation #${stats.rotations})\n`,
    );
  } catch (e) {
    process.stderr.write(`[rotation] failed: ${(e as Error).message}\n`);
  }
}
