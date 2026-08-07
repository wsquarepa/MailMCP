#!/usr/bin/env node
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadConfig, type Config } from "./config.js";
import { GraphTokenProvider } from "./graph/tokens.js";
import { logger } from "./logger.js";
import { startServer } from "./server.js";
import { buildBackends, closeBackends } from "./tools/registry.js";
import { UploadStore } from "./uploads.js";

const USAGE = [
  "Usage:",
  "  mailmcp serve             start the server (env: MAILMCP_CONFIG, PORT, GRAPH_TOKEN_CACHE_DIR)",
  "  mailmcp auth <mailbox>    device-code login for a graph mailbox",
].join("\n");

export function parseCliArguments(argv: string[]): { command: "serve" } | { command: "auth"; mailbox: string } {
  const [command, mailbox, ...rest] = argv;
  if (rest.length > 0) throw new Error(USAGE);
  if (command === "serve" && mailbox === undefined) return { command: "serve" };
  if (command === "auth" && mailbox !== undefined) return { command: "auth", mailbox };
  throw new Error(USAGE);
}

export function validatePort(raw: string): number {
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`PORT must be an integer between 1 and 65535, got '${raw}'`);
  }
  return port;
}

function requiredEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable ${name}.\n${USAGE}`);
  }
  return value;
}

function loadConfigFromEnv(): Config {
  return loadConfig(requiredEnv("MAILMCP_CONFIG"), process.env);
}

function graphCacheDir(config: Config): string {
  const hasGraph = Object.values(config.mailboxes).some((m) => m.backend === "graph");
  if (!hasGraph) return ".";
  const dir = requiredEnv("GRAPH_TOKEN_CACHE_DIR");
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`GRAPH_TOKEN_CACHE_DIR '${dir}' is not an existing directory`);
  }
  accessSync(dir, constants.W_OK);
  return dir;
}

async function serve(): Promise<void> {
  const config = loadConfigFromEnv();
  const port = validatePort(requiredEnv("PORT"));
  const backends = buildBackends(config, graphCacheDir(config));
  const server = await startServer({ config, port, backends, uploads: new UploadStore() });
  const shutdown = (signal: string): void => {
    logger.info({ signal }, "shutting down");
    void server.close().then(() => closeBackends(backends)).then(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function auth(mailboxName: string): Promise<void> {
  const config = loadConfigFromEnv();
  const mailbox = config.mailboxes[mailboxName];
  if (mailbox === undefined || mailbox.backend !== "graph") {
    throw new Error(`'${mailboxName}' is not a configured graph mailbox.\n${USAGE}`);
  }
  const tokens = new GraphTokenProvider(
    mailboxName, mailbox.graph.tenant_id, mailbox.graph.client_id, graphCacheDir(config),
  );
  await tokens.deviceCodeLogin((message) => console.log(message));
  console.log(`Mailbox '${mailboxName}' authenticated; token cache written.`);
}

async function main(): Promise<void> {
  const parsed = parseCliArguments(process.argv.slice(2));
  if (parsed.command === "serve") await serve();
  else await auth(parsed.mailbox);
}

const isDirectRun =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (isDirectRun) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
