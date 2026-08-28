#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.ts';
import { createServer } from './server.ts';

// stdout is the MCP wire; every log line must go to stderr.
const log = (message: string): void => {
  process.stderr.write(`[ghl-mcp] ${message}\n`);
};

try {
  const config = loadConfig();
  const server = createServer(config, { log });
  await server.connect(new StdioServerTransport());
  log('Ready on stdio.');
} catch (error) {
  log(error instanceof Error ? error.message : String(error));
  process.exit(1);
}
