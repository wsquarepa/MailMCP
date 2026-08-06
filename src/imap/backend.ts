import { randomUUID } from "node:crypto";
import type { Readable } from "node:stream";
import { simpleParser, type AddressObject } from "mailparser";
import type { ParsedMail } from "mailparser";
import { createTransport } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import type Mail from "nodemailer/lib/mailer/index.js";
import {
  BackendUnavailableError, InvalidInputError, NotFoundError, SentButUnreconciledError, ToolError,
} from "../errors.js";
import { logger } from "../logger.js";
import { parseAuthResults } from "../mail/authresults.js";
import {
  BODY_MAX_CHARS, SNIPPET_MAX_CHARS, htmlToPlainText, makeSnippet,
  stripQuotedAndSignature, truncateBody,
} from "../mail/clean.js";
import type {
  Address, AttachmentContent, AttachmentMeta, BulkResult, DraftInput, Folder,
  ListOptions, MailBackend, MessageFull, MessageSummary, SearchOptions, SendResult,
} from "../types.js";
import { ImapSession, type ImapMailboxConfig } from "./session.js";

const SNIPPET_FETCH_BYTES = 2048;

export function parseImapId(id: string): { folder: string; uid: number } {
  const separator = id.lastIndexOf(":");
  const uid = Number(id.slice(separator + 1));
  if (separator <= 0 || !Number.isInteger(uid) || uid <= 0) {
    throw new InvalidInputError(`'${id}' is not a valid imap message id (expected FOLDER:UID)`);
  }
  return { folder: id.slice(0, separator), uid };
}

export function toAddress(parsed: AddressObject | AddressObject[] | undefined): Address[] {
  if (parsed === undefined) return [];
  const objects = Array.isArray(parsed) ? parsed : [parsed];
  return objects.flatMap((o) =>
    o.value.map((v) => ({ name: v.name, address: v.address ?? "" })),
  );
}

async function readPrefix(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    chunks.push(chunk);
    total += chunk.length;
    if (total >= maxBytes) {
      stream.destroy();
      break;
    }
  }
  return Buffer.concat(chunks).subarray(0, maxBytes);
}

interface BodyPart {
  part: string;
  type: string;
  size: number;
  encoding: string;
  filename: string | null;
  disposition: string | null;
}

// Depth-first walk; the resulting order is the stable attachment index order
// shared by getMessage metadata and getAttachment.
function walkBodyStructure(node: Record<string, unknown>, path: string, out: BodyPart[]): void {
  const children = node["childNodes"] as Record<string, unknown>[] | undefined;
  if (children !== undefined) {
    children.forEach((child, i) => {
      const childPath = path === "" ? String(i + 1) : `${path}.${i + 1}`;
      walkBodyStructure(child, childPath, out);
    });
    return;
  }
  const params = (node["parameters"] ?? {}) as Record<string, string>;
  const dispositionParams = (node["dispositionParameters"] ?? {}) as Record<string, string>;
  out.push({
    part: node["part"] as string ?? (path === "" ? "1" : path),
    type: (node["type"] as string | undefined) ?? "application/octet-stream",
    size: (node["size"] as number | undefined) ?? 0,
    encoding: (node["encoding"] as string | undefined) ?? "7bit",
    filename: dispositionParams["filename"] ?? params["name"] ?? null,
    disposition: (node["disposition"] as string | undefined) ?? null,
  });
}

function leafParts(bodyStructure: Record<string, unknown>): BodyPart[] {
  const out: BodyPart[] = [];
  walkBodyStructure(bodyStructure, "", out);
  return out;
}

function attachmentParts(bodyStructure: Record<string, unknown>): BodyPart[] {
  return leafParts(bodyStructure).filter(
    (p) => p.disposition === "attachment" || (p.filename !== null && !p.type.startsWith("text/")),
  );
}

function textPart(bodyStructure: Record<string, unknown>): BodyPart | null {
  const leaves = leafParts(bodyStructure).filter((p) => p.disposition !== "attachment");
  return leaves.find((p) => p.type === "text/plain") ?? leaves.find((p) => p.type === "text/html") ?? null;
}

export class ImapSmtpBackend implements MailBackend {
  private readonly session: ImapSession;

  constructor(
    private readonly mailboxName: string,
    private readonly config: ImapMailboxConfig,
  ) {
    this.session = new ImapSession(mailboxName, config);
  }

  private async inboxFolder(): Promise<string> {
    return (await this.session.specialFolders()).inbox ?? "INBOX";
  }

