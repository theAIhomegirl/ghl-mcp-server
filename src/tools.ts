import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { GhlApiError, type GhlClient } from './client.ts';
import type { ServerConfig } from './config.ts';
import type { EndpointDef, OperationClass } from './generator/openapi.ts';

// Keeps a single tool response from flooding the model's context window.
export const CHARACTER_LIMIT = 50_000;

type ToolArgs = Record<string, unknown>;

const schemaCache = new Map<string, z.ZodType>();

/**
 * Builds the Zod schema the SDK validates against. The SDK rejects calls before
 * the handler runs, so a required locationId must be relaxed here (not in the
 * handler) whenever a default location will be injected.
 */
export function inputSchemaFor(endpoint: EndpointDef, defaultLocationId?: string): z.ZodType {
  const declared = endpoint.inputSchema.properties as Record<string, Record<string, unknown>> | undefined;
  const relaxLocation = Boolean(defaultLocationId) && Boolean(declared?.locationId);
  const cacheKey = `${endpoint.name}${relaxLocation ? ':default-location' : ''}`;
  let schema = schemaCache.get(cacheKey);
  if (!schema) {
    let jsonSchema = endpoint.inputSchema;
    if (relaxLocation) {
      const properties = { ...(declared as Record<string, Record<string, unknown>>) };
      const locationSchema = properties.locationId ?? {};
      properties.locationId = {
        ...locationSchema,
        // An explicit null is how a model says "I don't have one". Accepting it here is
        // what lets splitArguments fall back to the default instead of failing or, as
        // before, dropping the field and calling the API with no location at all.
        ...(typeof locationSchema.type === 'string' ? { type: [locationSchema.type, 'null'] } : {}),
        description: `${locationSchema.description ? `${locationSchema.description} ` : ''}(defaults to ${defaultLocationId} when omitted)`,
      };
      const required = ((jsonSchema.required as string[] | undefined) ?? []).filter((field) => field !== 'locationId');
      jsonSchema = { ...jsonSchema, properties, ...(required.length ? { required } : {}) };
      if (!required.length) delete jsonSchema.required;
    }
    schema = z.fromJSONSchema(jsonSchema as Parameters<typeof z.fromJSONSchema>[0]);
    schemaCache.set(cacheKey, schema);
  }
  return schema;
}

export function blockedReason(operationClass: OperationClass, config: ServerConfig): string | undefined {
  if (operationClass === 'write' && !config.allowWrites) {
    return 'Write operations are disabled. Set GHL_ALLOW_WRITES=true to enable POST/PUT/PATCH tools.';
  }
  if (operationClass === 'delete' && !config.allowDeletes) {
    return 'Delete operations are disabled. Set GHL_ALLOW_DELETES=true to enable them.';
  }
  return undefined;
}

export function isEndpointAllowed(endpoint: EndpointDef, config: ServerConfig): boolean {
  return blockedReason(endpoint.operationClass, config) === undefined;
}

export interface SplitArguments {
  pathParams: Record<string, unknown>;
  query: Record<string, unknown>;
  body?: unknown;
}

/**
 * Routes flat tool arguments back to their wire location. A field the spec lists
 * in more than one place (typically locationId) is sent to each of them.
 */
export function splitArguments(endpoint: EndpointDef, args: ToolArgs, defaultLocationId?: string): SplitArguments {
  const values: ToolArgs = { ...args };
  const takesLocationId = ['pathFields', 'queryFields', 'bodyFields'].some((key) =>
    (endpoint[key as 'pathFields' | 'queryFields' | 'bodyFields']).includes('locationId'),
  );
  // An explicit null is "no value", not a value: without this it silently beat the
  // configured default and the request left with no locationId at all.
  if (takesLocationId && (values.locationId === undefined || values.locationId === null) && defaultLocationId) {
    values.locationId = defaultLocationId;
  }

  const pathParams: Record<string, unknown> = {};
  const query: Record<string, unknown> = {};
  const bodyFields: Record<string, unknown> = {};
  let body: unknown;
  const hasBody = endpoint.bodyWrapped || endpoint.bodyFields.length > 0;

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) continue;
    let routed = false;
    if (endpoint.pathFields.includes(key)) {
      pathParams[key] = value;
      routed = true;
    }
    if (endpoint.queryFields.includes(key)) {
      query[key] = value;
      routed = true;
    }
    if (endpoint.bodyWrapped && key === 'body') {
      body = value;
      routed = true;
    } else if (endpoint.bodyFields.includes(key)) {
      bodyFields[key] = value;
      routed = true;
    }
    if (!routed) {
      // Unknown keys most likely belong to a newer body shape than the spec describes.
      if (hasBody && !endpoint.bodyWrapped) bodyFields[key] = value;
      else query[key] = value;
    }
  }

  if (!endpoint.bodyWrapped && hasBody) body = bodyFields;
  return { pathParams, query, body };
}

