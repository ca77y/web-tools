/**
 * Exercises the real MCP tool-registration path in `createServer()`
 * (mcp.ts) end to end over an in-memory MCP transport pair — no production
 * source in this package is modified or reimplemented for the test; only
 * `globalThis.fetch` (consumed indirectly by the toolkit's `searchSearXNG`)
 * is stubbed to force the total-failure and genuine-empty cases described
 * in the unit's spec ("Requirement: Transport reporting").
 */
import assert from 'node:assert/strict';
import { afterEach, describe, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createServer } from './mcp.js';

const originalFetch = globalThis.fetch;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Stubs fetch so every parallel SearXNG attempt gets the same response. */
function stubAllAttempts(responder: () => Response | Promise<Response>): void {
  globalThis.fetch = (async () => responder()) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function connectedClient(): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const server = createServer();
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client(
    { name: 'test-client', version: '1.0.0' },
    { capabilities: {} },
  );

  await Promise.all([
    client.connect(clientTransport),
    server.connect(serverTransport),
  ]);

  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

describe('MCP transport reporting - web_search', () => {
  test('an all-attempts-failed web_search returns isError:true with a message naming the failed operation', async () => {
    stubAllAttempts(() => jsonResponse({}, 503));
    const { client, close } = await connectedClient();

    try {
      const result = await client.callTool({
        name: 'web_search',
        arguments: { query: 'q' },
      });

      assert.equal(result.isError, true);
      const content = result.content as Array<{ type: string; text: string }>;
      assert.equal(content.length, 1);
      const parsed = JSON.parse(content[0]!.text) as { error: string };
      assert.match(parsed.error, /search/i);
    } finally {
      await close();
    }
  });

  test('a genuine empty result reports success with zero results and no isError', async () => {
    stubAllAttempts(() => jsonResponse({ results: [] }));
    const { client, close } = await connectedClient();

    try {
      const result = await client.callTool({
        name: 'web_search',
        arguments: { query: 'q' },
      });

      assert.notEqual(result.isError, true);
      const content = result.content as Array<{ type: string; text: string }>;
      const parsed = JSON.parse(content[0]!.text) as unknown[];
      assert.deepEqual(parsed, []);
    } finally {
      await close();
    }
  });
});
