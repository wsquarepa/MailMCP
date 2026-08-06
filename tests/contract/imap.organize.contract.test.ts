import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ImapSmtpBackend } from "../../src/imap/backend.js";
import { imapMailboxConfig, seedMessage } from "../helpers/greenmail.js";

describe("ImapSmtpBackend organize (requires GreenMail)", () => {
  const backend = new ImapSmtpBackend("test", imapMailboxConfig());
  const subject = `organize-${process.pid}-${Math.floor(performance.now())}`;
  let id = "";

  async function findIn(folder: string): Promise<string> {
    const found = await backend.search({
      folder, query: null, from: null, subject, since: null, before: null, unreadOnly: false, limit: 1,
    });
    expect(found.length).toBe(1);
    return found[0]!.id;
  }

  beforeAll(async () => {
    await seedMessage(subject, "organize me", {}, []);
    id = await findIn("INBOX");
  });
  afterAll(async () => await backend.close());

  it("marks read and unread with per-id results, failing nonexistent uids", async () => {
    const read = await backend.markRead([id, "INBOX:999999"]);
    expect(read.done).toEqual([{ id, newId: id }]);
    expect(read.failed[0]?.id).toBe("INBOX:999999");
    const unread = await backend.markUnread([id]);
    expect(unread.done).toEqual([{ id, newId: id }]);
  });

  it("rejects trash as a move target, naming delete_message", async () => {
    const result = await backend.move([id], "trash");
    expect(result.done).toEqual([]);
    expect(result.failed[0]?.reason).toContain("delete_message");
  });

  it("moves to junk and back without fabricating ids", async () => {
    const toJunk = await backend.move([id], "junk");
    expect(toJunk.failed).toEqual([]);
    expect(toJunk.done).toHaveLength(1);
    const entry = toJunk.done[0]!;
    expect(entry.newId === null || /^Junk:\d+$/.test(entry.newId)).toBe(true);
    const junkId = entry.newId ?? (await findIn("Junk"));
    const back = await backend.move([junkId], "inbox");
    expect(back.done).toHaveLength(1);
    id = back.done[0]!.newId ?? (await findIn("INBOX"));
  });

  it("rejects an unknown folder with the folder list", async () => {
    const result = await backend.move([id], "NoSuchFolder");
    expect(result.failed[0]?.reason).toContain("INBOX");
  });

  it("deletes to trash", async () => {
    const result = await backend.deleteToTrash([id]);
    expect(result.failed).toEqual([]);
    expect(result.done).toHaveLength(1);
    const inTrash = await findIn("Trash");
    expect(inTrash).toMatch(/^Trash:\d+$/);
  });
});
