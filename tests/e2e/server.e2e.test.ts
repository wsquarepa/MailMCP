import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../../src/config.js";
import { ImapSmtpBackend } from "../../src/imap/backend.js";
import { startServer } from "../../src/server.js";
import { closeBackends } from "../../src/tools/registry.js";
import type { MailBackend } from "../../src/types.js";
import { UPLOAD_MAX_BYTES, UploadStore } from "../../src/uploads.js";
import { imapMailboxConfig, seedMessage } from "../helpers/greenmail.js";

const CONFIG: Config = {
  mailboxes: { hermes: imapMailboxConfig() },
  keys: [
    { name: "hermes", token: "tok-hermes-0123456789", default_mailbox: "hermes",
      grants: { hermes: ["read", "draft", "send", "organize", "delete"] } },
    { name: "reader", token: "tok-reader-0123456789", default_mailbox: "hermes",
      grants: { hermes: ["read"] } },
    { name: "uploader", token: "tok-upload-0123456789", default_mailbox: "hermes",
      grants: { hermes: ["draft"] } },
  ],
};

function clientFor(baseUrl: string, token: string): { client: Client; transport: Transport } {
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: { headers: { authorization: `Bearer ${token}` } },
  });
  // SDK transport typings are not exactOptionalPropertyTypes-clean; the
  // runtime shape implements Transport.
  return { client: new Client({ name: "e2e", version: "0.0.0" }), transport: transport as unknown as Transport };
}

type ToolCallResult = Awaited<ReturnType<Client["callTool"]>>;

function textOf(result: ToolCallResult): string {
  return (((result as { content?: unknown }).content ?? []) as { text?: string }[])
    .map((c) => c.text ?? "").join("\n");
}

