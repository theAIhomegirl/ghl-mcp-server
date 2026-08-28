# ghl-mcp-server

A GoHighLevel MCP server with **all 576 public API endpoints**, generated straight from
HighLevel's official OpenAPI specs. The official HighLevel MCP exposes ~36 tools; this
one covers every endpoint in the public docs and stays current with one command.

- **Generated, not hand-written.** `npm run generate` turns `specs/*.json` into tool
  definitions. When HighLevel updates their docs, re-fetch and regenerate.
- **Context-friendly.** Load only the modules you need (`GHL_MODULES`), and use three
  meta-tools (`ghl_search_endpoints`, `ghl_describe_endpoint`, `ghl_call_endpoint`) to
  reach everything else on demand.
- **Safe by default.** Writes and deletes are off until you enable them. Disabled tools
  are hidden from the client entirely, not just blocked.
- **Public API only.** Private Integration Token auth, no undocumented endpoints, no
  browser-session tokens.

## Setup

```bash
npm install
npm run specs:fetch   # downloads HighLevel's OpenAPI specs into ./specs
npm run generate      # builds ./generated/*.json (576 endpoints, validated through Zod)
npm run build
cp .env.example .env  # then fill in GHL_API_KEY and GHL_LOCATION_ID
```

Get a **Private Integration Token** in GHL: sub-account → Settings → Private Integrations →
Create. Enable the scopes for the endpoints you plan to use (e.g. `contacts.readonly`,
`contacts.write`). Every tool description lists the scopes it needs.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `GHL_API_KEY` | required | Private Integration Token |
| `GHL_LOCATION_ID` | — | Default sub-account; injected into any endpoint that takes `locationId` when the caller omits it |
| `GHL_MODULES` | `contacts,conversations,opportunities,calendars,locations` | Comma-separated modules to expose as dedicated tools, or `all` |
| `GHL_ALLOW_WRITES` | `false` | Expose POST/PUT/PATCH tools |
| `GHL_ALLOW_DELETES` | `false` | Expose DELETE tools (and `remove-*` style POSTs) |
| `GHL_META_TOOLS` | `true` | Expose the three discovery/call meta-tools covering all endpoints |
| `MCP_AUTH_TOKEN` | required for HTTP | Bearer token clients must send to the HTTP transport |
| `PORT` | `3000` | HTTP transport port |

Module names match the spec files: `ad-manager`, `affiliate-manager`, `agent-studio`,
`associations`, `blogs`, `brand-boards`, `businesses`, `calendars`, `campaigns`,
`companies`, `contacts`, `conversation-ai`, `conversations`, `courses`, `custom-fields`,
`custom-menus`, `email-isv`, `emails`, `forms`, `funnels`, `invoices`, `knowledge-base`,
`links`, `locations`, `marketplace`, `medias`, `oauth`, `objects`, `opportunities`,
`payments`, `phone-system`, `products`, `proposals`, `saas-api`, `snapshots`,
`social-media-posting`, `store`, `surveys`, `users`, `voice-ai`, `workflows`.

A few modules (`companies`, `saas-api`, `snapshots`, parts of `locations` and `users`)
are agency-level and need an agency token; tool descriptions say `Token: agency`.

## Use with Claude Code (stdio)

Add to `.mcp.json` in your project (or `~/.claude.json` for global):

```json
{
  "mcpServers": {
    "ghl": {
      "command": "node",
      "args": ["--env-file=/absolute/path/to/GHL-MCP/.env", "/absolute/path/to/GHL-MCP/dist/src/stdio.js"]
    }
  }
}
```

`--env-file` is built into Node, so no dotenv dependency. You can also put the variables
in the `"env"` block of the config instead.

## Use as a remote connector (Streamable HTTP)

```bash
MCP_AUTH_TOKEN=$(openssl rand -hex 32) npm run start:http
# -> http://localhost:3000/mcp  (clients send: Authorization: Bearer <MCP_AUTH_TOKEN>)
```

The HTTP transport is stateless, refuses to start without `MCP_AUTH_TOKEN`, and only
accepts `POST /mcp`. Put it behind HTTPS before exposing it to the internet.

## How the tools look

Each endpoint becomes `{module}_{operationId}`, for example `contacts_upsert_contact`,
`invoices_send_invoice`, `calendars_get_free_slots`. Arguments are **flat**: path params,
query params, and body fields all sit at the top level, and the server routes them to the
right place. If a body isn't an object (e.g. an array), it's passed as a single `body` arg.

Meta-tools:

- `ghl_search_endpoints({ query, module?, method?, limit? })` — keyword search over all 576
- `ghl_describe_endpoint({ name })` — full input schema, scopes, HTTP method/path
- `ghl_call_endpoint({ name, arguments })` — run any endpoint (same write/delete gates apply)

## Development

```bash
npm run dev          # run the stdio server from source (Node type-stripping)
npm run typecheck
npm test             # unit tests + in-memory end-to-end MCP tests
```

Layout:

```
scripts/fetch-specs.ts   download specs from GoHighLevel/highlevel-api-docs
src/generator/           OpenAPI -> endpoint definitions (pure, unit-tested)
generated/               committed catalog, one JSON per module
src/client.ts            fetch wrapper: auth, Version header, errors, 429 retry
src/tools.ts             tool registration, arg routing, gating, result formatting
src/meta-tools.ts        search / describe / call
src/server.ts            McpServer factory
src/stdio.ts, src/http.ts  transports
```

## Updating when HighLevel changes the API

```bash
npm run specs:fetch && npm run generate && npm test
```

The generator fails loudly if a spec produces a schema Zod can't express or a tool name
collides, so a bad upstream change can't ship silently.
