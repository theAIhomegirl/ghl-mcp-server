import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { loadEndpoints } from './catalog.ts';
import { loadConfig } from './config.ts';
import { createServer } from './server.ts';

const log = (message: string): void => {
  process.stderr.write(`[ghl-mcp] ${message}\n`);
};

const MAX_BODY_BYTES = 1_000_000;

function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) reject(new Error('Request body too large'));
      else chunks.push(chunk);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        resolve(text ? JSON.parse(text) : undefined);
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function isAuthorized(req: IncomingMessage, expectedToken: string): boolean {
  const header = req.headers.authorization ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '';
  const expected = Buffer.from(expectedToken);
  const actual = Buffer.from(provided);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

const authToken = process.env.MCP_AUTH_TOKEN?.trim();
if (!authToken) {
  // This process holds a live GHL token; never expose it over HTTP without a gate.
  log('MCP_AUTH_TOKEN is required for the HTTP transport. Generate one with: openssl rand -hex 32');
  process.exit(1);
}

const config = loadConfig();
const port = Number(process.env.PORT ?? 3000);
// listen() without a host binds every interface, which put a full-CRM proxy on the
// LAN while the startup line claimed localhost. Loopback unless asked otherwise.
const host = process.env.MCP_BIND_HOST?.trim() || '127.0.0.1';
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '::1']);

// Parsed once: createServer runs per request, and loadEndpoints is a synchronous
// multi-megabyte JSON parse that would block the event loop on every call.
const endpoints = loadEndpoints(config.modules);
const catalog = config.metaTools && config.modules !== 'all' ? loadEndpoints('all') : endpoints;

// DNS rebinding: a hostile page can make a browser resolve its own domain to this
// address, but it cannot forge the Host header. An empty allowedOrigins list is a
// no-op in the SDK, so the Host allowlist is what actually holds.
const allowedHosts = [
  ...new Set([
    `${host}:${port}`,
    `localhost:${port}`,
    `127.0.0.1:${port}`,
    ...(process.env.MCP_ALLOWED_HOSTS?.split(',').map((entry) => entry.trim()).filter(Boolean) ?? []),
  ]),
];

const httpServer = createHttpServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/health') {
    sendJson(res, 200, { ok: true });
    return;
  }
  if (url.pathname !== '/mcp') {
    sendJson(res, 404, { error: 'Not found' });
    return;
  }
  if (!isAuthorized(req, authToken)) {
    sendJson(res, 401, { error: 'Unauthorized' });
    return;
  }
  if (req.method !== 'POST') {
    // Stateless mode: no SSE streams to resume, no sessions to close.
    sendJson(res, 405, { error: 'Method not allowed' });
    return;
  }

  try {
    const body = await readJsonBody(req);
    // A fresh server + transport per request keeps JSON-RPC ids from colliding across clients.
    const server = createServer(config, { endpoints, catalog });
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableDnsRebindingProtection: true,
      allowedHosts,
    });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  } catch (error) {
    log(`Request failed: ${error instanceof Error ? error.message : String(error)}`);
    if (!res.headersSent) sendJson(res, 500, { error: 'Internal server error' });
  }
});

httpServer.listen(port, host, () => {
  log(`Streamable HTTP listening on http://${host}:${port}/mcp`);
  log(`Accepted Host headers: ${allowedHosts.join(', ')} (add more with MCP_ALLOWED_HOSTS).`);
  if (!LOOPBACK_HOSTS.has(host)) {
    log(`MCP_BIND_HOST=${host} exposes this process beyond the machine. Terminate TLS in front of it: the bearer token and every CRM record cross the wire in cleartext otherwise.`);
  }
});
