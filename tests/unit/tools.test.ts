import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config.js";
import { registerTools } from "../../src/tools/index.js";
import type { ToolContext } from "../../src/tools/registry.js";
import type {
  Address, AttachmentContent, BulkResult, DraftInput, Folder, ListOptions,
  MailBackend, MessageFull, MessageSummary, SearchOptions, SendResult,
} from "../../src/types.js";

const SUMMARY: MessageSummary = {
  id: "INBOX:1", from: { name: "A", address: "a@x.test" }, subject: "s",
  date: new Date(Date.UTC(2026, 7, 6)), unread: true, hasAttachments: false,
  snippet: "snip", surfacedHeaders: {},
};

class FakeBackend implements MailBackend {
  calls: string[] = [];
  lastDraft: DraftInput | null = null;
  sendWarning: string | null = null;
  async listFolders(): Promise<Folder[]> { return [{ name: "INBOX", specialUse: "inbox" }]; }
  async listMessages(options: ListOptions): Promise<MessageSummary[]> {
    this.calls.push(`listMessages:${options.includeRead}:${options.limit}:${options.offset}`);
    return [SUMMARY];
  }
  async search(_options: SearchOptions): Promise<MessageSummary[]> { return [SUMMARY]; }
  async getMessage(_id: string): Promise<MessageFull> {
    return {
      ...SUMMARY, replyTo: null, returnPath: null, to: [], cc: [],
      auth: { spf: null, dkim: null, dkimDomain: null, dmarc: null },
      bodyText: "body", bodyTruncated: false, attachments: [], rawHeaders: "H: v",
    };
  }
  async getAttachment(_id: string, _index: number, maxBytes: number): Promise<AttachmentContent> {
    this.calls.push(`getAttachment:${maxBytes}`);
    return { filename: "a.txt", mimeType: "text/plain", size: 2, content: Buffer.from("hi") };
  }
  async createDraft(input: DraftInput): Promise<string> { this.lastDraft = input; return "Drafts:9"; }
  async updateDraft(_id: string, input: DraftInput): Promise<string> { this.lastDraft = input; return "Drafts:10"; }
  async sendDraft(_id: string): Promise<SendResult> {
    return { recipients: [{ name: "R", address: "r@x.test" }], warning: this.sendWarning };
  }
  async move(ids: string[], _target: string): Promise<BulkResult> {
    return { done: ids.map((id) => ({ id, newId: `Junk:7` })), failed: [] };
  }
  async markRead(ids: string[]): Promise<BulkResult> {
    return { done: ids.map((id) => ({ id, newId: id })), failed: [] };
  }
  async markUnread(ids: string[]): Promise<BulkResult> {
    return { done: ids.map((id) => ({ id, newId: id })), failed: [] };
  }
  async deleteToTrash(ids: string[]): Promise<BulkResult> {
    return { done: ids.map((id) => ({ id, newId: `Trash:3` })), failed: [] };
  }
  async close(): Promise<void> {}
}

const IMAP_SERVER = { host: "h", port: 1, secure: true, user: "u", pass: "p" };
const CONFIG: Config = {
  mailboxes: {
    hermes: { backend: "imap", address: "H <h@x.test>", imap: IMAP_SERVER, smtp: IMAP_SERVER },
    shared: { backend: "imap", address: "S <s@x.test>", imap: IMAP_SERVER, smtp: IMAP_SERVER, public: ["read"] },
  },
  keys: [
    { name: "full", token: "tok-full-0123456789", default_mailbox: "hermes",
      grants: { hermes: ["read", "draft", "send", "organize", "delete"] } },
    { name: "limited", token: "tok-lim-0123456789", default_mailbox: "shared" },
  ],
};

async function connect(keyIndex: number, backend: FakeBackend): Promise<Client> {
  const context: ToolContext = {
    config: CONFIG,
    key: CONFIG.keys[keyIndex]!,
    backends: new Map<string, MailBackend>([["hermes", backend], ["shared", backend]]),
  };
  const server = new McpServer({ name: "mailmcp-test", version: "0.0.0" });
  registerTools(server, context);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as { type: string; text?: string }[];
  return content.map((c) => c.text ?? "").join("\n");
}

