# Development

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
