# ghl-mcp-server

A GoHighLevel MCP server with **every endpoint in HighLevel's public OpenAPI specs** —
576 as of the committed catalog — generated straight from those specs. The official
HighLevel MCP exposes ~36 tools; this one covers the whole public surface and stays
current with one command. `npm run generate` prints the live total.

- **Generated, not hand-written.** `npm run generate` turns `specs/*.json` into tool
  definitions. When HighLevel updates their docs, re-fetch and regenerate.
- **Context-friendly.** Load only the modules you need (`GHL_MODULES`), and use three
  meta-tools (`ghl_search_endpoints`, `ghl_describe_endpoint`, `ghl_call_endpoint`) to
  reach everything else on demand. The default set is 52 tools, about 11k tokens of
  tool list; `GHL_MODULES=all` with writes and deletes on is ~213k tokens and will not
  fit in any model's context on its own.
- **Safe by default.** Writes and deletes are off until you enable them. Disabled tools
  are hidden from the client entirely, not just blocked. Note what this does *not* mean:
  read tools in the default set can export every contact, conversation body, and call
  transcription in the sub-account. "Safe" here means no mutation, not small blast radius.
- **Public API only.** Private Integration Token auth, no undocumented endpoints, no
  browser-session tokens.

## Setup

```bash
npm install           # also builds, via the prepare script
cp .env.example .env  # then fill in GHL_API_KEY and GHL_LOCATION_ID
npm test              # optional: 42 tests, no credentials needed
```

`specs/` and `generated/` are committed, so a fresh clone is ready to run. `npm run
specs:fetch` and `npm run generate` are for refreshing against HighLevel's docs — see
[Updating](#updating-when-highlevel-changes-the-api). Running them on a fresh clone
replaces the specs you just checked out with whatever is on HighLevel's `main` today.

Get a **Private Integration Token** in GHL: sub-account → Settings → Private Integrations →
Create. Enable the scopes for the endpoints you plan to use (e.g. `contacts.readonly`,
`contacts.write`). Every tool description lists the scopes it needs.

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `GHL_API_KEY` | required | Private Integration Token |
| `GHL_LOCATION_ID` | — | Default sub-account; injected into any endpoint that takes `locationId` when the caller omits it |
| `GHL_MODULES` | `contacts,conversations,opportunities,calendars,locations` | Comma-separated modules to expose as dedicated tools, or `all`. Controls context size, **not** capability — see below |
| `GHL_ALLOW_WRITES` | `false` | Expose POST/PUT/PATCH tools |
| `GHL_ALLOW_DELETES` | `false` | Expose DELETE tools |
| `GHL_META_TOOLS` | `true` | Expose the three discovery/call meta-tools covering all endpoints |
| `GHL_INCLUDE_DEPRECATED` | `false` | List the 19 endpoints HighLevel marks deprecated as dedicated tools |
| `GHL_BASE_URL` | `https://services.leadconnectorhq.com` | API host override. Rejected unless it is https and stays on `leadconnectorhq.com`, because every request carries your token |
| `MCP_AUTH_TOKEN` | required for HTTP | Bearer token clients must send to the HTTP transport |
| `PORT` | `3000` | HTTP transport port |
| `MCP_BIND_HOST` | `127.0.0.1` | HTTP bind address. Anything but loopback exposes the server to the network |
| `MCP_ALLOWED_HOSTS` | — | Extra `Host` headers to accept, comma-separated. Needed behind a reverse proxy |
| `GITHUB_TOKEN` | — | Lifts GitHub's rate limit for `npm run specs:fetch` |

`GHL_MODULES` is not a security boundary. With `GHL_META_TOOLS=true` (the default),
`ghl_call_endpoint` can run any of the 576 endpoints in every module regardless of what
is loaded. Only `GHL_ALLOW_WRITES` and `GHL_ALLOW_DELETES` constrain what can be done.
Set `GHL_META_TOOLS=false` if you want module selection to be the limit.

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
# -> http://127.0.0.1:3000/mcp  (clients send: Authorization: Bearer <MCP_AUTH_TOKEN>)
```

The HTTP transport is stateless, refuses to start without `MCP_AUTH_TOKEN`, and binds
loopback only. It serves `POST /mcp` (authenticated) and an unauthenticated `GET /health`
that returns `{"ok":true}`.

To reach it from elsewhere, terminate TLS in front of it and set `MCP_BIND_HOST` plus
`MCP_ALLOWED_HOSTS=your.host:443`. Without TLS the bearer token and every CRM record
cross the wire in cleartext, and that token fronts a full-access Private Integration
Token. `Host` headers outside the allowlist are rejected, which is what stops a hostile
page from rebinding its own domain to your loopback address.

## How the tools look

Each endpoint becomes `{module}_{operationId}`, for example `contacts_upsert_contact`,
`invoices_send_invoice`, `calendars_get_free_slots`. Arguments are **flat**: path params,
query params, and body fields all sit at the top level, and the server routes them to the
right place. If a body isn't an object (e.g. an array), it's passed as a single `body` arg.

A field the spec marks as binary (file uploads) takes `{ "base64": "...", "filename":
"rows.csv", "contentType": "text/csv" }` and is sent as a real multipart file part.

Meta-tools:

- `ghl_search_endpoints({ query, module?, method?, limit? })` — keyword search over all 576
- `ghl_describe_endpoint({ name })` — full input schema, scopes, HTTP method/path
- `ghl_call_endpoint({ name, arguments })` — run any endpoint. Same write/delete gates,
  and arguments are validated against that endpoint's schema before anything is sent

## Development

```bash
npm run dev          # run the stdio server from source (Node type-stripping)
npm run typecheck
npm test             # unit tests + in-memory end-to-end MCP tests
```

`npm run dev` runs the sources through Node's strip-only type stripping, which cannot
erase enums, namespaces, or constructor parameter properties. `erasableSyntaxOnly` in
`tsconfig.json` makes `tsc` reject that syntax, so the build fails instead of `dev`.

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

The generator refuses to write anything and exits non-zero if a spec produces a schema
Zod can't express, a tool name collides or exceeds 64 characters, or a `{placeholder}` in
a URL has no argument to fill it. `generated/` is left untouched on failure, so a bad
upstream change can neither ship silently nor half-replace the committed catalog.

That last check is not hypothetical: HighLevel's specs declare a path parameter on one
method of a path and omit it on the others (`GET /users/{userId}` declares `userId`,
`PUT` and `DELETE` do not). The generator reads placeholders from the URL template rather
than trusting the parameter list, and the guard is there so a future gap fails the build.
