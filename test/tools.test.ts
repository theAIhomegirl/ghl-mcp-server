import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GhlApiError } from '../src/client.ts';
import type { ServerConfig } from '../src/config.ts';
import type { EndpointDef } from '../src/generator/openapi.ts';
import { blockedReason, CHARACTER_LIMIT, formatError, formatResult, inputSchemaFor, splitArguments } from '../src/tools.ts';

const baseConfig: ServerConfig = {
  apiKey: 'k',
  baseUrl: 'https://example.test',
  modules: ['contacts'],
  allowWrites: false,
  allowDeletes: false,
  metaTools: true,
  includeDeprecated: false,
  locationId: 'LOC1',
};

function endpoint(overrides: Partial<EndpointDef>): EndpointDef {
  return {
    name: 'contacts_x',
    module: 'contacts',
    method: 'POST',
    path: '/contacts/{contactId}',
    version: '2021-07-28',
    summary: 'X',
    description: 'X',
    scopes: ['contacts.write'],
    access: 'location',
    operationClass: 'write',
    deprecated: false,
    contentType: 'application/json',
    pathFields: ['contactId'],
    queryFields: ['locationId'],
    bodyFields: ['locationId', 'name'],
    bodyWrapped: false,
    inputSchema: { type: 'object', properties: { contactId: { type: 'string' }, locationId: { type: 'string' }, name: { type: 'string' } } },
    ...overrides,
  };
}

test('splitArguments injects the default locationId everywhere the spec lists it', () => {
  const split = splitArguments(endpoint({}), { contactId: 'C1', name: 'Kai' }, 'LOC1');
  assert.deepEqual(split.pathParams, { contactId: 'C1' });
  assert.deepEqual(split.query, { locationId: 'LOC1' });
  assert.deepEqual(split.body, { locationId: 'LOC1', name: 'Kai' });
});

test('splitArguments respects an explicit locationId and routes unknown keys into the body', () => {
  const split = splitArguments(endpoint({}), { contactId: 'C1', locationId: 'OTHER', extra: 1 }, 'LOC1');
  assert.deepEqual(split.query, { locationId: 'OTHER' });
  assert.deepEqual(split.body, { locationId: 'OTHER', extra: 1 });
});

test('splitArguments passes wrapped bodies through whole and skips locationId when the spec has none', () => {
  const wrapped = endpoint({ pathFields: ['contactId'], queryFields: [], bodyFields: [], bodyWrapped: true });
  const split = splitArguments(wrapped, { contactId: 'C1', body: ['a', 'b'] }, 'LOC1');
  assert.deepEqual(split.body, ['a', 'b']);
  assert.deepEqual(split.query, {});
});

test('splitArguments treats an explicit null locationId as absent so the default still applies', () => {
  const split = splitArguments(endpoint({}), { contactId: 'C1', locationId: null }, 'LOC1');
  assert.deepEqual(split.query, { locationId: 'LOC1' });
  assert.deepEqual(split.body, { locationId: 'LOC1' });
});

test('splitArguments sends no body for GET endpoints without body fields', () => {
  const read = endpoint({ method: 'GET', bodyFields: [], operationClass: 'read' });
  const split = splitArguments(read, { contactId: 'C1' }, undefined);
  assert.equal(split.body, undefined);
  assert.deepEqual(split.query, {});
});

test('blockedReason gates writes and deletes independently', () => {
  assert.equal(blockedReason('read', baseConfig), undefined);
  assert.match(blockedReason('write', baseConfig) ?? '', /GHL_ALLOW_WRITES/);
  assert.match(blockedReason('delete', { ...baseConfig, allowWrites: true }) ?? '', /GHL_ALLOW_DELETES/);
  assert.equal(blockedReason('delete', { ...baseConfig, allowDeletes: true }), undefined);
});

test('formatResult truncates oversized payloads and keeps structuredContent only when it fits', () => {
  const big = formatResult({ items: 'x'.repeat(CHARACTER_LIMIT + 10) });
  const bigText = big.content[0].type === 'text' ? big.content[0].text : '';
  assert.match(bigText, /Truncated/);
  // structuredContent used to carry the full payload next to the trimmed text, so the
  // cap capped nothing and the model received both copies.
  assert.equal(big.structuredContent, undefined, 'a truncated result must not ship the full payload alongside it');
  assert.ok(bigText.length < CHARACTER_LIMIT + 200, `whole result stays near the cap, got ${bigText.length}`);
  const small = formatResult({ ok: true });
  assert.deepEqual(small.structuredContent, { ok: true });
  assert.equal(formatResult([1, 2]).structuredContent, undefined);
});

test('formatError applies the same character cap as formatResult', () => {
  const result = formatError(new GhlApiError(422, 'Validation failed', { errors: 'y'.repeat(CHARACTER_LIMIT * 2) }));
  const text = result.content[0].type === 'text' ? result.content[0].text : '';
  assert.equal(result.isError, true);
  assert.ok(text.length < CHARACTER_LIMIT + 200, `error text stays near the cap, got ${text.length}`);
  assert.match(text, /Truncated/);
});

test('formatError adds a scope hint on 403 and marks the result as an error', () => {
  const result = formatError(new GhlApiError(403, 'Forbidden', { statusCode: 403 }), endpoint({}));
  assert.equal(result.isError, true);
  const text = result.content[0].type === 'text' ? result.content[0].text : '';
  assert.match(text, /403/);
  assert.match(text, /contacts\.write/);
});

test('inputSchemaFor builds a Zod schema that enforces required fields and caches it', () => {
  const def = endpoint({ inputSchema: { type: 'object', properties: { contactId: { type: 'string' } }, required: ['contactId'] } });
  const schema = inputSchemaFor(def);
  assert.equal(schema, inputSchemaFor(def));
  assert.equal(schema.safeParse({ contactId: 'C1' }).success, true);
  assert.equal(schema.safeParse({}).success, false);
});

test('inputSchemaFor relaxes a required locationId only when a default location exists', () => {
  const def = endpoint({ name: 'contacts_y', inputSchema: { type: 'object', properties: { locationId: { type: 'string' } }, required: ['locationId'] } });
  assert.equal(inputSchemaFor(def).safeParse({}).success, false);
  assert.equal(inputSchemaFor(def, 'LOC1').safeParse({}).success, true);
});
