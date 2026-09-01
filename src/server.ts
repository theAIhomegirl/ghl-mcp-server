import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { loadEndpoints } from './catalog.ts';
import { GhlClient } from './client.ts';
import type { ServerConfig } from './config.ts';
import type { EndpointDef } from './generator/openapi.ts';
import { registerMetaTools } from './meta-tools.ts';
import { registerEndpointTools } from './tools.ts';

export const SERVER_NAME = 'ghl-mcp-server';
export const SERVER_VERSION = '0.1.0';

export interface CreateServerOptions {
  client?: GhlClient;
  log?: (message: string) => void;
  /** Preloaded module endpoints. The HTTP transport builds a server per request; without
   *  this, every request re-parses the whole generated catalog on the event loop. */
  endpoints?: EndpointDef[];
  /** Preloaded full catalog for the meta-tools. */
  catalog?: EndpointDef[];
}

export function createServer(config: ServerConfig, options: CreateServerOptions = {}): McpServer {
  const client = options.client ?? new GhlClient({ apiKey: config.apiKey, baseUrl: config.baseUrl });
  const log = options.log ?? (() => {});

  const selected = options.endpoints ?? loadEndpoints(config.modules);
  const gates = [
    `writes ${config.allowWrites ? 'enabled' : 'disabled'}`,
    `deletes ${config.allowDeletes ? 'enabled' : 'disabled'}`,
  ].join(', ');

  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions: [
        'GoHighLevel API server generated from HighLevel\'s official OpenAPI specs.',
        `Loaded modules: ${config.modules === 'all' ? 'all' : config.modules.join(', ')}. Safety gates: ${gates}.`,
        config.locationId
          ? `locationId defaults to ${config.locationId} when omitted.`
          : 'No default location is configured; pass locationId explicitly.',
        config.metaTools
          ? 'Use ghl_search_endpoints to discover endpoints outside the loaded modules, then ghl_call_endpoint to run them.'
          : '',
      ].filter(Boolean).join(' '),
    },
  );

  const registered = registerEndpointTools(server, selected, client, config);
  log(`Registered ${registered} of ${selected.length} endpoint tools (${gates}).`);

  if (config.metaTools) {
    const catalog = options.catalog ?? (config.modules === 'all' ? selected : loadEndpoints('all'));
    registerMetaTools(server, catalog, client, config);
    log(`Meta-tools cover ${catalog.length} endpoints.`);
  }

  return server;
}
