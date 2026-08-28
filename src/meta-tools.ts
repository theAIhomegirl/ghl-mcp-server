import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { GhlClient } from './client.ts';
import type { ServerConfig } from './config.ts';
import type { EndpointDef } from './generator/openapi.ts';
import { blockedReason, executeEndpoint, formatError, formatResult } from './tools.ts';

const DEFAULT_SEARCH_LIMIT = 20;
const MAX_SEARCH_LIMIT = 100;

export interface SearchOptions {
  query: string;
  module?: string;
  method?: string;
  limit?: number;
}

function tokenize(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((token) => token.length > 1);
}

function score(endpoint: EndpointDef, terms: string[]): number {
  const name = endpoint.name.toLowerCase();
  const summary = endpoint.summary.toLowerCase();
  const path = endpoint.path.toLowerCase();
  const description = endpoint.description.toLowerCase();
  let total = 0;
  for (const term of terms) {
    if (name.includes(term)) total += 3;
    if (summary.includes(term)) total += 2;
    if (path.includes(term)) total += 1;
    if (description.includes(term)) total += 1;
  }
  return total;
}

export function searchEndpoints(endpoints: EndpointDef[], options: SearchOptions): EndpointDef[] {
  const terms = tokenize(options.query);
  const method = options.method?.toUpperCase();
  const module = options.module?.toLowerCase().replace(/_/g, '-');
  const limit = Math.min(options.limit ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT);

  return endpoints
    .filter((endpoint) => !module || endpoint.module === module)
    .filter((endpoint) => !method || endpoint.method === method)
    .map((endpoint) => ({ endpoint, score: terms.length ? score(endpoint, terms) : 1 }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.endpoint.name.localeCompare(b.endpoint.name))
    .slice(0, limit)
    .map((entry) => entry.endpoint);
}

export function registerMetaTools(
  server: McpServer,
  catalog: EndpointDef[],
  client: GhlClient,
  config: ServerConfig,
): void {
  const byName = new Map(catalog.map((endpoint) => [endpoint.name, endpoint]));
  const modules = [...new Set(catalog.map((endpoint) => endpoint.module))].sort();

  server.registerTool(
    'ghl_search_endpoints',
    {
      title: 'Search GHL endpoints',
      description: `Find GoHighLevel API endpoints by keyword across all ${catalog.length} endpoints in ${modules.length} modules, including ones not loaded as dedicated tools. Returns tool names to pass to ghl_describe_endpoint / ghl_call_endpoint. Modules: ${modules.join(', ')}.`,
      inputSchema: z.object({
        query: z.string().describe('Keywords, e.g. "invoice send", "calendar free slots", "workflow"'),
        module: z.string().optional().describe('Restrict to one module, e.g. "invoices"'),
        method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
        limit: z.number().int().min(1).max(MAX_SEARCH_LIMIT).optional().describe(`Max results (default ${DEFAULT_SEARCH_LIMIT})`),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async (args) => {
      const results = searchEndpoints(catalog, args).map((endpoint) => ({
        name: endpoint.name,
        method: endpoint.method,
        path: endpoint.path,
        summary: endpoint.summary,
        operationClass: endpoint.operationClass,
        blocked: blockedReason(endpoint.operationClass, config),
      }));
      return formatResult({ count: results.length, results });
    },
  );

  server.registerTool(
    'ghl_describe_endpoint',
    {
      title: 'Describe a GHL endpoint',
      description: 'Return the full input schema, required fields, auth scopes, and HTTP details for one endpoint by tool name.',
      inputSchema: z.object({ name: z.string().describe('Tool name from ghl_search_endpoints') }),
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ name }) => {
      const endpoint = byName.get(name);
      if (!endpoint) return formatError(new Error(`Unknown endpoint "${name}". Use ghl_search_endpoints to find the exact name.`));
      const { inputSchema, ...details } = endpoint;
      return formatResult({ ...details, blocked: blockedReason(endpoint.operationClass, config), inputSchema });
    },
  );

  server.registerTool(
    'ghl_call_endpoint',
    {
      title: 'Call any GHL endpoint',
      description: 'Execute any endpoint by tool name with a flat arguments object (path, query, and body fields all at top level; see ghl_describe_endpoint). Subject to the same write/delete gates as dedicated tools.',
      inputSchema: z.object({
        name: z.string().describe('Tool name from ghl_search_endpoints'),
        arguments: z.record(z.string(), z.unknown()).optional().describe('Flat arguments matching the endpoint input schema'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
    },
    async ({ name, arguments: args }) => {
      const endpoint = byName.get(name);
      if (!endpoint) return formatError(new Error(`Unknown endpoint "${name}". Use ghl_search_endpoints to find the exact name.`));
      return executeEndpoint(endpoint, args ?? {}, client, config);
    },
  );
}
