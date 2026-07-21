/**
 * Covers the spec scenario "No log record appears on CLI stdout": the CLI
 * `search` command is driven in-process (matching the existing
 * `search.test.ts` convention of exercising `registerSearchCommand`
 * directly rather than spawning a process) against a stub that fails every
 * SearXNG attempt and again against one returning results, with
 * `process.stdout.write` and `console.log` captured. Operation logs must
 * stay on stderr so CLI stdout output remains machine-parseable, and the
 * existing CLI behavior (non-zero exit + "Error:" line on total failure,
 * "No results found." on a genuine empty) must be unchanged.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Command } from 'commander';

import { registerSearchCommand } from './commands/search.js';

const originalFetch = globalThis.fetch;
const originalStdoutWrite = process.stdout.write.bind(process.stdout);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stubAllAttempts(responder: () => Response | Promise<Response>): void {
  globalThis.fetch = (async () => responder()) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  process.stdout.write = originalStdoutWrite;
});

function buildProgram(): Command {
  const program = new Command();
  program
    .name('web-tools')
    .description('CLI for web search, scraping, and archival tools')
    .version('0.1.0')
    .option('--json', 'Output raw JSON (default: pretty-printed)');
  program.exitOverride();
  registerSearchCommand(program);
  return program;
}

/**
 * Runs the program exactly as index.ts does, capturing raw stdout writes
 * (via a tee-through override, matching the same reason `request-log.test.ts`
 * in `packages/api` uses one: fully swallowing stdout risks eating the test
 * runner's own concurrently-written progress output) alongside
 * console.log/console.error text.
 */
async function runCli(args: string[]): Promise<{
  exitCodes: number[];
  stdoutRaw: string[];
  stdoutConsole: string[];
  stderr: string[];
}> {
  const exitCodes: number[] = [];
  const stdoutRaw: string[] = [];
  const stdoutConsole: string[] = [];
  const stderr: string[] = [];
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;

  process.exit = ((code?: number) => {
    exitCodes.push(code ?? 0);
    return undefined as never;
  }) as typeof process.exit;
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) => {
    stdoutRaw.push(String(chunk));
    return (originalStdoutWrite as (...a: unknown[]) => boolean)(
      chunk,
      ...rest,
    );
  }) as typeof process.stdout.write;
  console.log = (...parts: unknown[]) => {
    stdoutConsole.push(parts.join(' '));
  };
  console.error = (...parts: unknown[]) => {
    stderr.push(parts.join(' '));
  };

  try {
    const program = buildProgram();
    await program.parseAsync(args, { from: 'user' }).catch((err: unknown) => {
      console.error('Error:', err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
  } finally {
    process.exit = originalExit;
    process.stdout.write = originalStdoutWrite;
    console.log = originalLog;
    console.error = originalError;
  }

  return { exitCodes, stdoutRaw, stdoutConsole, stderr };
}

/** True if the line parses as a JSON object carrying kind "event" or "operation". */
function isLogRecord(line: string): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return false;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
    return false;
  const kind = (parsed as { kind?: unknown }).kind;
  return kind === 'event' || kind === 'operation';
}

describe('CLI stdout stays machine-parseable', () => {
  test('no log record appears on stdout on a total failure, and existing behavior is unchanged', async () => {
    stubAllAttempts(() => jsonResponse({}, 503));

    const { exitCodes, stdoutRaw, stderr } = await runCli(['search', 'q']);

    assert.deepEqual(exitCodes, [1]);
    assert.ok(stderr.some(line => line.startsWith('Error:')));

    const rawLines = stdoutRaw.join('').split('\n').filter(Boolean);
    for (const line of rawLines) {
      assert.ok(!isLogRecord(line), `unexpected log record on stdout: ${line}`);
    }
  });

  test('no log record appears on stdout on a genuine empty result, and existing behavior is unchanged', async () => {
    stubAllAttempts(() => jsonResponse({ results: [] }));

    const { exitCodes, stdoutConsole, stdoutRaw, stderr } = await runCli([
      'search',
      'q',
    ]);

    assert.deepEqual(exitCodes, []);
    assert.deepEqual(stderr, []);
    assert.ok(stdoutConsole.some(line => line.includes('No results found.')));

    const rawLines = stdoutRaw.join('').split('\n').filter(Boolean);
    for (const line of rawLines) {
      assert.ok(!isLogRecord(line), `unexpected log record on stdout: ${line}`);
    }
  });
});
