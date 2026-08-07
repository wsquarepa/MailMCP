import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { effectivePermissions, findKey } from "./auth.js";
import type { Config } from "./config.js";
import { logger } from "./logger.js";
import { registerTools } from "./tools/index.js";
import type { ToolContext } from "./tools/registry.js";
import type { MailBackend } from "./types.js";
import { UPLOAD_MAX_BYTES, UploadQuotaError, type UploadStore } from "./uploads.js";

const require = createRequire(import.meta.url);
const { version } = require("../package.json") as { version: string };

const BODY_LIMIT_BYTES = 1024 * 1024;

export interface ServerOptions {
  config: Config;
  port: number;
  backends: Map<string, MailBackend>;
  uploads: UploadStore;
}

class BodyTooLargeError extends Error {}

// Over-limit requests are drained, not destroyed: a destroyed socket RSTs the
// client mid-upload (ECONNRESET) before it can read the 413 response.
function readBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let total = 0;
    let rejected = false;
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      if (rejected) return;
      total += chunk.length;
      if (total > limit) {
        rejected = true;
        chunks.length = 0;
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => {
      if (!rejected) resolve(Buffer.concat(chunks));
    });
    request.on("error", (error) => {
      if (!rejected) reject(error);
    });
  });
}

function jsonError(response: ServerResponse, status: number, code: number, message: string): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message } }));
}

async function handleMcp(
  options: ServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const header = request.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const key = findKey(options.config, token);
  if (key === null) {
    jsonError(response, 401, -32001, "Unauthorized: missing or unknown bearer token");
    logger.info({ key: null, status: 401 }, "mcp request rejected");
    return;
  }
  let body: string;
  try {
    body = (await readBody(request, BODY_LIMIT_BYTES)).toString("utf8");
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      jsonError(response, 413, -32600, `Request body exceeds ${BODY_LIMIT_BYTES} bytes`);
      logger.info({ key: key.name, status: 413 }, "mcp request rejected");
      return;
    }
    throw error;
  }
  let parsed: unknown = undefined;
  if (body !== "") {
    try {
      parsed = JSON.parse(body);
    } catch {
      jsonError(response, 400, -32700, "Parse error: request body is not valid JSON");
      logger.info({ key: key.name, status: 400 }, "mcp request rejected");
      return;
    }
  }
  const context: ToolContext = { config: options.config, key, backends: options.backends, uploads: options.uploads };
  const mcpServer = new McpServer({ name: "mailmcp", version });
  registerTools(mcpServer, context);
  // Stateless mode: one server+transport pair per request; mailbox state
  // lives in the shared backends, not in MCP sessions.
  // Omitting sessionIdGenerator leaves it undefined; EOPT forbids the explicit form.
  const transport = new StreamableHTTPServerTransport({});
  response.on("close", () => {
    void transport.close();
    void mcpServer.close();
    logger.info({ key: key.name, status: response.statusCode }, "mcp request completed");
  });
  // The installed SDK's transport classes type optional members as
  // `| undefined`, which exactOptionalPropertyTypes rejects against the
  // SDK's own Transport interface; runtime shapes are identical.
  await mcpServer.connect(transport as unknown as Transport);
  await transport.handleRequest(request, response, parsed);
}

function uploadError(response: ServerResponse, status: number, message: string): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify({ error: message }));
}

async function handleUpload(
  options: ServerOptions,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const header = request.headers.authorization ?? "";
  const token = header.startsWith("Bearer ") ? header.slice("Bearer ".length) : "";
  const key = findKey(options.config, token);
  if (key === null) {
    uploadError(response, 401, "Unauthorized: missing or unknown bearer token");
    logger.info({ key: null, status: 401 }, "upload rejected");
    return;
  }
  if (request.method !== "POST") {
    uploadError(response, 405, "Method not allowed; POST raw attachment bytes to /upload");
    logger.info({ key: key.name, status: 405 }, "upload rejected");
    return;
  }
  const canDraft = Object.keys(options.config.mailboxes)
    .some((name) => effectivePermissions(options.config, key, name).includes("draft"));
  if (!canDraft) {
    uploadError(response, 403, `Key '${key.name}' has no 'draft' permission on any mailbox; uploads are only for drafting attachments`);
    logger.info({ key: key.name, status: 403 }, "upload rejected");
    return;
  }
  let bytes: Buffer;
  try {
    bytes = await readBody(request, UPLOAD_MAX_BYTES);
  } catch (error) {
    if (error instanceof BodyTooLargeError) {
      uploadError(response, 413, `Upload exceeds the ${UPLOAD_MAX_BYTES} byte (3 MB) per-attachment cap`);
      logger.info({ key: key.name, status: 413 }, "upload rejected");
      return;
    }
    throw error;
  }
  if (bytes.length === 0) {
    uploadError(response, 400, "Empty body; POST the raw attachment bytes");
    logger.info({ key: key.name, status: 400 }, "upload rejected");
    return;
  }
  try {
    const receipt = options.uploads.put(key.name, bytes, Date.now());
    response.writeHead(201, { "content-type": "application/json" });
    response.end(JSON.stringify({
      upload_id: receipt.uploadId,
      size: receipt.size,
      expires_at: receipt.expiresAt.toISOString(),
    }));
    logger.info({ key: key.name, status: 201, size: receipt.size }, "upload staged");
  } catch (error) {
    if (error instanceof UploadQuotaError) {
      uploadError(response, 429, error.message);
      logger.info({ key: key.name, status: 429 }, "upload rejected");
      return;
    }
    throw error;
  }
}

export async function startServer(options: ServerOptions): Promise<{ close: () => Promise<void>; port: number }> {
  const httpServer = createServer((request, response) => {
    if (request.url === "/health" && request.method === "GET") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok", version }));
      return;
    }
    if (request.url === "/upload") {
      handleUpload(options, request, response).catch((error: unknown) => {
        logger.error({ error: String(error) }, "upload request handling failed");
        if (!response.headersSent) uploadError(response, 500, "Internal error");
        else response.end();
      });
      return;
    }
    if (request.url !== "/mcp") {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "not found; endpoints are /mcp and /upload" }));
      return;
    }
    handleMcp(options, request, response).catch((error: unknown) => {
      logger.error({ error: String(error) }, "mcp request handling failed");
      if (!response.headersSent) {
        jsonError(response, 500, -32603, "Internal error");
      } else {
        response.end();
      }
    });
  });

  await new Promise<void>((resolve) => httpServer.listen(options.port, () => resolve()));
  const address = httpServer.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : options.port;
  logger.info({ port: boundPort }, "mailmcp listening");
  return {
    port: boundPort,
    close: async () => {
      await new Promise<void>((resolve, reject) =>
        httpServer.close((error) => (error !== undefined ? reject(error) : resolve())),
      );
    },
  };
}
