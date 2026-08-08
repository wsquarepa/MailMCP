import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ImapSmtpBackend } from "../../src/imap/backend.js";
import { InvalidInputError } from "../../src/errors.js";
import { imapMailboxConfig, seedMessage } from "../helpers/greenmail.js";

// Exposes the private, side-effect-free header-stripping regex for direct
// testing against synthetic header blocks (no GreenMail connection needed).
class ExposedBackend extends ImapSmtpBackend {
  public stripBcc(source: Buffer): Buffer {
    return this.stripBccHeader(source);
  }
}

const EMPTY = {
  replyToMessageId: null, to: null, cc: null, bcc: null,
  subject: null, body: null, attachments: null,
};
const RECIPIENT = { name: "Recipient", address: "agent@example.test" };
const HIDDEN = { name: "Hidden Copy", address: "agent@example.test" };

describe("ImapSmtpBackend drafts (requires GreenMail)", () => {
  const backend = new ImapSmtpBackend("test", imapMailboxConfig());
  const marker = `draft-${process.pid}-${Math.floor(performance.now())}`;
  let inboxId = "";

  beforeAll(async () => {
    await seedMessage(`seed-${marker}`, "an inbox message", {}, []);
    const found = await backend.search({
      folder: null, query: null, from: null, subject: `seed-${marker}`,
      since: null, before: null, unreadOnly: false, limit: 1,
    });
    inboxId = found[0]!.id;
  });
  afterAll(async () => await backend.close());

  it("refuses to update or send a non-draft", async () => {
    await expect(backend.sendDraft(inboxId)).rejects.toThrow(InvalidInputError);
    await expect(backend.updateDraft(inboxId, { ...EMPTY, body: "x" })).rejects.toThrow(InvalidInputError);
  });

  it("update preserves untruncated body, attachments, and bcc; send strips bcc from wire", async () => {
    const bigBody = `start-${marker} ` + "x".repeat(60_000);
    const draftId = await backend.createDraft({
      ...EMPTY,
      to: [RECIPIENT],
      bcc: [HIDDEN],
      subject: marker,
      body: bigBody,
      attachments: [{ filename: "keep.txt", mimeType: "text/plain", content: Buffer.from("keep me") }],
    });
    expect(draftId).toMatch(/^Drafts:\d+$/);

    const updatedId = await backend.updateDraft(draftId, { ...EMPTY, subject: `${marker}-v2` });
    expect(updatedId).not.toBe(draftId);
    const updated = await backend.getMessage(updatedId);
    expect(updated.subject).toBe(`${marker}-v2`);
    expect(updated.bodyMarkdown.length).toBeGreaterThan(50_000); // >50k body survived the update
    expect(updated.attachments).toHaveLength(1);          // attachment bytes survived

    const sent = await backend.sendDraft(updatedId);
    expect(sent.warning).toBeNull();
    expect(sent.recipients).toEqual(expect.arrayContaining([RECIPIENT, HIDDEN]));

    const delivered = await backend.search({
      folder: null, query: null, from: null, subject: `${marker}-v2`,
      since: null, before: null, unreadOnly: false, limit: 5,
    });
    expect(delivered.length).toBeGreaterThan(0);
    const deliveredFull = await backend.getMessage(delivered[0]!.id);
    expect(/^bcc:/im.test(deliveredFull.rawHeaders)).toBe(false);  // wire copy has no Bcc header

    const sentCopy = await backend.search({
      folder: "Sent", query: null, from: null, subject: `${marker}-v2`,
      since: null, before: null, unreadOnly: false, limit: 5,
    });
    expect(sentCopy.length).toBe(1);

    await expect(backend.getMessage(updatedId)).rejects.toThrow("not found");
  });

  it("encodes display names correctly in the composed MIME", async () => {
    const draftId = await backend.createDraft({
      ...EMPTY, to: [{ name: "Hermes Agent", address: "agent@example.test" }],
      subject: `${marker}-names`, body: "check names",
    });
    const raw = await backend.getMessage(draftId);
    expect(raw.to[0]).toEqual({ name: "Hermes Agent", address: "agent@example.test" });
  });

  it("threads replies with In-Reply-To and Re: subject, preserved across update", async () => {
    const replyId = await backend.createDraft({ ...EMPTY, replyToMessageId: inboxId, body: "A reply." });
    const reply = await backend.getMessage(replyId);
    expect(reply.subject).toBe(`Re: seed-${marker}`);
    expect(reply.rawHeaders.toLowerCase()).toContain("in-reply-to");
    const revisedId = await backend.updateDraft(replyId, { ...EMPTY, body: "A better reply." });
    const revised = await backend.getMessage(revisedId);
    expect(revised.rawHeaders.toLowerCase()).toContain("in-reply-to");
  });

  it("strips Bcc even when it is the final header line, with no trailing CRLF before the blank separator", () => {
    const exposed = new ExposedBackend("test", imapMailboxConfig());
    const source = Buffer.from(
      "From: a@x.test\r\nTo: b@x.test\r\nBcc: x@y.z\r\n\r\nBody text.",
      "utf8",
    );
    const wire = exposed.stripBcc(source).toString("utf8");
    expect(/^bcc:/im.test(wire)).toBe(false);
    expect(wire).toBe("From: a@x.test\r\nTo: b@x.test\r\n\r\nBody text.");
  });
});
