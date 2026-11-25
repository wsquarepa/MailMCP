import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ImapSmtpBackend } from "../../src/imap/backend.js";
import { InvalidInputError, NotFoundError, ToolError } from "../../src/errors.js";
import { imapMailboxConfig, seedMessage } from "../helpers/greenmail.js";
import { startStrictImapProxy } from "../helpers/strictImapProxy.js";

const NO_SEARCH = {
  folder: null, query: null, from: null, subject: null,
  since: null, before: null, unreadOnly: false, limit: 10,
};

describe("ImapSmtpBackend reads (requires GreenMail)", () => {
  const backend = new ImapSmtpBackend("test", imapMailboxConfig());
  const subject = `read-test-${process.pid}-${Math.floor(performance.now())}`;

  beforeAll(async () => {
    await seedMessage(subject, "First line of the body.\n> quoted noise", {
      "X-Spam-Score": "-4.2",
    }, [{ filename: "big.bin", content: Buffer.alloc(1024 * 1024, 7) }]);
  });
  afterAll(async () => await backend.close());

  it("lists unread inbox messages with snippet, surfaced headers, attachment flag", async () => {
    const messages = await backend.listMessages({
      folder: null, includeRead: false, limit: 20, offset: 0,
    });
    const found = messages.find((m) => m.subject === subject);
    expect(found).toBeDefined();
    expect(found?.unread).toBe(true);
    expect(found?.snippet).toContain("First line of the body.");
    expect(found?.snippet).not.toContain("quoted noise");
    expect(found?.surfacedHeaders["X-Spam-Score"]).toBe("-4.2");
    expect(found?.hasAttachments).toBe(true);
    expect(found?.id).toMatch(/^INBOX:\d+$/);
  });

  it("gets the full message with auth results, raw headers, attachment meta", async () => {
    const messages = await backend.listMessages({ folder: null, includeRead: true, limit: 50, offset: 0 });
    const id = messages.find((m) => m.subject === subject)?.id;
    expect(id).toBeDefined();
    const full = await backend.getMessage(id!);
    expect(full.bodyMarkdown).toContain("First line of the body.");
    expect(full.rawHeaders.toLowerCase()).toContain("x-spam-score");
    expect(full.from?.address).toBe("sender@example.test");
    expect(full.attachments[0]?.filename).toBe("big.bin");
  });

  it("refuses an over-cap attachment before download and serves small caps fine", async () => {
    const messages = await backend.listMessages({ folder: null, includeRead: true, limit: 50, offset: 0 });
    const id = messages.find((m) => m.subject === subject)!.id;
    await expect(backend.getAttachment(id, 0, 1024)).rejects.toThrow(ToolError);
    const content = await backend.getAttachment(id, 0, 10 * 1024 * 1024);
    expect(content.content.length).toBe(1024 * 1024);
  });

  it("searches by subject within an explicit folder", async () => {
    const hits = await backend.search({ ...NO_SEARCH, folder: "INBOX", subject });
    expect(hits.some((m) => m.subject === subject)).toBe(true);
  });

  it("raises NotFoundError for a vanished uid", async () => {
    await expect(backend.getMessage("INBOX:999999")).rejects.toThrow(NotFoundError);
  });

  it("lists messages on a strict server when the mailbox configures no surface_headers", async () => {
    const proxy = await startStrictImapProxy(3143);
    const { surface_headers: _omitted, ...bare } = imapMailboxConfig();
    const plain = new ImapSmtpBackend("bare", { ...bare, imap: { ...bare.imap, port: proxy.port } });
    try {
      const messages = await plain.listMessages({ folder: null, includeRead: true, limit: 50, offset: 0 });
      const found = messages.find((m) => m.subject === subject);
      expect(found).toBeDefined();
      expect(found?.surfacedHeaders).toEqual({});
    } finally {
      await plain.close();
      await proxy.close();
    }
  });

  it("raises InvalidInputError naming the unknown folder and available folders when listing a bogus folder", async () => {
    const error = await backend
      .listMessages({ folder: "NoSuchFolder-bogus", includeRead: true, limit: 20, offset: 0 })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(InvalidInputError);
    expect((error as Error).message).toContain("NoSuchFolder-bogus");
    expect((error as Error).message).toContain("INBOX");
  });
});