describe("server e2e (requires GreenMail)", () => {
  let baseUrl = "";
  let backends: Map<string, MailBackend>;
  let close: () => Promise<void>;
  const subject = `e2e-${process.pid}-${Math.floor(performance.now())}`;

  beforeAll(async () => {
    backends = new Map([["hermes", new ImapSmtpBackend("hermes", imapMailboxConfig())]]);
    const started = await startServer({ config: CONFIG, port: 0, backends, uploads: new UploadStore() });
    close = started.close;
    baseUrl = `http://localhost:${started.port}`;
    await seedMessage(subject, "e2e body", {}, []);
  });
  afterAll(async () => {
    await close();
    await closeBackends(backends);
  });

  it("serves /health without auth", async () => {
    const response = await fetch(`${baseUrl}/health`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { status: string; version: string };
    expect(body.status).toBe("ok");
  });

  it("rejects a bad bearer token with 401", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer wrong" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping" }),
    });
    expect(response.status).toBe(401);
  });

  it("survives malformed JSON with a parse error, not a crash", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-hermes-0123456789" },
      body: "{not json",
    });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: { code: number } };
    expect(body.error.code).toBe(-32700);
    expect((await fetch(`${baseUrl}/health`)).status).toBe(200);
  });

  it("rejects oversized bodies with 413", async () => {
    const response = await fetch(`${baseUrl}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer tok-hermes-0123456789" },
      body: `{"pad":"${"x".repeat(2 * 1024 * 1024)}"}`,
    });
    expect(response.status).toBe(413);
  });

  it("upload endpoint rejects unknown tokens, non-POST, and keys without draft", async () => {
    const noAuth = await fetch(`${baseUrl}/upload`, { method: "POST", body: Buffer.from("x") });
    expect(noAuth.status).toBe(401);
    const reader = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      headers: { authorization: "Bearer tok-reader-0123456789" },
      body: Buffer.from("x"),
    });
    expect(reader.status).toBe(403);
    expect(((await reader.json()) as { error: string }).error).toContain("draft");
    const wrongMethod = await fetch(`${baseUrl}/upload`, {
      headers: { authorization: "Bearer tok-hermes-0123456789" },
    });
    expect(wrongMethod.status).toBe(405);
  });

  it("upload endpoint rejects empty and oversized bodies", async () => {
    const empty = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      headers: { authorization: "Bearer tok-hermes-0123456789" },
    });
    expect(empty.status).toBe(400);
    const oversized = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      headers: { authorization: "Bearer tok-hermes-0123456789" },
      body: Buffer.alloc(UPLOAD_MAX_BYTES + 1),
    });
    expect(oversized.status).toBe(413);
  });

  it("upload endpoint returns a readable error while a large body is still streaming", async () => {
    const response = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      headers: { authorization: "Bearer wrong" },
      body: Buffer.alloc(UPLOAD_MAX_BYTES),
    });
    expect(response.status).toBe(401);
    expect((((await response.json()) as { error: string }).error)).toContain("bearer token");
  });

  it("upload endpoint stages bytes and returns a receipt", async () => {
    const response = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      headers: { authorization: "Bearer tok-hermes-0123456789" },
      body: Buffer.from("receipt bytes"),
    });
    expect(response.status).toBe(201);
    const receipt = (await response.json()) as { upload_id: string; size: number; expires_at: string };
    expect(receipt.upload_id).toMatch(/^[0-9a-f]{32}$/);
    expect(receipt.size).toBe(13);
    expect(Date.parse(receipt.expires_at)).toBeGreaterThan(Date.now());
  });

  it("upload endpoint enforces the per-key quota with 429", async () => {
    const chunk = Buffer.alloc(UPLOAD_MAX_BYTES);
    for (let i = 0; i < 10; i += 1) {
      const ok = await fetch(`${baseUrl}/upload`, {
        method: "POST",
        headers: { authorization: "Bearer tok-upload-0123456789" },
        body: chunk,
      });
      expect(ok.status).toBe(201);
    }
    const over = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      headers: { authorization: "Bearer tok-upload-0123456789" },
      body: Buffer.from("one more byte"),
    });
    expect(over.status).toBe(429);
    expect(((await over.json()) as { error: string }).error).toContain("quota");
  });

  it("completes the triage flow: list unread, read, move to junk", async () => {
    const { client, transport } = clientFor(baseUrl, "tok-hermes-0123456789");
    await client.connect(transport);
    const listed = await client.callTool({ name: "list_messages", arguments: { include_read: true, limit: 50 } });
    const id = textOf(listed).match(new RegExp(`\\[hermes (INBOX:\\d+)\\][^\\n]*\\n[^\\n]*${subject}`))?.[1];
    expect(id).toBeDefined();
    const read = await client.callTool({ name: "get_message", arguments: { id } });
    expect(textOf(read)).toContain("e2e body");
    const moved = await client.callTool({ name: "move_message", arguments: { ids: [id], target: "junk" } });
    expect(textOf(moved)).toContain("1 done");
    await client.close();
  });

  it("completes the full draft flow over MCP: create, update, send, lands in Sent", async () => {
    const { client, transport } = clientFor(baseUrl, "tok-hermes-0123456789");
    await client.connect(transport);
    const created = await client.callTool({
      name: "create_draft",
      arguments: { to: ["Agent <agent@example.test>"], subject: `${subject}-out`, body: "first version" },
    });
    const draftId = textOf(created).match(/id (\S+)\./)?.[1];
    expect(draftId).toBeDefined();
    const updated = await client.callTool({
      name: "update_draft", arguments: { draft_id: draftId, body: "final version" },
    });
    const currentId = textOf(updated).match(/current id is (\S+)\./)?.[1];
    expect(currentId).toBeDefined();
    const sent = await client.callTool({ name: "send_draft", arguments: { draft_id: currentId } });
    expect(textOf(sent)).toContain("Sent draft");
    expect(textOf(sent)).toContain("agent@example.test");
    const delivered = await client.callTool({
      name: "search_messages", arguments: { subject: `${subject}-out` },
    });
    expect(textOf(delivered)).toContain(`${subject}-out`);
    const sentCopy = await client.callTool({
      name: "search_messages", arguments: { folder: "Sent", subject: `${subject}-out` },
    });
    expect(textOf(sentCopy)).toContain(`${subject}-out`);
    await client.close();
  });

  it("stages bytes via /upload and attaches them to a draft", async () => {
    const staged = await fetch(`${baseUrl}/upload`, {
      method: "POST",
      headers: { authorization: "Bearer tok-hermes-0123456789" },
      body: Buffer.from("staged attachment bytes"),
    });
    expect(staged.status).toBe(201);
    const receipt = (await staged.json()) as { upload_id: string };
    const { client, transport } = clientFor(baseUrl, "tok-hermes-0123456789");
    await client.connect(transport);
    const created = await client.callTool({
      name: "create_draft",
      arguments: {
        to: ["Agent <agent@example.test>"], subject: `${subject}-staged`, body: "see attachment",
        attachments: [{ filename: "note.txt", mime_type: "text/plain", upload_id: receipt.upload_id }],
      },
    });
    const draftId = textOf(created).match(/id (\S+)\./)?.[1];
    expect(draftId).toBeDefined();
    const fetched = await client.callTool({ name: "get_attachment", arguments: { id: draftId, index: 0 } });
    expect(textOf(fetched)).toContain("staged attachment bytes");
    await client.close();
  });

  it("forwards an attachment by source reference", async () => {
    const sourceSubject = `${subject}-fwd-source`;
    await seedMessage(sourceSubject, "carries a file", {}, [
      { filename: "fwd.txt", content: Buffer.from("forward me") },
    ]);
    const { client, transport } = clientFor(baseUrl, "tok-hermes-0123456789");
    await client.connect(transport);
    const listed = await client.callTool({ name: "search_messages", arguments: { subject: sourceSubject } });
    const sourceId = textOf(listed).match(/\[hermes (INBOX:\d+)\]/)?.[1];
    expect(sourceId).toBeDefined();
    const created = await client.callTool({
      name: "create_draft",
      arguments: {
        to: ["Agent <agent@example.test>"], subject: `${subject}-fwd`, body: "forwarding",
        attachments: [{ source_message_id: sourceId, source_index: 0 }],
      },
    });
    const draftId = textOf(created).match(/id (\S+)\./)?.[1];
    expect(draftId).toBeDefined();
    const fetched = await client.callTool({ name: "get_attachment", arguments: { id: draftId, index: 0 } });
    expect(textOf(fetched)).toContain("forward me");
    await client.close();
  });

  it("rejects an unknown upload id with re-upload guidance", async () => {
    const { client, transport } = clientFor(baseUrl, "tok-hermes-0123456789");
    await client.connect(transport);
    const result = await client.callTool({
      name: "create_draft",
      arguments: {
        to: ["Agent <agent@example.test>"], subject: `${subject}-bad`, body: "b",
        attachments: [{ filename: "f", mime_type: "text/plain", upload_id: "00000000000000000000000000000000" }],
      },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("unknown or expired");
    await client.close();
  });

  it("enforces permissions end to end", async () => {
    const { client, transport } = clientFor(baseUrl, "tok-reader-0123456789");
    await client.connect(transport);
    const result = await client.callTool({
      name: "create_draft",
      arguments: { to: ["x <agent@example.test>"], subject: "no", body: "no" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("does not have 'draft'");
    await client.close();
  });
});
