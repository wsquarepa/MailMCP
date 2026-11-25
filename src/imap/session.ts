import { setTimeout as delay } from "node:timers/promises";
import { ImapFlow } from "imapflow";
import type { MailboxConfig } from "../config.js";
import { BackendUnavailableError, ToolError } from "../errors.js";
import { logger } from "../logger.js";
import type { SpecialFolder } from "../types.js";

export type ImapMailboxConfig = Extract<MailboxConfig, { backend: "imap" }>;

const SPECIAL_USE_FLAGS: Record<string, SpecialFolder> = {
  "\\Junk": "junk",
  "\\Trash": "trash",
  "\\Archive": "archive",
  "\\Drafts": "drafts",
  "\\Sent": "sent",
};

const NAME_FALLBACKS: Record<Exclude<SpecialFolder, "inbox">, string[]> = {
  junk: ["Junk", "Spam", "Junk Email"],
  trash: ["Trash", "Deleted Items", "Deleted Messages"],
  archive: ["Archive", "Archives"],
  drafts: ["Drafts"],
  sent: ["Sent", "Sent Items", "Sent Messages"],
};

const CREATE_NAMES: Record<Exclude<SpecialFolder, "inbox">, string> = {
  junk: "Junk", trash: "Trash", archive: "Archive", drafts: "Drafts", sent: "Sent",
};

const RECONNECT_DELAY_MS = 250;

export class ImapSession {
  private client: ImapFlow | null = null;
  private specialCache: Partial<Record<SpecialFolder, string>> | null = null;

  constructor(
    private readonly mailboxName: string,
    private readonly config: ImapMailboxConfig,
  ) {}

  private async connect(): Promise<ImapFlow> {
    const client = new ImapFlow({
      host: this.config.imap.host,
      port: this.config.imap.port,
      secure: this.config.imap.secure,
      auth: { user: this.config.imap.user, pass: this.config.imap.pass },
      logger: false,
    });
    // ImapFlow closes the connection itself before emitting 'error' (e.g. a
    // socket idle past its 5 min timeout); without a listener Node treats
    // the event as uncaught and the whole server exits.
    client.on("error", (error: unknown) => {
      logger.warn({ mailbox: this.mailboxName, error: String(error) }, "imap connection error");
    });
    client.on("close", () => {
      if (this.client === client) this.client = null;
    });
    await client.connect();
    return client;
  }

  private discardClient(): void {
    const client = this.client;
    this.client = null;
    client?.close();
  }

  private async currentClient(): Promise<ImapFlow> {
    if (this.client === null || !this.client.usable) {
      this.client = await this.connect();
    }
    return this.client;
  }

  // Idempotent commands only. ToolError passes through untouched; anything
  // else gets exactly one reconnect + replay before surfacing as transient.
  async withClient<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.currentClient());
    } catch (error) {
      if (error instanceof ToolError) throw error;
      logger.warn(
        { mailbox: this.mailboxName, error: String(error) },
        "imap command failed, reconnecting once",
      );
      this.discardClient();
      await delay(RECONNECT_DELAY_MS);
      try {
        return await fn(await this.currentClient());
      } catch (retryError) {
        if (retryError instanceof ToolError) throw retryError;
        this.discardClient();
        throw new BackendUnavailableError(this.mailboxName, String(retryError));
      }
    }
  }

  // Bounded variant for commands whose duration is server-controlled (an
  // unindexed SEARCH scans message bodies linearly). On expiry the client is
  // closed so the in-flight command aborts and its mailbox lock dies with the
  // connection; the next call reconnects lazily. No replay: a command that
  // exceeded the deadline once would almost certainly exceed it again.
  async withClientDeadline<T>(timeoutMs: number, fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    return this.withClientOnce(async (client) => {
      let timer: NodeJS.Timeout | undefined;
      const expiry = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          this.client = null;
          client.close();
          reject(new BackendUnavailableError(
            this.mailboxName,
            `command timed out after ${timeoutMs}ms; the server is scanning slowly. Narrow the search, e.g. subject/from/since criteria instead of a free-text query`,
          ));
        }, timeoutMs);
      });
      try {
        return await Promise.race([fn(client), expiry]);
      } finally {
        clearTimeout(timer);
      }
    });
  }

  // Non-idempotent commands (APPEND, MOVE, delete): one attempt, no replay.
  async withClientOnce<T>(fn: (client: ImapFlow) => Promise<T>): Promise<T> {
    try {
      return await fn(await this.currentClient());
    } catch (error) {
      if (error instanceof ToolError) throw error;
      this.discardClient();
      throw new BackendUnavailableError(this.mailboxName, String(error));
    }
  }

  async specialFolders(): Promise<Partial<Record<SpecialFolder, string>>> {
    if (this.specialCache !== null) return this.specialCache;
    const resolved = await this.withClient(async (client) => {
      const listed = await client.list();
      const byRole: Partial<Record<SpecialFolder, string>> = { inbox: "INBOX" };
      for (const folder of listed) {
        const role = folder.specialUse !== undefined ? SPECIAL_USE_FLAGS[folder.specialUse] : undefined;
        if (role !== undefined && byRole[role] === undefined) byRole[role] = folder.path;
      }
      const paths = new Set(listed.map((f) => f.path));
      for (const role of Object.keys(NAME_FALLBACKS) as (keyof typeof NAME_FALLBACKS)[]) {
        if (byRole[role] !== undefined) continue;
        const existing = NAME_FALLBACKS[role].find((name) => paths.has(name));
        if (existing !== undefined) byRole[role] = existing;
      }
      return byRole;
    });
    this.specialCache = resolved;
    return resolved;
  }

  async ensureSpecialFolder(role: Exclude<SpecialFolder, "inbox">): Promise<string> {
    const resolved = (await this.specialFolders())[role];
    if (resolved !== undefined) return resolved;
    const name = CREATE_NAMES[role];
    try {
      await this.withClientOnce(async (client) => {
        await client.mailboxCreate(name);
      });
    } catch (error) {
      // CREATE lost a race with another client: servers without RFC 5530
      // answer a duplicate CREATE with a plain NO, which ImapFlow cannot
      // distinguish from a real failure. The cached folder map is stale in
      // exactly that case, so re-list and fail only if the role is still
      // missing.
      this.specialCache = null;
      const refreshed = (await this.specialFolders())[role];
      if (refreshed !== undefined) return refreshed;
      throw error;
    }
    this.specialCache = null;
    return name;
  }

  async close(): Promise<void> {
    if (this.client !== null) {
      await this.client.logout().catch(() => this.client?.close());
      this.client = null;
    }
  }
}
