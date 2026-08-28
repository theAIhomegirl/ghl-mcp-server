import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { GhlClient, type GhlRequest } from '../src/client.ts';
import type { ServerConfig } from '../src/config.ts';
import { createServer } from '../src/server.ts';

const baseConfig: ServerConfig = {
  apiKey: 'k',
  baseUrl: 'https://api.test',
  modules: ['contacts'],
  allowWrites: false,
  allowDeletes: false,
  metaTools: true,
  locationId: 'LOC1',
};

function stubClient(handler: (req: GhlRequest) => unknown): { client: GhlClient; requests: GhlRequest[] } {
  const requests: GhlRequest[] = [];
  const client = new GhlClient({ apiKey: 'k', baseUrl: 'https://api.test' });
  client.request = async (req: GhlRequest) => {
    requests.push(req);
    return handler(req);
  };
  return { client, requests };
}

async function connect(config: ServerConfig, client: GhlClient): Promise<Client> {
  const server = createServer(config, { client });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcpClient = new Client({ name: 'test', version: '0.0.0' });
  await mcpClient.connect(clientTransport);
  return mcpClient;
}

function textOf(result: { content: Array<{ type: string; text?: string }> }): string {
  return result.content.map((block) => (block.type === 'text' ? block.text ?? '' : '')).join('');
}

test('read-only config lists only read tools for the module plus the three meta-tools', async () => {
  const { client } = stubClient(() => ({}));
  const mcp = await connect(baseConfig, client);
  const { tools } = await mcp.listTools();
  const names = tools.map((tool) => tool.name);
  assert.ok(names.includes('contacts_get_contact'));
  assert.ok(!names.includes('contacts_create_contact'), 'write tools must be hidden');
  assert.ok(!names.includes('contacts_delete_contact'), 'delete tools must be hidden');
  assert.deepEqual(names.filter((name) => name.startsWith('ghl_')).sort(), ['ghl_call_endpoint', 'ghl_describe_endpoint', 'ghl_search_endpoints']);
  const getContact = tools.find((tool) => tool.name === 'contacts_get_contact');
  assert.equal(getContact?.annotations?.readOnlyHint, true);
  assert.ok((getContact?.inputSchema as { properties?: Record<string, unknown> }).properties?.contactId, 'schema keeps path params');
  await mcp.close();
});

test('enabling writes exposes write tools but still hides deletes', async () => {
  const { client } = stubClient(() => ({}));
  const mcp = await connect({ ...baseConfig, allowWrites: true }, client);
  const names = (await mcp.listTools()).tools.map((tool) => tool.name);
  assert.ok(names.includes('contacts_create_contact'));
  assert.ok(!names.includes('contacts_delete_contact'));
  await mcp.close();
});

test('calling a tool hits the right path with the default locationId injected', async () => {
  const { client, requests } = stubClient(() => ({ contacts: [{ id: 'C1' }] }));
  const mcp = await connect(baseConfig, client);
  const result = await mcp.callTool({ name: 'contacts_get_duplicate_contact', arguments: { email: 'a@b.co' } });
  assert.notEqual(result.isError, true, textOf(result as never));
  assert.equal(requests.length, 1);
  assert.equal(requests[0].method, 'GET');
  assert.equal(requests[0].path, '/contacts/search/duplicate');
  assert.equal(requests[0].version, '2021-07-28');
  assert.deepEqual(requests[0].query, { locationId: 'LOC1', email: 'a@b.co' });
  assert.match(textOf(result as never), /C1/);
  await mcp.close();
});

test('meta-tools search the full catalog and enforce gates on ghl_call_endpoint', async () => {
  const { client, requests } = stubClient(() => ({ ok: true }));
  const mcp = await connect(baseConfig, client);

  const search = await mcp.callTool({ name: 'ghl_search_endpoints', arguments: { query: 'send invoice', module: 'invoices' } });
  const searchText = textOf(search as never);
  assert.match(searchText, /invoices_send_invoice/, 'finds endpoints outside loaded modules');

  const describe = await mcp.callTool({ name: 'ghl_describe_endpoint', arguments: { name: 'invoices_send_invoice' } });
  assert.match(textOf(describe as never), /GHL_ALLOW_WRITES/);

  const blocked = await mcp.callTool({ name: 'ghl_call_endpoint', arguments: { name: 'invoices_send_invoice', arguments: { invoiceId: 'I1' } } });
  assert.equal(blocked.isError, true);
  assert.equal(requests.length, 0, 'blocked calls never reach the API');

  const allowed = await mcp.callTool({ name: 'ghl_call_endpoint', arguments: { name: 'invoices_list_invoices', arguments: { limit: 5 } } });
  assert.equal(allowed.isError, undefined);
  assert.equal(requests[0].path, '/invoices/');
  await mcp.close();
});

test('every generated schema converts to Zod and every tool name is protocol-safe', async () => {
  const { client } = stubClient(() => ({}));
  const mcp = await connect({ ...baseConfig, modules: 'all', allowWrites: true, allowDeletes: true, metaTools: false }, client);
  const { tools } = await mcp.listTools();
  assert.equal(tools.length, 576);
  for (const tool of tools) assert.match(tool.name, /^[a-z0-9_]{1,64}$/);
  await mcp.close();
});
