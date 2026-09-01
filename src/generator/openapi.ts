// Converts HighLevel OpenAPI 3.0 specs into flat endpoint definitions the MCP
// server can register as tools. Pure functions, no I/O, so they are unit-testable.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type ArgLocation = 'path' | 'query' | 'body';
export type OperationClass = 'read' | 'write' | 'delete';
export type AccessLevel = 'location' | 'agency' | 'both' | 'unknown';
export type BodyContentType = 'application/json' | 'application/x-www-form-urlencoded' | 'multipart/form-data';

export type JsonSchema = Record<string, unknown>;

export interface EndpointDef {
  name: string;
  module: string;
  method: HttpMethod;
  path: string;
  /** Value for the required `Version` header, taken from the spec per endpoint. */
  version: string;
  summary: string;
  description: string;
  scopes: string[];
  access: AccessLevel;
  operationClass: OperationClass;
  deprecated: boolean;
  contentType?: BodyContentType;
  pathFields: string[];
  queryFields: string[];
  bodyFields: string[];
  /** True when the request body is not a plain object and is passed whole under the `body` arg. */
  bodyWrapped: boolean;
  inputSchema: JsonSchema;
}

interface OpenApiParameter {
  name: string;
  in: 'path' | 'query' | 'header' | 'cookie';
  required?: boolean;
  description?: string;
  deprecated?: boolean;
  schema?: JsonSchema;
}

interface OpenApiOperation {
  operationId?: string;
  summary?: string;
  description?: string;
  deprecated?: boolean;
  parameters?: OpenApiParameter[];
  requestBody?: { required?: boolean; content?: Record<string, { schema?: JsonSchema }> };
  security?: Array<Record<string, string[]>>;
}

export interface OpenApiSpec {
  paths: Record<string, Record<string, OpenApiOperation | OpenApiParameter[] | undefined>>;
  components?: { schemas?: Record<string, JsonSchema> };
}

export interface ConvertContext {
  spec: OpenApiSpec;
  common: OpenApiSpec;
}

const HTTP_METHODS: HttpMethod[] = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'];
const DEFAULT_VERSION = '2021-07-28';
const MAX_DESCRIPTION_LENGTH = 400;
const MAX_REF_DEPTH = 12;
const VALID_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'object', 'array', 'null']);
const CONTENT_TYPE_PREFERENCE: BodyContentType[] = [
  'application/json',
  'application/x-www-form-urlencoded',
  'multipart/form-data',
];

// Keywords worth carrying into the tool schema. Everything else (examples, xml,
// vendor extensions) is noise that costs the model context without helping it.
const KEPT_KEYWORDS = new Set([
  'type', 'description', 'enum', 'format', 'pattern', 'minimum', 'maximum',
  'minLength', 'maxLength', 'minItems', 'maxItems', 'items', 'properties',
  'required', 'additionalProperties', 'oneOf', 'anyOf', 'deprecated', 'title',
]);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function resolveRef(ref: string, ctx: ConvertContext): JsonSchema | undefined {
  const [file, pointer] = ref.split('#');
  const source = file === '' ? ctx.spec : file.endsWith('common-schemas.json') ? ctx.common : undefined;
  if (!source || !pointer) return undefined;
  const segments = pointer.split('/').filter(Boolean);
  let node: unknown = source;
  for (const segment of segments) {
    if (!isObject(node)) return undefined;
    node = node[segment];
  }
  return isObject(node) ? node : undefined;
}

function refName(ref: string): string {
  return ref.split('/').pop() ?? ref;
}

function mergeAllOf(parts: JsonSchema[]): JsonSchema {
  const merged: JsonSchema = { type: 'object', properties: {}, required: [] as string[] };
  for (const part of parts) {
    if (!isObject(part.properties)) continue;
    Object.assign(merged.properties as Record<string, unknown>, part.properties);
    if (Array.isArray(part.required)) {
      (merged.required as string[]).push(...(part.required as string[]));
    }
    if (typeof part.description === 'string' && !merged.description) merged.description = part.description;
  }
  return merged;
}

