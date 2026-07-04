# ClubOS MCP server

`POST /mcp` turns the read-only `/api/v1` surface into an **MCP (Model Context Protocol)** server, so a staff member can connect their Claude client straight to ClubOS with their scoped API key and ask questions of their club data in plain English ("how many MFL teams have paid this term?", "list unconfirmed CIC 7s registrations", "what's revenue for the last 30 days?").

It reuses the existing key security **verbatim** — scopes, workspace (`allowedOrgIds`) binding, the audit log, the 240/min rate limit, and brute-force protection all still apply. A key can only reach through MCP exactly what it could reach through `/api/v1`. Nothing medical, no payment identifiers, no player ID documents are ever exposed.

## For a staff member — how to connect

They need their **scoped ClubOS API key** (Daniel mints it in ClubOS → Settings → API Keys, choosing scopes + workspaces). Then:

**Claude Code (terminal):**
```bash
claude mcp add --transport http clubos https://app.usg.co.nz/mcp \
  --header "Authorization: Bearer clubos_THEIR_KEY"
```

**Claude Desktop** (`claude_desktop_config.json`) — via the `mcp-remote` bridge:
```json
{
  "mcpServers": {
    "clubos": {
      "command": "npx",
      "args": ["-y", "mcp-remote", "https://app.usg.co.nz/mcp",
               "--header", "Authorization: Bearer clubos_THEIR_KEY"]
    }
  }
}
```

Once connected they'll see the 17 tools (`overview`, `revenue`, `analytics`, `customers`, `camps`, `registrations`, `league_summary`, `league_teams`, `league_games`, `tournament_summary`, `tournament_teams`, `tournament_fixtures`, `tournament_skills`, `cic7s_registrations`, `sporty_registrations`, `split_tests`, `order_timing`). A tool call outside the key's grant returns a clear "does not have the 'x:read' scope" / workspace error — the same 403 the API returns.

## Design notes

- **Stateless Streamable-HTTP.** No session map, so requests are never pinned to a Fly machine (consistent with the DB-authoritative rate-limit/audit).
- **Dependency-free.** Hand-rolled JSON-RPC — no `@modelcontextprotocol/sdk`, so nothing new enters the esbuild bundle or `package.json`. Zero deploy risk from the MCP layer.
- **Tools generated from `openapi-v1.ts`.** Add a `/api/v1` endpoint there and it automatically becomes an MCP tool — the two can't drift.
- **Metering.** A `tools/call` counts twice against the 240/min budget (once on `/mcp`, once on the forwarded `/api/v1` call) and writes two audit rows. Fine for human use; noted so it isn't a surprise in the logs.

## Not in this version (Phase 2)

- **claude.ai custom connectors** use OAuth 2.0, not a header token, so they need an OAuth authorization endpoint on top of this. The header-token model above already covers Claude Code + Claude Desktop, which is what staff use day-to-day.
- **Write/action tools** (create a booking, send a mailer, update a registration). This v1 is deliberately read-only, matching `/api/v1`. Actions would be a new scoped surface with human-in-the-loop confirmation.
