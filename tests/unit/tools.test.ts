import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config.js";
import { registerTools } from "../../src/tools/index.js";
import type { ToolContext } from "../../src/tools/registry.js";
import { UPLOAD_MAX_BYTES, UploadStore } from "../../src/uploads.js";
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
  attachmentContent: Buffer = Buffer.from("hi");
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
      bodyText: "body", bodyTruncated: false, bodyMarkdown: "body", bodyRaw: "<p>body</p>",
      attachments: [], rawHeaders: "H: v",
    };
  }
  async getAttachment(_id: string, _index: number, maxBytes: number): Promise<AttachmentContent> {
    this.calls.push(`getAttachment:${maxBytes}`);
    return {
      filename: "a.txt", mimeType: "text/plain",
      size: this.attachmentContent.length, content: this.attachmentContent,
    };
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
    { name: "drafter", token: "tok-drf-0123456789", default_mailbox: "hermes",
      grants: { hermes: ["draft"] } },
  ],
};

async function connect(
  keyIndex: number,
  backend: FakeBackend,
): Promise<{ client: Client; uploads: UploadStore }> {
  const uploads = new UploadStore();
  const context: ToolContext = {
    config: CONFIG,
    key: CONFIG.keys[keyIndex]!,
    backends: new Map<string, MailBackend>([["hermes", backend], ["shared", backend]]),
    uploads,
  };
  const server = new McpServer({ name: "mailmcp-test", version: "0.0.0" });
  registerTools(server, context);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, uploads };
}

function textOf(result: Awaited<ReturnType<Client["callTool"]>>): string {
  const content = result.content as { type: string; text?: string }[];
  return content.map((c) => c.text ?? "").join("\n");
}