/**
 * Turns an OpenAPI schema into plain JSON Schema: refs inlined, allOf merged,
 * `nullable` expressed as a null union, unknown keywords dropped. Recursive refs
 * degrade to an untyped object rather than looping forever.
 */
export function toJsonSchema(schema: JsonSchema | undefined, ctx: ConvertContext, stack: string[] = []): JsonSchema {
  if (!schema || !isObject(schema)) return {};

  if (typeof schema.$ref === 'string') {
    const name = refName(schema.$ref);
    if (stack.includes(name) || stack.length >= MAX_REF_DEPTH) {
      return { type: 'object', description: `${name} (recursive)` };
    }
    const resolved = resolveRef(schema.$ref, ctx);
    if (!resolved) return { description: `Unresolved schema ${name}` };
    return toJsonSchema(resolved, ctx, [...stack, name]);
  }

  if (Array.isArray(schema.allOf)) {
    const parts = (schema.allOf as JsonSchema[]).map((part) => toJsonSchema(part, ctx, stack));
    const merged = parts.every((part) => part.type === 'object') ? mergeAllOf(parts) : parts[0] ?? {};
    const { allOf: _allOf, ...rest } = schema;
    return toJsonSchema({ ...merged, ...rest }, ctx, stack);
  }

  const output: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (KEPT_KEYWORDS.has(key)) output[key] = value;
  }

  if (typeof output.type === 'string' && !VALID_TYPES.has(output.type)) delete output.type;

  if (isObject(output.properties)) {
    const properties: Record<string, JsonSchema> = {};
    for (const [propName, propSchema] of Object.entries(output.properties)) {
      properties[propName] = toJsonSchema(propSchema as JsonSchema, ctx, stack);
    }
    output.properties = properties;
    if (Array.isArray(output.required)) {
      // Specs sometimes require fields they never declare; Zod rejects that.
      output.required = (output.required as string[]).filter((field) => field in properties);
      if ((output.required as string[]).length === 0) delete output.required;
    }
    if (!output.type) output.type = 'object';
  } else {
    delete output.required;
  }

  if (output.type === 'array') {
    output.items = isObject(output.items) ? toJsonSchema(output.items as JsonSchema, ctx, stack) : {};
  } else if ('items' in output) {
    delete output.items;
  }

  if (isObject(output.additionalProperties)) {
    output.additionalProperties = toJsonSchema(output.additionalProperties as JsonSchema, ctx, stack);
  }

  for (const key of ['oneOf', 'anyOf'] as const) {
    if (Array.isArray(output[key])) {
      output[key] = (output[key] as JsonSchema[]).map((variant) => toJsonSchema(variant, ctx, stack));
    }
  }

  if (schema.nullable === true) {
    if (typeof output.type === 'string') output.type = [output.type, 'null'];
    else if (Array.isArray(output.anyOf)) (output.anyOf as JsonSchema[]).push({ type: 'null' });
    else if (Array.isArray(output.oneOf)) (output.oneOf as JsonSchema[]).push({ type: 'null' });
  }

  if (schema.default !== undefined) {
    // Surface the default in prose instead of the schema so the tool only sends args the model chose.
    const note = `(default: ${JSON.stringify(schema.default)})`;
    output.description = output.description ? `${output.description} ${note}` : note;
  }

  return output;
}

/** Every `{name}` placeholder in a path template, in the order it appears. */
export function pathPlaceholders(path: string): string[] {
  return [...path.matchAll(/\{([^}]+)\}/g)].map((match) => match[1]);
}

