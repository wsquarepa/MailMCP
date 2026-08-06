# MailMCP
A [model context protocol](https://modelcontextprotocol.io) server for autonomous IMAP/SMTP & MS Graph mailbox management for AI agents.

> [!CAUTION]
> This software is in early stages! Lots of features are still in development.  
> Please be aware that the API and data models may change rapidly!

This software intends to act as an alternative to [mcp-email-server](https://github.com/ai-zerolab/mcp-email-server) by [ai-zerolab](https://github.com/ai-zerolab) for over-the-internet access.  

## Quick Start

Create a new folder for your MailMCP installation and navigate to it.  
Then, simply download the `docker-compose.yml` and `config.example.yml` files using the following commands:

```sh
wget https://raw.githubusercontent.com/wsquarepa/MailMCP/master/docker-compose.yml
wget https://raw.githubusercontent.com/wsquarepa/MailMCP/master/config.example.yml -O config.yml
mkdir -p graph-tokens
```

Edit `config.yml` to your liking and run `docker compose up -d` to start the server! Every `${VAR}` your config references must be available to the container; uncomment and fill the matching `environment` entries in `docker-compose.yml`.

## Connecting clients

MCP clients can connect to `http://<host>:8080/mcp` using the streamable HTTP transport and an `Authorization: Bearer <token>` header. Refer to your harness documentation for details. If needed, `GET /health` for readiness and liveness probes.

## Documentation

- [Graph mailbox setup](docs/graph.md)
- [Permission model](docs/permission.md)
- [Tools](docs/tools.md)
- [Development](docs/dev.md)

## License

MailMCP is licensed under the [GNU General Public License v3.0](LICENSE).
