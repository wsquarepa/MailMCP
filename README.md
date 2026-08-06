# MailMCP

MailMCP is a Model Context Protocol server that fronts multiple IMAP/SMTP and Microsoft Graph mailboxes for AI agents. It provides one HTTP endpoint with per-key bearer authentication, per-mailbox permissions, and agent-shaped output: short listings, a structural draft-then-send workflow, and surfaced headers for spam triage.

Agents using raw mail CLIs can read more than intended, send messages when they should create drafts, and fail on fragile text parsing. MailMCP puts those guardrails and structured operations on the server.

## Quick start with Docker

Copy [config.example.yml](config.example.yml) into a writable data directory, replace its example account details, and provide values for every `${ENV}` reference through the container environment.

```sh
mkdir -p data/graph-tokens
cp config.example.yml data/config.yml
docker run -v ./data:/data -e MAILMCP_CONFIG=/data/config.yml -e PORT=8080 -e GRAPH_TOKEN_CACHE_DIR=/data/graph-tokens -p 8080:8080 ghcr.io/wsquarepa/mailmcp:edge
```

The example also requires `IMAP_PASS_HERMES`, `IMAP_PASS_SHARED`, and `MCP_KEY_HERMES`; pass them with additional `-e` options or an environment file.

| Variable | Contract |
|---|---|
| `MAILMCP_CONFIG` | Required path to the YAML configuration file. |
| `PORT` | Required listening port from 1 through 65535. |
| `GRAPH_TOKEN_CACHE_DIR` | Required when any Graph mailbox exists. It must name an existing writable directory. |

## Connecting clients

Add MailMCP to Claude Code over HTTP:

```sh
claude mcp add --transport http mailmcp http://host:8080/mcp --header "Authorization: Bearer <token>"
```

Other MCP clients can connect to `http://host:8080/mcp` using the streamable HTTP transport and an `Authorization: Bearer <token>` header. Use `GET /health` for readiness and liveness probes.

## Graph mailbox setup

Create an Azure app registration, enable its public client flow, and grant the delegated Microsoft Graph permissions `Mail.ReadWrite` and `Mail.Send`. Put the registration's tenant ID and client ID in the mailbox's `graph:` block in the config. Authenticate each configured Graph mailbox with the device-code flow:

```sh
mailmcp auth <mailbox>
```

When running from Docker, use the same entrypoint:

```bash
docker run -it --rm \
  -v ./data:/data \
  -e MAILMCP_CONFIG=/data/config.yml \
  -e GRAPH_TOKEN_CACHE_DIR=/data/graph-tokens \
  ghcr.io/wsquarepa/mailmcp:edge auth <mailbox>
```

The auth command needs `MAILMCP_CONFIG` and `GRAPH_TOKEN_CACHE_DIR` set just like `serve`, and the device-code token cache lands in the mounted `graph-tokens` directory so the serving container picks it up.

Each outgoing attachment sent through Graph is capped at 3 MB.

## Permission model

| Verb | Covers |
|---|---|
| read | list, get, search, attachments, headers, folders |
| draft | create and update drafts |
| send | send a draft |
| organize | move (including junk/archive), mark read/unread |
| delete | move to Trash |

Effective permissions on a mailbox are the union of the mailbox's `public` list and the key's explicit grant. Every mailbox-scoped tool takes an optional `mailbox` parameter, defaulting to the key's `default_mailbox`; `list_accounts` is not mailbox-scoped.

## Tools

| Tool | Description |
|---|---|
| `list_accounts` | List accessible mailboxes, their permissions, and the default mailbox. |
| `list_folders` | List folders and identify special roles such as inbox, junk, trash, archive, drafts, and sent. |
| `list_messages` | List messages with concise metadata and snippets; defaults to the newest 20 unread inbox messages. |
| `search_messages` | Search one folder by text, sender, subject, or date range. |
| `get_message` | Read a cleaned message with its envelope and authentication summary, with optional raw headers. |
| `get_attachment` | Fetch one attachment as text or base64, subject to the 10 MB cap. |
| `create_draft` | Create a fresh or server-threaded reply draft without sending it. |
| `update_draft` | Update supplied draft fields while preserving the others, and return the current draft ID. |
| `send_draft` | Send an existing draft, which is the only way MailMCP sends mail. |
| `move_message` | Move messages to a folder or to junk, archive, or inbox. |
| `mark_read` | Mark messages as read. |
| `mark_unread` | Mark messages as unread. |
| `delete_message` | Move messages to Trash without permanently deleting them. |

## Development

Clone the repository and install its dependencies:

```sh
git clone https://github.com/wsquarepa/MailMCP.git
cd MailMCP
npm install
```

Start GreenMail before running the contract or end-to-end tests:

```sh
docker compose -f docker-compose.test.yml up -d
```

Available checks are:

```sh
npm run typecheck
npm test
npm run test:unit
npm run test:contract
npm run test:e2e
npm run build
```

Before a release, run the live Graph smoke test against a real Graph mailbox. Set `GRAPH_TENANT_ID` and `GRAPH_CLIENT_ID`, then run:

```sh
node scripts/graph-smoke.mjs
```

## License

MailMCP is licensed under the [GNU General Public License v3.0](LICENSE).
