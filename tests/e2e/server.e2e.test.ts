import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Config } from "../../src/config.js";
import { ImapSmtpBackend } from "../../src/imap/backend.js";
import { startServer } from "../../src/server.js";
import { closeBackends } from "../../src/tools/registry.js";
import type { MailBackend } from "../../src/types.js";
import { imapMailboxConfig, seedMessage } from "../helpers/greenmail.js";

const CONFIG: Config = {
  mailboxes: { hermes: imapMailboxConfig() },
  keys: [
    { name: "hermes", token: "tok-hermes-0123456789", default_mailbox: "hermes",
      grants: { hermes: ["read", "draft", "send", "organize", "delete"] } },
    { name: "reader", token: "tok-reader-0123456789", default_mailbox: "hermes",
      grants: { hermes: ["read"] } },
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
    const started = await startServer({ config: CONFIG, port: 0, backends });
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