describe("tool layer", () => {
  it("registers all 13 tools", async () => {
    const client = await connect(0, new FakeBackend());
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "create_draft", "delete_message", "get_attachment", "get_message",
      "list_accounts", "list_folders", "list_messages", "mark_read",
      "mark_unread", "move_message", "search_messages", "send_draft", "update_draft",
    ]);
  });

  it("list_messages defaults to unread, limit 20, offset 0, default mailbox", async () => {
    const backend = new FakeBackend();
    const client = await connect(0, backend);
    const result = await client.callTool({ name: "list_messages", arguments: {} });
    expect(backend.calls).toContain("listMessages:false:20:0");
    expect(textOf(result)).toContain("[hermes INBOX:1]");
  });

  it("denies without permission, naming the gap", async () => {
    const client = await connect(1, new FakeBackend());
    const result = await client.callTool({
      name: "send_draft", arguments: { draft_id: "Drafts:9", mailbox: "shared" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Key 'limited' does not have 'send' on mailbox 'shared'. Its grants there: read.",
    );
  });

  it("rejects an unknown mailbox with the valid list", async () => {
    const client = await connect(0, new FakeBackend());
    const result = await client.callTool({ name: "list_messages", arguments: { mailbox: "ghost" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("hermes");
  });

  it("list_accounts shows grants and default", async () => {
    const client = await connect(1, new FakeBackend());
    const text = textOf(await client.callTool({ name: "list_accounts", arguments: {} }));
    expect(text).toContain("shared [default]");
    expect(text).toContain("permissions: read");
  });

  it("create_draft enforces exactly one mode", async () => {
    const client = await connect(0, new FakeBackend());
    const both = await client.callTool({
      name: "create_draft",
      arguments: { reply_to_message_id: "INBOX:1", to: ["x@x.test"], subject: "s", body: "b" },
    });
    expect(both.isError).toBe(true);
    expect(textOf(both)).toContain("either");
    const neither = await client.callTool({ name: "create_draft", arguments: { body: "b" } });
    expect(neither.isError).toBe(true);
    const freshMissing = await client.callTool({
      name: "create_draft", arguments: { to: ["x@x.test"], body: "b" },
    });
    expect(freshMissing.isError).toBe(true);
    expect(textOf(freshMissing)).toContain("subject");
  });

  it("parses recipient strings into Address objects and rejects malformed ones", async () => {
    const backend = new FakeBackend();
    const client = await connect(0, backend);
    const ok = await client.callTool({
      name: "create_draft",
      arguments: { to: ["Hermes Agent <h@f.test>"], subject: "s", body: "b" },
    });
    expect(ok.isError).toBeFalsy();
    expect(backend.lastDraft?.to).toEqual([{ name: "Hermes Agent", address: "h@f.test" }]);
    const bad = await client.callTool({
      name: "create_draft", arguments: { to: ["not-an-address"], subject: "s", body: "b" },
    });
    expect(bad.isError).toBe(true);
    expect(textOf(bad)).toContain("not-an-address");
  });

  it("rejects malformed base64 attachments before the backend sees them", async () => {
    const backend = new FakeBackend();
    const client = await connect(0, backend);
    const result = await client.callTool({
      name: "create_draft",
      arguments: {
        to: ["x@x.test"], subject: "s", body: "b",
        attachments: [{ filename: "f", mime_type: "text/plain", content_base64: "!!!not-base64!!!" }],
      },
    });
    expect(result.isError).toBe(true);
    expect(backend.lastDraft).toBeNull();
  });

  it("get_attachment passes the 10 MB cap and returns text for text types", async () => {
    const backend = new FakeBackend();
    const client = await connect(0, backend);
    const result = await client.callTool({ name: "get_attachment", arguments: { id: "INBOX:1", index: 0 } });
    expect(backend.calls).toContain(`getAttachment:${10 * 1024 * 1024}`);
    expect(textOf(result)).toContain("hi");
  });

  it("send_draft confirms recipients and surfaces warnings", async () => {
    const backend = new FakeBackend();
    const client = await connect(0, backend);
    const clean = textOf(await client.callTool({ name: "send_draft", arguments: { draft_id: "Drafts:9" } }));
    expect(clean).toBe("Sent draft Drafts:9 to: R <r@x.test>");
    backend.sendWarning = "Draft Drafts:9 WAS sent successfully. Do NOT send it again.";
    const warned = textOf(await client.callTool({ name: "send_draft", arguments: { draft_id: "Drafts:9" } }));
    expect(warned).toContain("WAS sent successfully");
  });

  it("move_message reports changed ids through formatBulk", async () => {
    const client = await connect(0, new FakeBackend());
    const text = textOf(await client.callTool({
      name: "move_message", arguments: { ids: ["INBOX:1"], target: "junk" },
    }));
    expect(text).toContain("INBOX:1 -> Junk:7.");
  });
});
