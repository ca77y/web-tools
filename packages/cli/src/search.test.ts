/**
 * Exercises the real CLI `search` command via its exported registration
 * (`registerSearchCommand`, commands/search.ts) rather than by spawning a
 * process, per the unit's spec. `packages/cli/src/index.ts` cannot be
 * imported directly for this: it runs `program.parseAsync(process.argv)`
 * unconditionally as an unguarded module-level side effect (there is no
 * `require.main`-style guard), so importing it would immediately parse
 * this test runner's own argv and could call `process.exit`.
 *
 * Instead this test builds a `Command` the same way index.ts does (a root
 * program with the shared `--json` option, then `registerSearchCommand`),
 * invokes it exactly as commander is invoked in production, and then
 * applies index.ts's own top-level catch verbatim — confirmed identical to
 * `packages/cli/src/index.ts:22-25`:
 *
 *   program.parseAsync(process.argv).catch((err) => {
 *     console.error('Error:', err instanceof Error ? err.message : String(err));
 *     process.exit(1);
 *   });
 *
 * `process.exit` is stubbed so a real failure doesn't kill the test
 * runner; `console.log`/`console.error` are captured to assert on CLI
 * output. Only `globalThis.fetch` is stubbed to force the total-failure
 * and genuine-empty cases — no production source in this package is
 * modified.
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Command } from 'commander';

import { registerSearchCommand } from './commands/search.js';

const originalFetch = globalThis.fetch;

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
});

/** Builds a root Command wired up the same way packages/cli/src/index.ts does. */
function buildProgram(): Command {
  const program = new Command();
  program
    .name('web-tools')
    .description('CLI for web search, scraping, and archival tools')
    .version('0.1.0')
    .option('--json', 'Output raw JSON (default: pretty-printed)');
  // Commander calls process.exit on a parse/usage error by default; that's
  // not what we're testing here (we're testing the action handler's own
  // error propagation), so let errors flow to our .catch() below instead.
  // Must be set BEFORE registerSearchCommand(): commander copies the
  // exit-override callback onto a subcommand at `.command()` creation
  // time, so a subcommand created before exitOverride() is called does
  // not inherit it and would still call process.exit directly.
  program.exitOverride();
  registerSearchCommand(program);
  return program;
}

/** Runs the program exactly as index.ts:22-25 does, capturing output/exit. */
async function runCli(
  args: string[],
): Promise<{ exitCodes: number[]; stdout: string[]; stderr: string[] }> {
  const exitCodes: number[] = [];
  const stdout: string[] = [];
  const stderr: string[] = [];
  const originalExit = process.exit;
  const originalLog = console.log;
  const originalError = console.error;

  process.exit = ((code?: number) => {
    exitCodes.push(code ?? 0);
    return undefined as never;
  }) as typeof process.exit;
  console.log = (...parts: unknown[]) => {
    stdout.push(parts.join(' '));
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
    console.log = originalLog;
    console.error = originalError;
  }

  return { exitCodes, stdout, stderr };
}

describe('CLI transport reporting - search command', () => {
  test('an all-attempts-failed search exits non-zero, prints the error, and does not print "No results found."', async () => {
    stubAllAttempts(() => jsonResponse({}, 503));

    const { exitCodes, stdout, stderr } = await runCli(['search', 'q']);

    assert.deepEqual(exitCodes, [1]);
    assert.ok(
      stderr.some(line => line.startsWith('Error:')),
      'expected an "Error: ..." line on stderr',
    );
    assert.ok(
      !stdout.some(line => line.includes('No results found.')),
      'must not print "No results found." on a total failure',
    );
  });

  test('a genuine empty result exits zero and prints "No results found."', async () => {
    stubAllAttempts(() => jsonResponse({ results: [] }));

    const { exitCodes, stdout, stderr } = await runCli(['search', 'q']);

    assert.deepEqual(exitCodes, []);
    assert.deepEqual(stderr, []);
    assert.ok(stdout.some(line => line.includes('No results found.')));
  });
});