  private surfacedFromHeaders(headerText: string): Record<string, string> {
    const result: Record<string, string> = {};
    const unfolded = headerText.replace(/\r?\n[ \t]+/g, " ");
    for (const name of this.config.surface_headers ?? []) {
      const match = unfolded.match(new RegExp(`^${name}:\\s*(.+)$`, "im"));
      if (match?.[1] !== undefined) result[name] = match[1].trim();
    }
    return result;
  }

  async listFolders(): Promise<Folder[]> {
    const special = await this.session.specialFolders();
    const byPath = new Map(
      Object.entries(special).map(([role, path]) => [path, role as Folder["specialUse"]]),
    );
    return this.session.withClient(async (client) => {
      const listed = await client.list();
      return listed.map((f) => ({ name: f.path, specialUse: byPath.get(f.path) ?? null }));
    });
  }

  // One batched FETCH for page metadata, then bounded per-message snippet
  // downloads. Never fetches full sources during listing.
  private async summariesFor(folder: string, uids: number[]): Promise<MessageSummary[]> {
    return this.session.withClient(async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const headerFields = (this.config.surface_headers ?? []).map((h) => h.toLowerCase());
        interface FetchedMeta {
          uid: number;
          envelope: Record<string, unknown> | undefined;
          flags: Set<string>;
          bodyStructure: Record<string, unknown> | undefined;
          headers: Buffer | undefined;
        }
        const metas: FetchedMeta[] = [];
        for await (const message of client.fetch(
          uids.join(","),
          { uid: true, envelope: true, flags: true, bodyStructure: true, headers: headerFields },
          { uid: true },
        )) {
          metas.push({
            uid: message.uid,
            envelope: message.envelope as unknown as Record<string, unknown> | undefined,
            flags: message.flags ?? new Set<string>(),
            bodyStructure: message.bodyStructure as unknown as Record<string, unknown> | undefined,
            headers: message.headers,
          });
        }
        metas.sort((a, b) => uids.indexOf(a.uid) - uids.indexOf(b.uid));
        const summaries: MessageSummary[] = [];
        for (const meta of metas) {
          summaries.push(await this.metaToSummary(client, folder, meta));
        }
        return summaries;
      } finally {
        lock.release();
      }
    });
  }

  private async metaToSummary(
    client: import("imapflow").ImapFlow,
    folder: string,
    meta: {
      uid: number;
      envelope: Record<string, unknown> | undefined;
      flags: Set<string>;
      bodyStructure: Record<string, unknown> | undefined;
      headers: Buffer | undefined;
    },
  ): Promise<MessageSummary> {
    const envelope = meta.envelope ?? {};
    const fromEntry = (envelope["from"] as { name?: string; address?: string }[] | undefined)?.[0];
    let snippet = "";
    if (meta.bodyStructure !== undefined) {
      const part = textPart(meta.bodyStructure);
      if (part !== null) {
        const download = await client.download(String(meta.uid), part.part, { uid: true });
        const prefix = await readPrefix(download.content, SNIPPET_FETCH_BYTES);
        const text = part.type === "text/html" ? htmlToPlainText(prefix.toString("utf8")) : prefix.toString("utf8");
        snippet = makeSnippet(stripQuotedAndSignature(text), SNIPPET_MAX_CHARS);
      }
    }
    return {
      id: `${folder}:${meta.uid}`,
      from: fromEntry !== undefined
        ? { name: fromEntry.name ?? "", address: fromEntry.address ?? "" }
        : null,
      subject: (envelope["subject"] as string | undefined) ?? "(no subject)",
      date: (envelope["date"] as Date | undefined) ?? null,
      unread: !meta.flags.has("\\Seen"),
      hasAttachments: meta.bodyStructure !== undefined && attachmentParts(meta.bodyStructure).length > 0,
      snippet,
      surfacedHeaders: this.surfacedFromHeaders(meta.headers?.toString("utf8") ?? ""),
    };
  }

  private async pageUids(
    folder: string,
    includeRead: boolean,
    limit: number,
    offset: number,
  ): Promise<number[]> {
    return this.session.withClient(async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const uids = await client.search(includeRead ? { all: true } : { seen: false }, { uid: true });
        if (uids === false || uids.length === 0) return [];
        return uids.sort((a, b) => b - a).slice(offset, offset + limit);
      } finally {
        lock.release();
      }
    });
  }

  async listMessages(options: ListOptions): Promise<MessageSummary[]> {
    const folder = options.folder ?? (await this.inboxFolder());
    const page = await this.pageUids(folder, options.includeRead, options.limit, options.offset);
    if (page.length === 0) return [];
    return this.summariesFor(folder, page);
  }

  async search(options: SearchOptions): Promise<MessageSummary[]> {
    const folder = options.folder ?? (await this.inboxFolder());
    const uids = await this.session.withClient(async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const criteria: Record<string, unknown> = {};
        if (options.query !== null) criteria["text"] = options.query;
        if (options.from !== null) criteria["from"] = options.from;
        if (options.subject !== null) criteria["subject"] = options.subject;
        if (options.since !== null) criteria["since"] = options.since;
        if (options.before !== null) criteria["before"] = options.before;
        if (options.unreadOnly) criteria["seen"] = false;
        const found = await client.search(criteria, { uid: true });
        if (found === false || found.length === 0) return [];
        return found.sort((a, b) => b - a).slice(0, options.limit);
      } finally {
        lock.release();
      }
    });
    if (uids.length === 0) return [];
    return this.summariesFor(folder, uids);
  }

  // Single-message full fetch; used by getMessage and Task 10 draft paths.
  protected async fetchRaw(id: string): Promise<{ folder: string; uid: number; source: Buffer; flags: Set<string> }> {
    const { folder, uid } = parseImapId(id);
    return this.session.withClient(async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const message = await client.fetchOne(
          String(uid), { uid: true, source: true, flags: true }, { uid: true },
        );
        if (message === false || message.source === undefined) throw new NotFoundError(id);
        return { folder, uid, source: message.source, flags: message.flags ?? new Set<string>() };
      } finally {
        lock.release();
      }
    });
  }

  async getMessage(id: string): Promise<MessageFull> {
    const { folder, uid, source, flags } = await this.fetchRaw(id);
    const parsed = await simpleParser(source);
    const rawHeaders = parsed.headerLines.map((h) => h.line).join("\r\n");
    const text = parsed.text ?? (parsed.html !== false ? htmlToPlainText(parsed.html) : "");
    const { text: bodyText, truncated } = truncateBody(text.trim(), BODY_MAX_CHARS);
    const structure = await this.bodyStructureOf(folder, uid);
    const attachments: AttachmentMeta[] = attachmentParts(structure).map((p, index) => ({
      index,
      filename: p.filename ?? `attachment-${index}`,
      mimeType: p.type,
      size: p.size,
    }));
    const from = toAddress(parsed.from)[0] ?? null;
    return {
      id: `${folder}:${uid}`,
      from,
      subject: parsed.subject ?? "(no subject)",
      date: parsed.date ?? null,
      unread: !flags.has("\\Seen"),
      hasAttachments: attachments.length > 0,
      snippet: makeSnippet(stripQuotedAndSignature(text), SNIPPET_MAX_CHARS),
      surfacedHeaders: this.surfacedFromHeaders(rawHeaders),
      replyTo: toAddress(parsed.replyTo)[0] ?? null,
      returnPath: parsed.headers.get("return-path")?.toString() ?? null,
      to: toAddress(parsed.to),
      cc: toAddress(parsed.cc),
      auth: parseAuthResults(rawHeaders),
      bodyText,
      bodyTruncated: truncated,
      attachments,
      rawHeaders,
    };
  }

  private async bodyStructureOf(folder: string, uid: number): Promise<Record<string, unknown>> {
    return this.session.withClient(async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const message = await client.fetchOne(String(uid), { uid: true, bodyStructure: true }, { uid: true });
        if (message === false || message.bodyStructure === undefined) {
          throw new NotFoundError(`${folder}:${uid}`);
        }
        return message.bodyStructure as unknown as Record<string, unknown>;
      } finally {
        lock.release();
      }
    });
  }

  async getAttachment(id: string, index: number, maxBytes: number): Promise<AttachmentContent> {
    const { folder, uid } = parseImapId(id);
    const structure = await this.bodyStructureOf(folder, uid);
    const part = attachmentParts(structure)[index];
    if (part === undefined) throw new NotFoundError(`${id} attachment ${index}`);
    // part.size is the transfer-encoded size (base64 inflates ~33%), so this
    // pre-download check is conservative rather than exact.
    if (part.size > maxBytes) {
      throw new ToolError(
        `Attachment '${part.filename ?? index}' is ${part.size} bytes (encoded), over the ${maxBytes} byte limit; it cannot be fetched through this tool.`,
      );
    }
    return this.session.withClient(async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        const download = await client.download(String(uid), part.part, { uid: true });
        const content = await readPrefix(download.content, maxBytes + 1);
        return {
          filename: part.filename ?? `attachment-${index}`,
          mimeType: part.type,
          size: content.length,
          content,
        };
      } finally {
        lock.release();
      }
    });
  }

  private async assertDraftId(id: string): Promise<{ folder: string; uid: number }> {
    const parsed = parseImapId(id);
    const drafts = await this.session.ensureSpecialFolder("drafts");
    if (parsed.folder !== drafts) {
      throw new InvalidInputError(
        `message ${id} is in '${parsed.folder}', not the Drafts folder; only drafts can be updated or sent`,
      );
    }
    return parsed;
  }

  private toMailAddresses(addresses: Address[]): { name: string; address: string }[] {
    return addresses.map((a) => ({ name: a.name, address: a.address }));
  }

  private async composeMime(
    input: DraftInput,
    base: ParsedMail | null,
  ): Promise<{ raw: Buffer; messageId: string }> {
    const threading =
      input.replyToMessageId !== null
        ? await this.threadingFromOriginal(input.replyToMessageId)
        : base !== null
          ? this.threadingFromParsed(base)
          : null;
    const baseText = base === null ? null : base.text ?? (base.html !== false ? htmlToPlainText(base.html) : "");
    const messageId = `<${randomUUID()}@mailmcp.local>`;
    const options: Mail.Options = {
      from: this.config.address,
      to: this.toMailAddresses(input.to ?? (base !== null ? toAddress(base.to) : [])),
      cc: this.toMailAddresses(input.cc ?? (base !== null ? toAddress(base.cc) : [])),
      bcc: this.toMailAddresses(input.bcc ?? (base !== null ? toAddress(base.bcc) : [])),
      subject: input.subject ?? base?.subject ?? "",
      text: input.body ?? baseText ?? "",
      messageId,
      attachments:
        input.attachments !== null
          ? input.attachments.map((a) => ({
              filename: a.filename,
              contentType: a.mimeType,
              content: Buffer.from(a.contentBase64, "base64"),
            }))
          : (base?.attachments ?? []).map((a) => ({
              filename: a.filename ?? "attachment",
              contentType: a.contentType,
              content: a.content,
            })),
    };
    if (threading !== null) {
      options.inReplyTo = threading.inReplyTo;
      options.references = threading.references;
    }
    // MailComposer ignores a keepBcc mail option; keepBcc lives on the MIME
    // node. Set it on the compiled root so the STORED draft retains Bcc (the
    // Bcc header is stripped from transmitted bytes at send time).
    const compiled = new MailComposer(options).compile();
    compiled.keepBcc = true;
    return { raw: await compiled.build(), messageId };
  }

  // Reply threading per RFC 5322 3.6.4: In-Reply-To = original Message-ID,
  // References = original chain + that id.
  private async threadingFromOriginal(
    originalId: string,
  ): Promise<{ inReplyTo: string; references: string }> {
    const { source } = await this.fetchRaw(originalId);
    const parsed = await simpleParser(source);
    const messageId = parsed.messageId ?? "";
    const priorRefs = parsed.references === undefined
      ? []
      : Array.isArray(parsed.references) ? parsed.references : [parsed.references];
    return { inReplyTo: messageId, references: [...priorRefs, messageId].join(" ") };
  }

  private threadingFromParsed(base: ParsedMail): { inReplyTo: string; references: string } | null {
    const inReplyTo = base.inReplyTo;
    if (inReplyTo === undefined) return null;
    const refs = base.references === undefined
      ? [inReplyTo]
      : Array.isArray(base.references) ? base.references : [base.references];
    return { inReplyTo, references: refs.join(" ") };
  }

  private async appendDraft(raw: Buffer, messageId: string): Promise<string> {
    const drafts = await this.session.ensureSpecialFolder("drafts");
    return this.session.withClientOnce(async (client) => {
      const appended = await client.append(drafts, raw, ["\\Draft"]);
      if (appended !== false && appended.uid !== undefined) {
        return `${drafts}:${appended.uid}`;
      }
      // No APPENDUID: the append may still have succeeded. Recover the uid by
      // the unique Message-ID instead of reporting a false failure.
      const lock = await client.getMailboxLock(drafts);
      try {
        const found = await client.search({ header: { "message-id": messageId } }, { uid: true });
        if (found !== false && found.length === 1) return `${drafts}:${found[0]!}`;
      } finally {
        lock.release();
      }
      throw new BackendUnavailableError(
        this.mailboxName,
        `draft append gave no APPENDUID and Message-ID search found no unique match; the draft may or may not exist in ${drafts}`,
      );
    });
  }

  async createDraft(input: DraftInput): Promise<string> {
    let effective = input;
    if (input.replyToMessageId !== null) {
      const { source } = await this.fetchRaw(input.replyToMessageId);
      const original = await simpleParser(source);
      const replyTarget = toAddress(original.replyTo)[0] ?? toAddress(original.from)[0] ?? null;
      const subject = original.subject ?? "";
      effective = {
        ...input,
        subject: input.subject ?? (subject.startsWith("Re:") ? subject : `Re: ${subject}`),
        to: input.to ?? (replyTarget !== null ? [replyTarget] : null),
      };
    }
    const { raw, messageId } = await this.composeMime(effective, null);
    return this.appendDraft(raw, messageId);
  }

  async updateDraft(id: string, input: DraftInput): Promise<string> {
    await this.assertDraftId(id);
    const { source } = await this.fetchRaw(id);
    const base = await simpleParser(source);
    const { raw, messageId } = await this.composeMime(input, base);
    const newId = await this.appendDraft(raw, messageId);
    await this.deleteHard(id);
    return newId;
  }

  // Removes Bcc (with folded continuations) from the header block only.
  private stripBccHeader(source: Buffer): Buffer {
    const splitAt = source.indexOf("\r\n\r\n");
    if (splitAt < 0) return source;
    const header = source.subarray(0, splitAt).toString("utf8");
    const cleaned = header.replace(/^bcc:.*(?:\r\n[ \t].*)*\r\n?/gim, "").replace(/\r\n$/, "");
    return Buffer.concat([Buffer.from(cleaned, "utf8"), source.subarray(splitAt)]);
  }

  async sendDraft(id: string): Promise<SendResult> {
    await this.assertDraftId(id);
    const { source } = await this.fetchRaw(id);
    const parsed = await simpleParser(source);
    const recipients = [...toAddress(parsed.to), ...toAddress(parsed.cc), ...toAddress(parsed.bcc)];
    if (recipients.length === 0) {
      throw new InvalidInputError(`draft ${id} has no recipients; update_draft it with a 'to' first`);
    }
    const wire = this.stripBccHeader(source);
    const transport = createTransport({
      host: this.config.smtp.host,
      port: this.config.smtp.port,
      secure: this.config.smtp.secure,
      auth: this.config.smtp.user !== "" ? { user: this.config.smtp.user, pass: this.config.smtp.pass } : undefined,
    });
    await transport.sendMail({
      envelope: {
        from: toAddress(parsed.from)[0]?.address ?? this.config.address,
        to: recipients.map((r) => r.address),
      },
      raw: wire,
    });
    // COMMIT POINT: recipients have the message. Nothing below may throw.
    let warning: string | null = null;
    try {
      const sent = await this.session.ensureSpecialFolder("sent");
      await this.session.withClientOnce(async (client) => {
        await client.append(sent, wire, ["\\Seen"]);
      });
      await this.deleteHard(id);
    } catch (error) {
      warning = new SentButUnreconciledError(id, String(error)).message;
      logger.error({ mailbox: this.mailboxName, id, error: String(error) }, "post-send reconciliation failed");
    }
    return { recipients, warning };
  }

  // Permanent removal is intentionally private: only draft replacement and
  // post-send cleanup use it. The public delete path is deleteToTrash.
  private async deleteHard(id: string): Promise<void> {
    const { folder, uid } = parseImapId(id);
    await this.session.withClientOnce(async (client) => {
      const lock = await client.getMailboxLock(folder);
      try {
        await client.messageDelete(String(uid), { uid: true });
      } finally {
        lock.release();
      }
    });
  }

  async move(_ids: string[], _target: string): Promise<BulkResult> { throw new Error("not implemented"); }
  async markRead(_ids: string[]): Promise<BulkResult> { throw new Error("not implemented"); }
  async markUnread(_ids: string[]): Promise<BulkResult> { throw new Error("not implemented"); }
  async deleteToTrash(_ids: string[]): Promise<BulkResult> { throw new Error("not implemented"); }

  async close(): Promise<void> {
    await this.session.close();
  }
}
