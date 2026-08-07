# Graph mailbox setup

Create an Azure app registration, enable its public client flow, and grant the delegated Microsoft Graph permissions `Mail.ReadWrite` and `Mail.Send`. Put the registration's tenant ID and client ID in the mailbox's `graph:` block in the config. Authenticate each configured Graph mailbox with the device-code flow:

```sh
mailmcp auth <mailbox>
```

When running with the Quick Start compose file, use the same entrypoint through compose (create the token directory first so the container user can write to it):

```sh
mkdir -p graph-tokens
docker compose run --rm mailmcp auth <mailbox>
```

The auth command needs the same environment as `serve`: `MAILMCP_CONFIG`, `GRAPH_TOKEN_CACHE_DIR`, and every other `${ENV}` reference in the config, since the whole file is interpolated regardless of command. With compose these come from `docker-compose.yml` automatically. The device-code token cache lands in the mounted `graph-tokens` directory, so the serving container picks it up on its next start.

Outgoing attachments are capped at 3 MB per file on every backend; the cap matches Graph's simple-upload limit.
