import { test } from 'node:test';
import assert from 'node:assert/strict';
import { convertOperation, convertSpec, pathPlaceholders, toJsonSchema, toToolName, type ConvertContext, type OpenApiSpec } from '../src/generator/openapi.ts';

const common: OpenApiSpec = {
  paths: {},
  components: { schemas: { BadRequestDTO: { type: 'object', properties: { message: { type: 'string' } } } } },
};

const spec: OpenApiSpec = {
  paths: {},
  components: {
    schemas: {
      Address: { type: 'object', properties: { city: { type: 'string', example: 'Austin' } }, required: ['city', 'ghost'] },
      Node: { type: 'object', properties: { child: { $ref: '#/components/schemas/Node' } } },
      Base: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
    },
  },
};
const ctx: ConvertContext = { spec, common };

test('toJsonSchema inlines refs, strips examples, and drops undeclared required fields', () => {
  const schema = toJsonSchema({ $ref: '#/components/schemas/Address' }, ctx);
  assert.deepEqual(schema, { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] });
});

test('toJsonSchema resolves common-schemas refs', () => {
  const schema = toJsonSchema({ $ref: '../common/common-schemas.json#/components/schemas/BadRequestDTO' }, ctx);
  assert.equal((schema.properties as Record<string, unknown>).message !== undefined, true);
});

test('toJsonSchema expresses nullable as a null union and moves defaults into the description', () => {
  const schema = toJsonSchema({ type: 'string', nullable: true, default: 'x', description: 'Name' }, ctx);
  assert.deepEqual(schema, { type: ['string', 'null'], description: 'Name (default: "x")' });
});

test('toJsonSchema merges allOf object parts', () => {
  const schema = toJsonSchema(
    { allOf: [{ $ref: '#/components/schemas/Base' }, { type: 'object', properties: { name: { type: 'string' } } }] },
    ctx,
  );
  assert.deepEqual(Object.keys(schema.properties as object).sort(), ['id', 'name']);
  assert.deepEqual(schema.required, ['id']);
});

test('toJsonSchema stops on recursive refs and drops invalid types', () => {
  const recursive = toJsonSchema({ $ref: '#/components/schemas/Node' }, ctx);
  const child = (recursive.properties as Record<string, Record<string, unknown>>).child;
  assert.equal(child.type, 'object');
  assert.match(String(child.description), /recursive/);

  const invalid = toJsonSchema({ type: 'country', description: 'x' }, ctx);
  assert.deepEqual(invalid, { description: 'x' });
});

test('toToolName is snake_case and module-prefixed', () => {
  assert.equal(toToolName('social-media-posting', 'get-Posts'), 'social_media_posting_get_posts');
});

test('convertOperation recovers path params the spec forgot to declare', () => {
  // HighLevel declares userId on GET /users/{userId} and omits it on PUT and DELETE.
  const endpoint = convertOperation('users', '/users/{userId}', 'PUT', { operationId: 'update-user' }, [], ctx);
  assert.deepEqual(endpoint.pathFields, ['userId']);
  assert.deepEqual(endpoint.inputSchema.required, ['userId']);
  assert.match(String((endpoint.inputSchema.properties as Record<string, Record<string, unknown>>).userId.description), /recovered from the URL template/);
});

test('convertOperation keeps a declared path param over the recovered one', () => {
  const declared = { name: 'noteId', in: 'path' as const, required: true, description: 'Note id', schema: { type: 'string' } };
  const endpoint = convertOperation('calendars', '/calendars/{appointmentId}/notes/{noteId}', 'PUT', { operationId: 'x', parameters: [declared] }, [], ctx);
  assert.deepEqual(endpoint.pathFields.sort(), ['appointmentId', 'noteId']);
  const props = endpoint.inputSchema.properties as Record<string, Record<string, unknown>>;
  assert.equal(props.noteId.description, 'Note id');
  assert.match(String(props.appointmentId.description), /recovered/);
});

test('pathPlaceholders reads every placeholder in a template', () => {
  assert.deepEqual(pathPlaceholders('/calendars/{appointmentId}/notes/{noteId}'), ['appointmentId', 'noteId']);
  assert.deepEqual(pathPlaceholders('/invoices/'), []);
});

