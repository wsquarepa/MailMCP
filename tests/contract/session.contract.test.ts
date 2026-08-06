import { afterAll, describe, expect, it } from "vitest";
import { NotFoundError } from "../../src/errors.js";
import { ImapSession } from "../../src/imap/session.js";
import { imapMailboxConfig } from "../helpers/greenmail.js";

describe("ImapSession (requires GreenMail)", () => {
  const session = new ImapSession("test", imapMailboxConfig());
  afterAll(async () => await session.close());

  it("connects lazily and lists folders", async () => {
    const folders = await session.withClient(async (client) =>
      (await client.list()).map((f) => f.path),
    );
    expect(folders).toContain("INBOX");
  });

  it("rethrows ToolError immediately without retrying", async () => {
    let calls = 0;
    await expect(
      session.withClient(async () => {
        calls += 1;
        throw new NotFoundError("INBOX:1");
      }),
    ).rejects.toThrow(NotFoundError);
    expect(calls).toBe(1);
  });

  it("resolves special folders purely, without creating any", async () => {
    const before = await session.withClient(async (client) =>
      (await client.list()).map((f) => f.path),
    );
    const special = await session.specialFolders();
    expect(special.inbox).toBe("INBOX");
    const after = await session.withClient(async (client) =>
      (await client.list()).map((f) => f.path),
    );
    expect(after.sort()).toEqual(before.sort());
  });

  it("ensureSpecialFolder creates a missing role folder", async () => {
    const drafts = await session.ensureSpecialFolder("drafts");
    const folders = await session.withClient(async (client) =>
      (await client.list()).map((f) => f.path),
    );
    expect(folders).toContain(drafts);
  });

  it("survives a dropped connection by reconnecting once", async () => {
    await session.withClient(async (client) => client.close());
    const folders = await session.withClient(async (client) => await client.list());
    expect(folders.length).toBeGreaterThan(0);
  });
});