describe("tool layer", () => {
  it("registers all 13 tools", async () => {
    const { client } = await connect(0, new FakeBackend());
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name).sort()).toEqual([
      "create_draft", "delete_message", "get_attachment", "get_message",
      "list_accounts", "list_folders", "list_messages", "mark_read",
      "mark_unread", "move_message", "search_messages", "send_draft", "update_draft",
    ]);
  });

  it("list_messages defaults to unread, limit 20, offset 0, default mailbox", async () => {
    const backend = new FakeBackend();
    const { client } = await connect(0, backend);
    const result = await client.callTool({ name: "list_messages", arguments: {} });
    expect(backend.calls).toContain("listMessages:false:20:0");
    expect(textOf(result)).toContain("[hermes INBOX:1]");
  });

  it("denies without permission, naming the gap", async () => {
    const { client } = await connect(1, new FakeBackend());
    const result = await client.callTool({
      name: "send_draft", arguments: { draft_id: "Drafts:9", mailbox: "shared" },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe(
      "Key 'limited' does not have 'send' on mailbox 'shared'. Its grants there: read.",
    );
  });

  it("rejects an unknown mailbox with the valid list", async () => {
    const { client } = await connect(0, new FakeBackend());
    const result = await client.callTool({ name: "list_messages", arguments: { mailbox: "ghost" } });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("hermes");
  });

  it("list_accounts shows grants and default", async () => {
    const { client } = await connect(1, new FakeBackend());
    const text = textOf(await client.callTool({ name: "list_accounts", arguments: {} }));
    expect(text).toContain("shared [default]");
    expect(text).toContain("permissions: read");
  });

  it("create_draft enforces exactly one mode", async () => {
    const { client } = await connect(0, new FakeBackend());
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
    const { client } = await connect(0, backend);
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

  it("resolves upload_id attachments to staged bytes", async () => {
    const backend = new FakeBackend();
    const { client, uploads } = await connect(0, backend);
    const receipt = uploads.put("full", Buffer.from("staged bytes"), Date.now());
    const result = await client.callTool({
      name: "create_draft",
      arguments: {
        to: ["x@x.test"], subject: "s", body: "b",
        attachments: [{ filename: "f.bin", mime_type: "application/octet-stream", upload_id: receipt.uploadId }],
      },
    });
    expect(result.isError).toBeFalsy();
    expect(backend.lastDraft?.attachments).toEqual([
      { filename: "f.bin", mimeType: "application/octet-stream", content: Buffer.from("staged bytes") },
    ]);
  });

  it("rejects unknown and foreign upload ids with re-upload guidance", async () => {
    const backend = new FakeBackend();
    const { client, uploads } = await connect(0, backend);
    const foreign = uploads.put("limited", Buffer.from("x"), Date.now());
    for (const uploadId of ["00000000000000000000000000000000", foreign.uploadId]) {
      const result = await client.callTool({
        name: "create_draft",
        arguments: {
          to: ["x@x.test"], subject: "s", body: "b",
          attachments: [{ filename: "f", mime_type: "text/plain", upload_id: uploadId }],
        },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("unknown or expired");
    }
    expect(backend.lastDraft).toBeNull();
  });

  it("copies source-message attachments and enforces the cap on decoded bytes", async () => {
    const backend = new FakeBackend();
    const { client } = await connect(0, backend);
    const ok = await client.callTool({
      name: "create_draft",
      arguments: {
        to: ["x@x.test"], subject: "s", body: "b",
        attachments: [{ source_message_id: "INBOX:1", source_index: 0 }],
      },
    });
    expect(ok.isError).toBeFalsy();
    expect(backend.calls).toContain(`getAttachment:${10 * 1024 * 1024}`);
    expect(backend.lastDraft?.attachments).toEqual([
      { filename: "a.txt", mimeType: "text/plain", content: Buffer.from("hi") },
    ]);
    backend.attachmentContent = Buffer.alloc(UPLOAD_MAX_BYTES + 1);
    const over = await client.callTool({
      name: "create_draft",
      arguments: {
        to: ["x@x.test"], subject: "s", body: "b",
        attachments: [{ source_message_id: "INBOX:1", source_index: 0 }],
      },
    });
    expect(over.isError).toBe(true);
    expect(textOf(over)).toContain(`capped at ${UPLOAD_MAX_BYTES} bytes`);
  });

  it("rejects more than 10 attachment entries per call", async () => {
    const backend = new FakeBackend();
    const { client } = await connect(0, backend);
    const entries = Array.from({ length: 11 }, () => ({ source_message_id: "INBOX:1", source_index: 0 }));
    const result = await client.callTool({
      name: "create_draft",
      arguments: { to: ["x@x.test"], subject: "s", body: "b", attachments: entries },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("at most 10");
    expect(backend.lastDraft).toBeNull();
  });

  it("requires read permission for source-message attachments", async () => {
    const backend = new FakeBackend();
    const { client } = await connect(2, backend);
    const result = await client.callTool({
      name: "create_draft",
      arguments: {
        to: ["x@x.test"], subject: "s", body: "b",
        attachments: [{ source_message_id: "INBOX:1", source_index: 0 }],
      },
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("'read'");
    expect(backend.lastDraft).toBeNull();
  });

  it("rejects attachment entries that mix or match neither reference shape", async () => {
    const backend = new FakeBackend();
    const { client, uploads } = await connect(0, backend);
    const receipt = uploads.put("full", Buffer.from("x"), Date.now());
    const entries = [
      { filename: "f", mime_type: "t/p", upload_id: receipt.uploadId, source_message_id: "INBOX:1", source_index: 0 },
      { filename: "f" },
      { upload_id: receipt.uploadId },
      { source_message_id: "INBOX:1" },
      { source_message_id: "INBOX:1", source_index: 0, mime_type: "t/p" },
    ];
    for (const entry of entries) {
      const result = await client.callTool({
        name: "create_draft",
        arguments: { to: ["x@x.test"], subject: "s", body: "b", attachments: [entry] },
      });
      expect(result.isError).toBe(true);
      expect(textOf(result)).toContain("attachments entry");
    }
    expect(backend.lastDraft).toBeNull();
  });

  it("get_attachment passes the 10 MB cap and returns text for text types", async () => {
    const backend = new FakeBackend();
    const { client } = await connect(0, backend);
    const result = await client.callTool({ name: "get_attachment", arguments: { id: "INBOX:1", index: 0 } });
    expect(backend.calls).toContain(`getAttachment:${10 * 1024 * 1024}`);
    expect(textOf(result)).toContain("hi");
  });

  it("send_draft confirms recipients and surfaces warnings", async () => {
    const backend = new FakeBackend();
    const { client } = await connect(0, backend);
    const clean = textOf(await client.callTool({ name: "send_draft", arguments: { draft_id: "Drafts:9" } }));
    expect(clean).toBe("Sent draft Drafts:9 to: R <r@x.test>");
    backend.sendWarning = "Draft Drafts:9 WAS sent successfully. Do NOT send it again.";
    const warned = textOf(await client.callTool({ name: "send_draft", arguments: { draft_id: "Drafts:9" } }));
    expect(warned).toContain("WAS sent successfully");
  });

  it("move_message reports changed ids through formatBulk", async () => {
    const { client } = await connect(0, new FakeBackend());
    const text = textOf(await client.callTool({
      name: "move_message", arguments: { ids: ["INBOX:1"], target: "junk" },
    }));
    expect(text).toContain("INBOX:1 -> Junk:7.");
  });
});