// A multipart file part cannot travel as a JSON string, so binary fields are
// described (and accepted) as an explicit base64 envelope instead.
const BINARY_FIELD_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    base64: { type: 'string', description: 'File contents, base64-encoded.' },
    filename: { type: 'string', description: 'File name to send with the upload part.' },
    contentType: { type: 'string', description: 'MIME type of the file. Defaults to application/octet-stream.' },
  },
  required: ['base64'],
};

function isBinaryField(schema: JsonSchema): boolean {
  return schema.type === 'string' && schema.format === 'binary';
}

export function toToolName(module: string, operationId: string): string {
  return `${module}_${operationId}`
    .replace(/[^a-zA-Z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toLowerCase();
}

// POSTs that only query data (search bodies too large for a query string). oauth is
// excluded on purpose: its get-*-token endpoints mint credentials.
const READ_LIKE_POST = /^(search|get|list|fetch|find|query|validate)[-_]/i;

function classifyOperation(method: HttpMethod, operationId: string, module: string): OperationClass {
  if (method === 'GET') return 'read';
  if (method === 'DELETE' || /^(delete|remove)[-_]/i.test(operationId)) return 'delete';
  if (method === 'POST' && module !== 'oauth' && READ_LIKE_POST.test(operationId)) return 'read';
  return 'write';
}

function accessLevel(security: OpenApiOperation['security']): { access: AccessLevel; scopes: string[] } {
  const schemes = new Set<string>();
  const scopes = new Set<string>();
  for (const requirement of security ?? []) {
    for (const [scheme, schemeScopes] of Object.entries(requirement)) {
      schemes.add(scheme);
      schemeScopes.forEach((scope) => scopes.add(scope));
    }
  }
  const location = schemes.has('Location-Access') || schemes.has('Location-Access-Only');
  const agency = schemes.has('Agency-Access') || schemes.has('Agency-Access-Only');
  const access: AccessLevel = location && agency ? 'both' : location ? 'location' : agency ? 'agency' : 'unknown';
  return { access, scopes: [...scopes].sort() };
}

function truncate(text: string, max: number): string {
  const singleLine = text.replace(/\s+/g, ' ').trim();
  return singleLine.length <= max ? singleLine : `${singleLine.slice(0, max - 1)}…`;
}

function pickBody(operation: OpenApiOperation): { contentType: BodyContentType; schema: JsonSchema } | undefined {
  const content = operation.requestBody?.content;
  if (!content) return undefined;
  for (const contentType of CONTENT_TYPE_PREFERENCE) {
    const entry = content[contentType];
    if (entry?.schema) return { contentType, schema: entry.schema };
  }
  return undefined;
}

export function convertOperation(
  module: string,
  path: string,
  method: HttpMethod,
  operation: OpenApiOperation,
  pathLevelParams: OpenApiParameter[],
  ctx: ConvertContext,
): EndpointDef {
  const operationId = operation.operationId ?? `${method.toLowerCase()}_${path}`;
  const properties: Record<string, JsonSchema> = {};
  const required = new Set<string>();
  const pathFields: string[] = [];
  const queryFields: string[] = [];
  const bodyFields: string[] = [];
  let version = DEFAULT_VERSION;

  const parameters = [...pathLevelParams, ...(operation.parameters ?? [])];
  for (const parameter of parameters) {
    if (parameter.in === 'header') {
      const versionEnum = parameter.schema?.enum;
      if (parameter.name === 'Version' && Array.isArray(versionEnum) && typeof versionEnum[0] === 'string') {
        version = versionEnum[0];
      }
      continue;
    }
    if (parameter.in === 'cookie') continue;
    const schema = toJsonSchema(parameter.schema, ctx);
    if (parameter.description && !schema.description) schema.description = truncate(parameter.description, 300);
    properties[parameter.name] = schema;
    if (parameter.in === 'path') {
      pathFields.push(parameter.name);
      required.add(parameter.name);
    } else {
      queryFields.push(parameter.name);
      if (parameter.required) required.add(parameter.name);
    }
  }

  // HighLevel's specs sometimes declare a path parameter on one method of a path and
  // forget it on the others, which would ship a tool with nowhere to put the ID. The
  // URL template is the authority: anything it names has to be an argument.
  for (const placeholder of pathPlaceholders(path)) {
    if (pathFields.includes(placeholder)) continue;
    pathFields.push(placeholder);
    required.add(placeholder);
    if (!(placeholder in properties)) {
      properties[placeholder] = {
        type: 'string',
        description: `Path parameter "${placeholder}", recovered from the URL template because the spec omits it.`,
      };
    }
  }

  const body = pickBody(operation);
  let bodyWrapped = false;
  if (body) {
    const bodySchema = toJsonSchema(body.schema, ctx);
    const bodyProperties = isObject(bodySchema.properties) ? (bodySchema.properties as Record<string, JsonSchema>) : undefined;
    if (bodyProperties && Object.keys(bodyProperties).length > 0) {
      for (const [fieldName, fieldSchema] of Object.entries(bodyProperties)) {
        // A field that is also a path/query param keeps the param schema; the value is sent to both places.
        if (!(fieldName in properties)) {
          properties[fieldName] = isBinaryField(fieldSchema)
            ? { ...BINARY_FIELD_SCHEMA, description: fieldSchema.description ?? `Binary contents for "${fieldName}".` }
            : fieldSchema;
        }
        bodyFields.push(fieldName);
      }
      for (const field of (bodySchema.required as string[] | undefined) ?? []) required.add(field);
    } else {
      bodyWrapped = true;
      properties.body = { ...bodySchema, description: bodySchema.description ?? 'Full request body' };
      if (operation.requestBody?.required) required.add('body');
    }
  }

  const { access, scopes } = accessLevel(operation.security);
  const summary = truncate(operation.summary ?? operationId, 120);
  const descriptionParts = [summary];
  const longDescription = truncate(operation.description ?? '', MAX_DESCRIPTION_LENGTH);
  // Specs often open the description by repeating the summary; keep only the new part.
  const remainder = longDescription.startsWith(summary) ? longDescription.slice(summary.length).trim() : longDescription;
  if (remainder) descriptionParts.push(remainder);
  descriptionParts.push(`[${method} ${path}]`);
  if (access !== 'unknown') descriptionParts.push(`Token: ${access === 'both' ? 'location or agency' : access}.`);
  if (scopes.length) descriptionParts.push(`Scopes: ${scopes.join(', ')}.`);
  if (operation.deprecated) descriptionParts.push('DEPRECATED.');

  const inputSchema: JsonSchema = { type: 'object', properties };
  if (required.size) inputSchema.required = [...required];

  return {
    name: toToolName(module, operationId),
    module,
    method,
    path,
    version,
    summary,
    description: descriptionParts.join(' '),
    scopes,
    access,
    operationClass: classifyOperation(method, operationId, module),
    deprecated: operation.deprecated === true,
    contentType: body?.contentType,
    pathFields,
    queryFields,
    bodyFields,
    bodyWrapped,
    inputSchema,
  };
}

export function convertSpec(module: string, spec: OpenApiSpec, common: OpenApiSpec): EndpointDef[] {
  const ctx: ConvertContext = { spec, common };
  const endpoints: EndpointDef[] = [];
  const seenNames = new Set<string>();

  for (const [path, pathItem] of Object.entries(spec.paths)) {
    const pathLevelParams = Array.isArray(pathItem.parameters) ? (pathItem.parameters as OpenApiParameter[]) : [];
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method.toLowerCase()];
      if (!operation || Array.isArray(operation)) continue;
      const endpoint = convertOperation(module, path, method, operation, pathLevelParams, ctx);
      let name = endpoint.name;
      for (let suffix = 2; seenNames.has(name); suffix += 1) name = `${endpoint.name}_${suffix}`;
      seenNames.add(name);
      endpoints.push({ ...endpoint, name });
    }
  }
  return endpoints;
}
