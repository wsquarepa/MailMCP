# MailMCP

Guidance for AI coding agents working in this repository. The root `CLAUDE.md` and `AGENTS.md` are symlinks to this file (`.agents/RULES.md`).

MailMCP is an MCP server (streamable HTTP transport) that fronts IMAP/SMTP and Microsoft Graph mailboxes for AI agents. Node >= 20, ESM, strict TypeScript.

## Commands

```sh
npm run typecheck                      # tsc --noEmit
npm test                               # all tests (vitest)
npm run test:unit                      # pure unit tests, no services needed
npm run test:contract                  # backend contract tests (needs GreenMail)
npm run test:e2e                       # full HTTP server tests (needs GreenMail)
npx vitest run tests/unit/config.test.ts   # single file
npx vitest run tests/unit -t "pattern"     # single test by name
npm run build                          # tsc -p tsconfig.build.json -> dist/
```

Contract and e2e tests need GreenMail running first:

```sh
docker compose -f docker-compose.test.yml up -d
```

GreenMail exposes IMAP on 3143 and SMTP on 3025 with the test account `agent` / `secret` (`agent@example.test`). CI (`.github/workflows/ci.yml`) runs typecheck, unit, contract, and e2e in that order, then publishes a Docker image to ghcr.io on push.

Before a release, run the live Graph smoke test against a real mailbox: set `GRAPH_TENANT_ID` and `GRAPH_CLIENT_ID`, then `node scripts/graph-smoke.mjs`.

Running the server itself: `mailmcp serve` (env: `MAILMCP_CONFIG` pointing at a YAML config, `PORT`, and `GRAPH_TOKEN_CACHE_DIR` when any Graph mailbox is configured) and `mailmcp auth <mailbox>` for the human device-code login of a Graph mailbox. See `config.example.yml` for the config shape.

## Architecture

The load-bearing seam is the `MailBackend` interface in `src/types.ts`. Everything above it is backend-agnostic; everything below it comes in two implementations:

- `src/imap/` wraps ImapFlow (one lazily reconnecting `ImapSession` per mailbox, with special-use folder detection and name fallbacks) plus nodemailer for SMTP.
- `src/graph/` speaks Microsoft Graph REST directly (`client.ts`), with MSAL device-code tokens cached as files in `GRAPH_TOKEN_CACHE_DIR` (`tokens.ts`).

Request flow: `src/cli.ts` loads config and builds one long-lived backend per mailbox (`src/tools/registry.ts`), then `src/server.ts` serves `/mcp`. Each HTTP request is authenticated by bearer token against the config's keys, then gets a fresh stateless `McpServer` + transport pair; mailbox state lives in the shared backends, never in MCP sessions. `src/tools/index.ts` registers all tools, checks permissions via `src/auth.ts` before touching a backend, and wraps every call in `runTool` for uniform error mapping and one structured log line per invocation (never log bodies, tokens, or passwords).

Cross-file invariants worth knowing before editing:

- **Message ids are backend-specific and part of the tool contract.** IMAP ids are `FOLDER:UID`; Graph ids are `g:<epoch36>:<hash4>` short ids (`src/graph/shortid.ts`) resolved by fetching messages at that timestamp and matching the hash, because native Graph ids are long and mutate on move.
- **Error messages are the agent-facing contract.** `ToolError` subclasses in `src/errors.ts` are returned verbatim as `isError` tool results and must state what the calling agent should do next; anything else is masked as an internal error. `SentButUnreconciledError` exists specifically to prevent a double-send after post-SMTP cleanup fails.
- **Permissions** are five verbs (`read`, `draft`, `send`, `organize`, `delete`); the effective set on a mailbox is the union of the mailbox's `public` list and the key's explicit grant (`docs/permission.md`). `send_draft` is the only way mail leaves the system.
- **Display truncation never feeds writes.** `BODY_MAX_CHARS` in `src/mail/clean.ts` caps `get_message` output only; draft update and send paths always operate on the raw stored draft.
- **Config** (`src/config.ts`) is a strict zod schema over YAML with `${VAR}` environment interpolation; unknown fields, duplicate key tokens, and grants referencing unknown mailboxes fail at startup.

## Testing structure

Three tiers under `tests/`: `unit/` for pure logic, `contract/` for backend behavior, `e2e/` for the whole HTTP server. The core pattern is `tests/contract/suite.ts`: one shared contract suite (`runMailBackendContract`) runs identically against the IMAP backend on GreenMail and the Graph backend on the in-process fake (`tests/fakes/fakeGraph.ts`). A behavior change in one backend usually means updating the shared suite so both stay in lockstep.

## TypeScript conventions

`strict`, `noUncheckedIndexedAccess`, and `exactOptionalPropertyTypes` are all on; the last one shapes idioms (e.g. optional args are typed `| undefined` explicitly, and the SDK transport needs a documented cast in `src/server.ts`). Module system is NodeNext ESM: relative imports carry `.js` extensions. "Not provided" is modeled as `null`, not missing fields (see `DraftInput` in `src/types.ts`: null means "empty" for create, "preserve" for update).
