import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { InvalidInputError } from "../../src/errors.js";
import { GraphBackend } from "../../src/graph/backend.js";
import { FakeGraph } from "../fakes/fakeGraph.js";

const CONFIG = {
  backend: "graph" as const,
  address: "Agent <school@school.test>",
  graph: { tenant_id: "t", client_id: "c" },
};

const EMPTY = {
  replyToMessageId: null, to: null, cc: null, bcc: null,
  subject: null, body: null, attachments: null,
};
const RECIPIENT = { name: "Recipient", address: "r@x.test" };
const HIDDEN = { name: "Hidden", address: "h@x.test" };

describe("GraphBackend writes (fake Graph)", () => {
  const fake = new FakeGraph();
  let backend: GraphBackend;
  let inboxShortId = "";

  beforeAll(async () => {
    const baseUrl = await fake.start();
    fake.seed({
      folder: "inbox", subject: "incoming", fromName: "Sender", fromAddress: "s@x.test",
      body: "please reply", isRead: false, receivedAt: new Date("2026-08-06T12:00:05.100Z"), headers: {},
    });
    backend = new GraphBackend("school", CONFIG, {
      baseUrl, mailboxName: "school", getToken: async () => "test-token",
    });
    const inbox = await backend.listMessages({ folder: null, includeRead: true, limit: 10, offset: 0 });
    inboxShortId = inbox.find((m) => m.subject === "incoming")!.id;
  });
  afterAll(async () => await fake.stop());

  it("refuses to update or send a non-draft", async () => {
    await expect(backend.sendDraft(inboxShortId)).rejects.toThrow(InvalidInputError);
    await expect(backend.updateDraft(inboxShortId, { ...EMPTY, body: "x" })).rejects.toThrow(InvalidInputError);
  });

  it("creates, updates, and sends a draft with bcc in the confirmation", async () => {
    const draftId = await backend.createDraft({
      ...EMPTY, to: [RECIPIENT], bcc: [HIDDEN], subject: "hello", body: "v1",
    });
    expect(draftId).toMatch(/^g:/);
    const updatedId = await backend.updateDraft(draftId, { ...EMPTY, body: "v2" });
    const draft = await backend.getMessage(updatedId);
    expect(draft.bodyText).toBe("v2");
    expect(draft.subject).toBe("hello");
    const sent = await backend.sendDraft(updatedId);
    expect(sent.warning).toBeNull();
    expect(sent.recipients).toEqual(expect.arrayContaining([RECIPIENT, HIDDEN]));
    expect(fake.messagesIn("sentitems")).toHaveLength(1);
  });

  it("rejects an oversized outgoing attachment before any mutation", async () => {
    const big = Buffer.alloc(4 * 1024 * 1024, 1).toString("base64");
    await expect(backend.createDraft({
      ...EMPTY, to: [RECIPIENT], subject: "big", body: "b",
      attachments: [{ filename: "big.bin", mimeType: "application/octet-stream", contentBase64: big }],
    })).rejects.toThrow("3 MB");
    expect(fake.messagesIn("drafts").filter((m) => m.subject === "big")).toHaveLength(0);
  });

  it("creates a reply draft via createReply with Re: subject and sender recipient", async () => {
    const replyId = await backend.createDraft({ ...EMPTY, replyToMessageId: inboxShortId, body: "my reply" });
    const reply = await backend.getMessage(replyId);
    expect(reply.subject).toBe("Re: incoming");
    expect(reply.to[0]?.address).toBe("s@x.test");
    expect(reply.bodyText).toBe("my reply");
  });

  it("moves to junk with per-id results and stable ids", async () => {
    const moved = await backend.move([inboxShortId, "g:zzzz:0000"], "junk");
    expect(moved.done).toEqual([{ id: inboxShortId, newId: inboxShortId }]);
    expect(moved.failed).toHaveLength(1);
    expect(fake.messagesIn("junkemail")).toHaveLength(1);
    const read = await backend.markRead([inboxShortId]);
    expect(read.done).toEqual([{ id: inboxShortId, newId: inboxShortId }]);
  });

  it("rejects trash as a move target but deletes to trash", async () => {
    const rejected = await backend.move([inboxShortId], "trash");
    expect(rejected.failed[0]?.reason).toContain("delete_message");
    const deleted = await backend.deleteToTrash([inboxShortId]);
    expect(deleted.done).toHaveLength(1);
    expect(fake.messagesIn("deleteditems")).toHaveLength(1);
  });
});
