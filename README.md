# cypht-mcp Cloudflare Worker

Cloudflare Worker implementation of the Cypht email MCP. It preserves the eight email tools from the Docker service while moving MCP transport to the Worker runtime and storing encrypted account records in a Durable Object.

## Runtime

- Worker: `cypht-mcp`
- Endpoint: `https://cypht-mcp.rg1.workers.dev/mcp`
- Mail host: `smtp.rg1.in` (public IMAPS 993 and SMTP submission 587)
- State: `CyphtState` Durable Object
- Secrets: `MCP_BEARER`, `ACCOUNT_STORE_KEY`
- Transport: Streamable HTTP

The Worker cannot use the Docker-only hostname `mailserver-email-1`; the mail server must remain reachable at the configured public hostname. Mail host validation prevents arbitrary outbound host connections.

## Tools

`add_account`, `set_profile`, `list_accounts`, `send_email`, `list_emails`, `view_email`, `search_emails`, and `delete_email` are registered with the same names and core arguments as the Docker implementation. `search_emails` is implemented as an IMAP subject/from search.

Mailbox passwords are encrypted with AES-GCM before Durable Object storage and are never returned by tools. `delete_email` performs an irreversible IMAP EXPUNGE.

## Deploy

Deployment is owned by `mcp-ops`: create a `dev/*` branch, open and merge a PR, then verify the Workers Build and authenticated MCP smoke. Do not run local Wrangler deployment from the skill tree.
