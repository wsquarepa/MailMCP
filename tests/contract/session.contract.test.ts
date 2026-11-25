import type { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { ImapFlow } from "imapflow";
import { afterAll, describe, expect, it } from "vitest";
import { BackendUnavailableError, NotFoundError } from "../../src/errors.js";
import { ImapSession } from "../../src/imap/session.js";
import { imapMailboxConfig, TEST_USER } from "../helpers/greenmail.js";
import { startStrictImapProxy } from "../helpers/strictImapProxy.js";

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

  // GreenMail answers a duplicate CREATE with a plain NO (no RFC 5530
  // ALREADYEXISTS code), like many servers; ensureSpecialFolder must not
  // surface that as a failure when the folder exists.
  it("ensureSpecialFolder resolves a role folder created externally after the cache was populated", async () => {
    const external = new ImapFlow({
      host: "localhost", port: 3143, secure: false, auth: TEST_USER, logger: false,
    });
    await external.connect();
    const listed = (await external.list()).map((f) => f.path);
    if (listed.includes("Archive")) await external.mailboxDelete("Archive");

    const stale = new ImapSession("stale-cache", imapMailboxConfig());
    try {
      const special = await stale.specialFolders();
      expect(special.archive).toBeUndefined();
      await external.mailboxCreate("Archive");
      await expect(stale.ensureSpecialFolder("archive")).resolves.toBe("Archive");
    } finally {
      await stale.close();
      await external.logout();
    }
  });

  it("withClientDeadline returns the value when fn finishes inside the deadline", async () => {
    const folders = await session.withClientDeadline(5_000, async (client) =>
      (await client.list()).map((f) => f.path),
    );
    expect(folders).toContain("INBOX");
  });

  it("withClientDeadline tears down the connection on expiry and the session recovers", async () => {
    const slow = new ImapSession("deadline", imapMailboxConfig());
    try {
      const start = Date.now();
      const error = await slow.withClientDeadline(200, async (client) => {
        const lock = await client.getMailboxLock("INBOX");
        try {
          await delay(3_000);
        } finally {
          lock.release();
        }
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BackendUnavailableError);
      expect(String(error)).toMatch(/timed out after 200ms/);
      expect(Date.now() - start).toBeLessThan(2_000);
      // A fresh connection must not inherit the dead one's mailbox lock.
      const folders = await slow.withClient(async (client) =>
        (await client.list()).map((f) => f.path),
      );
      expect(folders).toContain("INBOX");
    } finally {
      await slow.close();
    }
  });

  it("closes every connection it discards after a failed command", async () => {
    const proxy = await startStrictImapProxy(3143);
    const base = imapMailboxConfig();
    const failing = new ImapSession("discard", { ...base, imap: { ...base.imap, port: proxy.port } });
    try {
      const error = await failing.withClient(async () => {
        throw new Error("simulated server failure");
      }).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(BackendUnavailableError);
      await delay(200);
      expect(proxy.openConnections()).toBe(0);
    } finally {
      await failing.close();
      await proxy.close();
    }
  });

  // ImapFlow emits 'error' on an inactive socket (5 min by default); with no
  // listener Node treats it as uncaught and the process exits. The socket is
  // not part of ImapFlow's typed API, so the test shortens its timeout directly.
  it("survives an idle socket timeout and reconnects", async () => {
    const idle = new ImapSession("idle", imapMailboxConfig());
    try {
      await idle.withClient(async (client) => {
        (client as unknown as { socket: Socket }).socket.setTimeout(100);
      });
      await delay(500);
      const folders = await idle.withClient(async (client) => (await client.list()).map((f) => f.path));
      expect(folders).toContain("INBOX");
    } finally {
      await idle.close();
    }
  });

  it("survives a dropped connection by reconnecting once", async () => {
    await session.withClient(async (client) => client.close());
    const folders = await session.withClient(async (client) => await client.list());
    expect(folders.length).toBeGreaterThan(0);
  });
});
