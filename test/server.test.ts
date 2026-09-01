import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { loadEndpoints } from '../src/catalog.ts';
import { GhlClient, type GhlRequest } from '../src/client.ts';
import { parseBaseUrl, type ServerConfig } from '../src/config.ts';
import { createServer } from '../src/server.ts';

const baseConfig: ServerConfig = {
  apiKey: 'k',
  baseUrl: 'https://api.test',
  modules: ['contacts'],
  allowWrites: false,
  allowDeletes: false,
  metaTools: true,
  includeDeprecated: false,
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

  const allowed = await mcp.callTool({
    name: 'ghl_call_endpoint',
    arguments: { name: 'invoices_list_invoices', arguments: { altId: 'LOC1', altType: 'location', limit: '5', offset: '0' } },
  });
  assert.equal(allowed.isError, undefined);
  assert.equal(requests[0].path, '/invoices/');
  await mcp.close();
});

test('ghl_call_endpoint validates arguments against the endpoint schema', async () => {
  const { client, requests } = stubClient(() => ({ ok: true }));
  const mcp = await connect(baseConfig, client);

  // The meta-tool path used to skip inputSchemaFor entirely, so anything the model
  // invented went straight onto the wire.
  const missing = await mcp.callTool({ name: 'ghl_call_endpoint', arguments: { name: 'invoices_list_invoices', arguments: { limit: '5' } } });
  assert.equal(missing.isError, true);
  assert.match(textOf(missing as never), /altId/);
  assert.equal(requests.length, 0, 'an invalid call never reaches the API');

  // null used to slip past the `=== undefined` guard and silently cancel GHL_LOCATION_ID.
  const nulled = await mcp.callTool({
    name: 'ghl_call_endpoint',
    arguments: { name: 'contacts_get_duplicate_contact', arguments: { locationId: null, number: '12345' } },
  });
  assert.equal(nulled.isError, undefined, textOf(nulled as never));
  assert.equal((requests[0].query as Record<string, unknown>).locationId, 'LOC1');
  await mcp.close();
});

test('overwriting updates are annotated destructive so a client cannot auto-approve them', async () => {
  const { client } = stubClient(() => ({}));
  const mcp = await connect({ ...baseConfig, allowWrites: true }, client);
  const { tools } = await mcp.listTools();
  const update = tools.find((tool) => tool.name === 'contacts_update_contact');
  const create = tools.find((tool) => tool.name === 'contacts_create_contact');
  assert.equal(update?.annotations?.destructiveHint, true, 'PUT overwrites an existing record');
  assert.equal(create?.annotations?.destructiveHint, false, 'POST create is additive');
  await mcp.close();
});

test('deprecated endpoints are hidden unless GHL_INCLUDE_DEPRECATED is set', async () => {
  const { client } = stubClient(() => ({}));
  const hidden = await connect(baseConfig, client);
  assert.ok(!(await hidden.listTools()).tools.some((tool) => tool.name === 'contacts_get_contacts'));
  await hidden.close();

  const shown = await connect({ ...baseConfig, includeDeprecated: true }, client);
  assert.ok((await shown.listTools()).tools.some((tool) => tool.name === 'contacts_get_contacts'));
  await shown.close();
});

test('parseBaseUrl refuses to send the API token anywhere but HighLevel', () => {
  assert.equal(parseBaseUrl(undefined), 'https://services.leadconnectorhq.com');
  assert.equal(parseBaseUrl('https://backend.leadconnectorhq.com/'), 'https://backend.leadconnectorhq.com');
  assert.throws(() => parseBaseUrl('http://services.leadconnectorhq.com'), /https/);
  assert.throws(() => parseBaseUrl('https://evil.tld'), /leadconnectorhq\.com/);
  assert.throws(() => parseBaseUrl('not-a-url'), /valid URL/);
});

test('every generated schema converts to Zod and every tool name is protocol-safe', async () => {
  const { client } = stubClient(() => ({}));
  const mcp = await connect({ ...baseConfig, modules: 'all', allowWrites: true, allowDeletes: true, metaTools: false, includeDeprecated: true }, client);
  const { tools } = await mcp.listTools();
  // Derived from the catalog rather than hardcoded: an upstream spec change should
  // move this number, not break the suite with a message that explains nothing.
  const catalog = loadEndpoints('all');
  assert.equal(tools.length, catalog.length);
  assert.ok(tools.length > 500, `catalog looks truncated: ${tools.length} tools`);
  for (const tool of tools) assert.match(tool.name, /^[a-z0-9_]{1,64}$/);
  await mcp.close();
});

test('every path placeholder has an argument, so no tool is dead on arrival', () => {
  // 11 tools used to throw "Missing required path parameter" on every call because
  // HighLevel's specs omit the id on some methods of a path they declare it on.
  const orphans = loadEndpoints('all').flatMap((endpoint) =>
    [...endpoint.path.matchAll(/\{([^}]+)\}/g)]
      .map((match) => match[1])
      .filter((name) => !endpoint.pathFields.includes(name))
      .map((name) => `${endpoint.name} needs {${name}}`),
  );
  assert.deepEqual(orphans, []);
});