function truncate(text: string, note: string): { text: string; truncated: boolean } {
  if (text.length <= CHARACTER_LIMIT) return { text, truncated: false };
  return { text: `${text.slice(0, CHARACTER_LIMIT)}\n\n[Truncated at ${CHARACTER_LIMIT} characters. ${note}]`, truncated: true };
}

export function formatResult(data: unknown): CallToolResult {
  const raw = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
  const { text, truncated } = truncate(raw, 'Narrow the request with filters, a smaller limit, or pagination.');
  // structuredContent used to carry the untruncated payload alongside the trimmed
  // text, so both reached the model and the cap capped nothing. A truncated result
  // has no faithful structured form, so it ships as text only.
  const structuredContent = !truncated && typeof data === 'object' && data !== null && !Array.isArray(data)
    ? (data as Record<string, unknown>)
    : undefined;
  return { content: [{ type: 'text', text }], structuredContent };
}

export function formatError(error: unknown, endpoint?: EndpointDef): CallToolResult {
  let text: string;
  if (error instanceof GhlApiError) {
    const hints: Record<number, string> = {
      401: 'The token is invalid or expired. Check GHL_API_KEY.',
      403: `The token lacks a required scope${endpoint?.scopes.length ? ` (${endpoint.scopes.join(', ')})` : ''}. Enable it on the Private Integration and retry.`,
      404: 'Resource not found. Verify the ID and that it belongs to this location.',
      422: 'The API rejected the payload. Check required fields and value formats in the error details.',
      429: 'Rate limited by GHL. Wait a moment and retry.',
    };
    const hint = hints[error.status] ?? '';
    const details = error.details && typeof error.details === 'object' ? `\nDetails: ${JSON.stringify(error.details)}` : '';
    text = `GHL API error ${error.status}: ${error.message}. ${hint}${details}`.trim();
  } else {
    text = `Error: ${error instanceof Error ? error.message : String(error)}`;
  }
  // A bulk validation error or an HTML proxy page can dwarf a successful response;
  // the same cap has to apply here or the error path becomes the way to flood context.
  return { content: [{ type: 'text', text: truncate(text, 'Error body cut short.').text }], isError: true };
}

export async function executeEndpoint(
  endpoint: EndpointDef,
  args: ToolArgs,
  client: GhlClient,
  config: ServerConfig,
): Promise<CallToolResult> {
  const blocked = blockedReason(endpoint.operationClass, config);
  if (blocked) return formatError(new Error(blocked));
  try {
    // Dedicated tools are validated by the SDK before their handler runs, but
    // ghl_call_endpoint arrives here with whatever the model invented. Validating in
    // this one place covers both routes, so no endpoint is reachable unvalidated.
    const parsed = inputSchemaFor(endpoint, config.locationId).safeParse(args);
    if (!parsed.success) {
      return formatError(new Error(`Invalid arguments for ${endpoint.name}: ${z.prettifyError(parsed.error)}`), endpoint);
    }
    const { pathParams, query, body } = splitArguments(endpoint, parsed.data as ToolArgs, config.locationId);
    const data = await client.request({
      method: endpoint.method,
      path: endpoint.path,
      version: endpoint.version,
      pathParams,
      query,
      body,
      contentType: endpoint.contentType,
    });
    return formatResult(data);
  } catch (error) {
    return formatError(error, endpoint);
  }
}

export function registerEndpointTools(
  server: McpServer,
  endpoints: EndpointDef[],
  client: GhlClient,
  config: ServerConfig,
): number {
  let registered = 0;
  for (const endpoint of endpoints) {
    // Hidden rather than merely blocked, so disabled classes cost no context at all.
    if (!isEndpointAllowed(endpoint, config)) continue;
    // Deprecated endpoints are not offered as a normal choice. They stay reachable
    // through ghl_call_endpoint, or set GHL_INCLUDE_DEPRECATED=true to list them again.
    if (endpoint.deprecated && !config.includeDeprecated) continue;
    server.registerTool(
      endpoint.name,
      {
        title: endpoint.summary,
        description: endpoint.description,
        inputSchema: inputSchemaFor(endpoint, config.locationId),
        annotations: {
          readOnlyHint: endpoint.operationClass === 'read',
          // Per the MCP spec destructiveHint:false promises additive updates only, so a
          // PUT/PATCH that overwrites an existing record has to be flagged alongside DELETE.
          // A client on auto-approve reads this before it decides whether to ask.
          destructiveHint: endpoint.operationClass === 'delete' || ['PUT', 'PATCH'].includes(endpoint.method),
          idempotentHint: ['GET', 'PUT', 'DELETE'].includes(endpoint.method),
          openWorldHint: true,
        },
      },
      async (args: unknown) => executeEndpoint(endpoint, (args ?? {}) as ToolArgs, client, config),
    );
    registered += 1;
  }
  return registered;
}