test('convertOperation turns a multipart binary field into a base64 envelope', () => {
  const operation = {
    operationId: 'upload-media',
    requestBody: { content: { 'multipart/form-data': { schema: { type: 'object', properties: { file: { type: 'string', format: 'binary' }, name: { type: 'string' } } } } } },
  };
  const endpoint = convertOperation('medias', '/medias/upload-file', 'POST', operation, [], ctx);
  const file = (endpoint.inputSchema.properties as Record<string, Record<string, unknown>>).file;
  assert.equal(file.type, 'object');
  assert.deepEqual(file.required, ['base64']);
  assert.equal((endpoint.inputSchema.properties as Record<string, Record<string, unknown>>).name.type, 'string');
});

test('convertOperation routes params, reads Version, flattens body, and classifies', () => {
  const endpoint = convertOperation(
    'contacts',
    '/contacts/{contactId}/notes',
    'POST',
    {
      operationId: 'create-note',
      summary: 'Create Note',
      description: 'Create Note for a contact.',
      parameters: [
        { name: 'Version', in: 'header', required: true, schema: { type: 'string', enum: ['2021-04-15'] } },
        { name: 'contactId', in: 'path', required: true, schema: { type: 'string' } },
        { name: 'locationId', in: 'query', required: true, schema: { type: 'string' } },
      ],
      requestBody: {
        required: true,
        content: { 'application/json': { schema: { type: 'object', properties: { body: { type: 'string' }, locationId: { type: 'string' } }, required: ['body'] } } },
      },
      security: [{ 'Location-Access': ['contacts.write'] }],
    },
    [],
    ctx,
  );
  assert.equal(endpoint.name, 'contacts_create_note');
  assert.equal(endpoint.version, '2021-04-15');
  assert.deepEqual(endpoint.pathFields, ['contactId']);
  assert.deepEqual(endpoint.queryFields, ['locationId']);
  assert.deepEqual(endpoint.bodyFields, ['body', 'locationId']);
  assert.equal(endpoint.bodyWrapped, false);
  assert.deepEqual([...(endpoint.inputSchema.required as string[])].sort(), ['body', 'contactId', 'locationId']);
  assert.equal(endpoint.operationClass, 'write');
  assert.equal(endpoint.access, 'location');
  assert.deepEqual(endpoint.scopes, ['contacts.write']);
  assert.equal(endpoint.description, 'Create Note for a contact. [POST /contacts/{contactId}/notes] Token: location. Scopes: contacts.write.');
});

test('convertOperation wraps non-object bodies and treats remove-* POSTs as deletes', () => {
  const endpoint = convertOperation(
    'contacts',
    '/contacts/{contactId}/tags',
    'POST',
    {
      operationId: 'remove-tags',
      parameters: [{ name: 'contactId', in: 'path', required: true, schema: { type: 'string' } }],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'array', items: { type: 'string' } } } } },
    },
    [],
    ctx,
  );
  assert.equal(endpoint.bodyWrapped, true);
  assert.equal((endpoint.inputSchema.properties as Record<string, Record<string, unknown>>).body.type, 'array');
  assert.deepEqual(endpoint.inputSchema.required, ['contactId', 'body']);
  assert.equal(endpoint.operationClass, 'delete');
});

test('convertSpec uses path-level parameters and de-duplicates names', () => {
  const endpoints = convertSpec(
    'users',
    {
      paths: {
        '/users/{id}': {
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
          get: { operationId: 'get-user' },
          delete: { operationId: 'get-user' },
        },
      },
    },
    common,
  );
  assert.deepEqual(endpoints.map((endpoint) => endpoint.name), ['users_get_user', 'users_get_user_2']);
  assert.deepEqual(endpoints[0].pathFields, ['id']);
  assert.equal(endpoints[1].operationClass, 'delete');
});

test('convertOperation treats search-style POSTs as reads, except oauth token minting', () => {
  const searchOp = { operationId: 'search-contacts-advanced', requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { query: { type: 'string' } } } } } } };
  assert.equal(convertOperation('contacts', '/contacts/search', 'POST', searchOp, [], ctx).operationClass, 'read');
  const tokenOp = { operationId: 'get-access-token' };
  assert.equal(convertOperation('oauth', '/oauth/token', 'POST', tokenOp, [], ctx).operationClass, 'write');
  const createOp = { operationId: 'create-contact' };
  assert.equal(convertOperation('contacts', '/contacts/', 'POST', createOp, [], ctx).operationClass, 'write');
});
