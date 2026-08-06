import type { MailboxConfig } from "../config.js";
import { AmbiguousIdError, InvalidInputError, NotFoundError, ToolError } from "../errors.js";
import { parseAuthResults } from "../mail/authresults.js";
import {
  BODY_MAX_CHARS, SNIPPET_MAX_CHARS, htmlToPlainText, makeSnippet,
  stripQuotedAndSignature, truncateBody,
} from "../mail/clean.js";
import type {
  Address, AttachmentContent, AttachmentMeta, BulkResult, DraftInput, Folder,
  ListOptions, MailBackend, MessageFull, MessageSummary, SearchOptions, SendResult,
} from "../types.js";
import { GraphHttpError, graphRequest, type GraphConnection } from "./client.js";
import { decodeShortId, encodeShortId, matchesShortId } from "./shortid.js";

export type GraphMailboxConfig = Extract<MailboxConfig, { backend: "graph" }>;

interface GraphRecipient { emailAddress: { name?: string; address: string } }
interface GraphMessage {
  id: string;
  subject?: string;
  from?: GraphRecipient;
  replyTo?: GraphRecipient[];
  toRecipients?: GraphRecipient[];
  ccRecipients?: GraphRecipient[];
  bccRecipients?: GraphRecipient[];
  isRead?: boolean;
  isDraft?: boolean;
  hasAttachments?: boolean;
  receivedDateTime?: string;
  createdDateTime?: string;
  bodyPreview?: string;
  body?: { contentType: string; content: string };
  internetMessageHeaders?: { name: string; value: string }[];
}
interface GraphPage { value: GraphMessage[]; "@odata.nextLink"?: string }

const LIST_SELECT =
  "$select=id,subject,from,isRead,isDraft,hasAttachments,receivedDateTime,createdDateTime,bodyPreview,internetMessageHeaders";
const FULL_SELECT =
  "$select=id,subject,from,replyTo,toRecipients,ccRecipients,bccRecipients,isRead,isDraft,hasAttachments,receivedDateTime,createdDateTime,body,bodyPreview,internetMessageHeaders";
const WELL_KNOWN: Record<string, string> = {
  inbox: "inbox", junk: "junkemail", trash: "deleteditems",
  archive: "archive", drafts: "drafts", sent: "sentitems",
};
const RESOLVE_PAGE = 50;
const AMBIGUOUS = "__ambiguous__";
// Outlook requires the $orderby property to lead the $filter; this clause is
// always true and satisfies that.
const EPOCH_GUARD = { receivedDateTime: "receivedDateTime ge 1970-01-01T00:00:00Z", createdDateTime: "createdDateTime ge 1970-01-01T00:00:00Z" };

function toAddress(recipient: GraphRecipient | undefined): Address | null {
  if (recipient === undefined) return null;
  return { name: recipient.emailAddress.name ?? "", address: recipient.emailAddress.address };
}

function isoSecond(date: Date): string {
  return `${date.toISOString().slice(0, 19)}Z`;
}

export class GraphBackend implements MailBackend {
  private readonly idCache = new Map<string, string>();
  private folderIdCache: Map<string, string> | null = null;

  constructor(
    private readonly mailboxName: string,
    private readonly config: GraphMailboxConfig,
    private readonly connection: GraphConnection,
  ) {}

  clearIdCache(): void {
    this.idCache.clear();
  }

  // 404s become the fixed stale-id taxonomy when we know which id was acted on.
  private async request<T>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body: object | null,
    notFoundId: string | null,
  ): Promise<T> {
    try {
      return await graphRequest<T>(this.connection, method, path, body);
    } catch (error) {
      if (error instanceof GraphHttpError && error.status === 404 && notFoundId !== null) {
        throw new NotFoundError(notFoundId);
      }
      throw error;
    }
  }

  private async folderIds(): Promise<Map<string, string>> {
    if (this.folderIdCache !== null) return this.folderIdCache;
    const map = new Map<string, string>();
    let path: string | null = "/me/mailFolders?$top=100";
    while (path !== null) {
      const page: { value: { id: string; displayName: string; wellKnownName?: string }[]; "@odata.nextLink"?: string } =
        await this.request("GET", path, null, null);
      for (const folder of page.value) {
        map.set(folder.displayName.toLowerCase(), folder.id);
        if (folder.wellKnownName !== undefined) map.set(folder.wellKnownName.toLowerCase(), folder.id);
      }
      path = page["@odata.nextLink"] !== undefined
        ? page["@odata.nextLink"].replace(this.connection.baseUrl, "")
        : null;
    }
    this.folderIdCache = map;
    return map;
  }

  private timestampOf(message: GraphMessage): Date {
    const raw = message.receivedDateTime ?? message.createdDateTime;
    if (raw === undefined) throw new NotFoundError(message.id);
    return new Date(raw);
  }

  private cacheId(shortId: string, nativeId: string): void {
    const existing = this.idCache.get(shortId);
    if (existing !== undefined && existing !== nativeId) {
      this.idCache.set(shortId, AMBIGUOUS);
    } else if (existing !== AMBIGUOUS) {
      this.idCache.set(shortId, nativeId);
    }
  }

  private shortIdFor(message: GraphMessage): string {
    const shortId = encodeShortId(message.id, this.timestampOf(message));
    this.cacheId(shortId, message.id);
    return shortId;
  }

  private async collectRange(basePath: string, filter: string): Promise<GraphMessage[]> {
    const out: GraphMessage[] = [];
    let path: string | null = `${basePath}?$filter=${encodeURIComponent(filter)}&$select=id&$top=${RESOLVE_PAGE}`;
    while (path !== null) {
      const page: GraphPage = await this.request("GET", path, null, null);
      out.push(...page.value);
      path = page["@odata.nextLink"] !== undefined
        ? page["@odata.nextLink"].replace(this.connection.baseUrl, "")
        : null;
    }
    return out;
  }

  // Range filters are mandatory: Graph stores ms precision but renders
  // seconds, so equality on rendered timestamps never matches (verified
  // 2026-08-06). BOTH scopes are always consulted before deciding.
  async resolveId(shortId: string): Promise<string> {
    const cached = this.idCache.get(shortId);
    if (cached === AMBIGUOUS) throw new AmbiguousIdError(shortId);
    if (cached !== undefined) return cached;
    const { second } = decodeShortId(shortId);
    const floor = isoSecond(second);
    const ceiling = isoSecond(new Date(second.getTime() + 1000));
    const candidates = [
      ...(await this.collectRange("/me/messages", `receivedDateTime ge ${floor} and receivedDateTime lt ${ceiling}`)),
      ...(await this.collectRange("/me/mailFolders/drafts/messages", `createdDateTime ge ${floor} and createdDateTime lt ${ceiling}`)),
    ];
    const uniqueIds = [...new Set(candidates.map((m) => m.id))];
    const matches = uniqueIds.filter((id) => matchesShortId(shortId, id));
    if (matches.length > 1) throw new AmbiguousIdError(shortId);
    if (matches.length === 0) throw new NotFoundError(shortId);
    this.cacheId(shortId, matches[0]!);
    return matches[0]!;
  }

  private surfaced(message: GraphMessage): Record<string, string> {
    const wanted = this.config.surface_headers ?? [];
    const result: Record<string, string> = {};
    for (const header of message.internetMessageHeaders ?? []) {
      if (wanted.some((w) => w.toLowerCase() === header.name.toLowerCase())) {
        result[header.name] = header.value;
      }
    }
    return result;
  }

  private toSummary(message: GraphMessage): MessageSummary {
    return {
      id: this.shortIdFor(message),
      from: toAddress(message.from),
      subject: message.subject ?? "(no subject)",
      date: this.timestampOf(message),
      unread: !(message.isRead ?? true),
      hasAttachments: message.hasAttachments ?? false,
      snippet: makeSnippet(stripQuotedAndSignature(message.bodyPreview ?? ""), SNIPPET_MAX_CHARS),
      surfacedHeaders: this.surfaced(message),
    };
  }

  async listFolders(): Promise<Folder[]> {
    const folders = await this.request<{ value: { displayName: string; wellKnownName?: string }[] }>(
      "GET", "/me/mailFolders?$top=100", null, null,
    );
    const roleByWellKnown = new Map(Object.entries(WELL_KNOWN).map(([role, name]) => [name, role]));
    return folders.value.map((f) => ({
      name: f.displayName,
      specialUse: (roleByWellKnown.get(f.wellKnownName ?? "") as Folder["specialUse"]) ?? null,
    }));
  }

  private async folderPath(folder: string | null): Promise<{ path: string; isDrafts: boolean }> {
    const requested = (folder ?? "inbox").toLowerCase();
    const wellKnown = WELL_KNOWN[requested] ?? requested;
    if (Object.values(WELL_KNOWN).includes(wellKnown)) {
      return { path: `/me/mailFolders/${wellKnown}`, isDrafts: wellKnown === "drafts" };
    }
    const id = (await this.folderIds()).get(requested);
    if (id === undefined) {
      const known = [...(await this.folderIds()).keys()].join(", ");
      throw new InvalidInputError(`unknown folder '${folder}'. Folders: ${known}`);
    }
    return { path: `/me/mailFolders/${encodeURIComponent(id)}`, isDrafts: false };
  }

  async listMessages(options: ListOptions): Promise<MessageSummary[]> {
    const { path, isDrafts } = await this.folderPath(options.folder);
    const timeField = isDrafts ? "createdDateTime" : "receivedDateTime";
    const clauses = [EPOCH_GUARD[timeField]];
    if (!options.includeRead) clauses.push("isRead eq false");
    const query = `${LIST_SELECT}&$filter=${encodeURIComponent(clauses.join(" and "))}` +
      `&$orderby=${encodeURIComponent(`${timeField} desc`)}&$top=${options.limit}&$skip=${options.offset}`;
    const page = await this.request<GraphPage>("GET", `${path}/messages?${query}`, null, null);
    return page.value.map((m) => this.toSummary(m));
  }

  // Graph forbids $search with $filter, so with a free-text query the other
  // criteria are applied client-side over the $search page.
  async search(options: SearchOptions): Promise<MessageSummary[]> {
    const { path, isDrafts } = await this.folderPath(options.folder);
    let messages: GraphMessage[];
    if (options.query !== null) {
      const query = `${LIST_SELECT}&$search=${encodeURIComponent(`"${options.query}"`)}&$top=${options.limit * 4}`;
      messages = (await this.request<GraphPage>("GET", `${path}/messages?${query}`, null, null)).value;
      messages = messages.filter((m) => {
        const received = this.timestampOf(m);
        if (options.from !== null && m.from?.emailAddress.address.toLowerCase() !== options.from.toLowerCase()) return false;
        if (options.subject !== null && !(m.subject ?? "").toLowerCase().includes(options.subject.toLowerCase())) return false;
        if (options.since !== null && received < options.since) return false;
        if (options.before !== null && received >= options.before) return false;
        if (options.unreadOnly && (m.isRead ?? true)) return false;
        return true;
      });
    } else {
      const timeField = isDrafts ? "createdDateTime" : "receivedDateTime";
      const clauses = [EPOCH_GUARD[timeField]];
      if (options.since !== null) clauses.push(`${timeField} ge ${isoSecond(options.since)}`);
      if (options.before !== null) clauses.push(`${timeField} lt ${isoSecond(options.before)}`);
      if (options.unreadOnly) clauses.push("isRead eq false");
      const query = `${LIST_SELECT}&$filter=${encodeURIComponent(clauses.join(" and "))}` +
        `&$orderby=${encodeURIComponent(`${timeField} desc`)}&$top=${options.limit * 4}`;
      messages = (await this.request<GraphPage>("GET", `${path}/messages?${query}`, null, null)).value;
      messages = messages.filter((m) => {
        if (options.from !== null && m.from?.emailAddress.address.toLowerCase() !== options.from.toLowerCase()) return false;
        if (options.subject !== null && !(m.subject ?? "").toLowerCase().includes(options.subject.toLowerCase())) return false;
        return true;
      });
    }
    return messages.slice(0, options.limit).map((m) => this.toSummary(m));
  }

  private rawHeadersOf(message: GraphMessage): string {
    return (message.internetMessageHeaders ?? []).map((h) => `${h.name}: ${h.value}`).join("\r\n");
  }

  protected async fetchFull(id: string): Promise<{ nativeId: string; message: GraphMessage }> {
    const nativeId = await this.resolveId(id);
    const message = await this.request<GraphMessage>(
      "GET", `/me/messages/${encodeURIComponent(nativeId)}?${FULL_SELECT}`, null, id,
    );
    return { nativeId, message };
  }

  async getMessage(id: string): Promise<MessageFull> {
    const { nativeId, message } = await this.fetchFull(id);
    const summary = this.toSummary(message);
    const rawBody = message.body?.content ?? "";
    const text = message.body?.contentType === "html" ? htmlToPlainText(rawBody) : rawBody;
    const { text: bodyText, truncated } = truncateBody(text.trim(), BODY_MAX_CHARS);
    const rawHeaders = this.rawHeadersOf(message);
    return {
      ...summary,
      replyTo: toAddress(message.replyTo?.[0]),
      returnPath: (message.internetMessageHeaders ?? [])
        .find((h) => h.name.toLowerCase() === "return-path")?.value ?? null,
      to: (message.toRecipients ?? []).map((r) => toAddress(r)!),
      cc: (message.ccRecipients ?? []).map((r) => toAddress(r)!),
      auth: parseAuthResults(rawHeaders),
      bodyText,
      bodyTruncated: truncated,
      attachments: await this.attachmentMeta(nativeId, id),
      rawHeaders,
    };
  }

  private async attachmentMeta(nativeId: string, id: string): Promise<AttachmentMeta[]> {
    const attachments = await this.request<{ value: { name: string; contentType: string; size: number }[] }>(
      "GET",
      `/me/messages/${encodeURIComponent(nativeId)}/attachments?$select=id,name,contentType,size`,
      null, id,
    );
    return attachments.value.map((a, index) => ({
      index, filename: a.name, mimeType: a.contentType, size: a.size,
    }));
  }

  async getAttachment(id: string, index: number, maxBytes: number): Promise<AttachmentContent> {
    const nativeId = await this.resolveId(id);
    const listed = await this.request<{
      value: { "@odata.type"?: string; id: string; name: string; contentType: string; size: number }[];
    }>(
      "GET",
      `/me/messages/${encodeURIComponent(nativeId)}/attachments?$select=id,name,contentType,size`,
      null, id,
    );
    const meta = listed.value[index];
    if (meta === undefined) throw new NotFoundError(`${id} attachment ${index}`);
    if (meta.size > maxBytes) {
      throw new ToolError(
        `Attachment '${meta.name}' is ${meta.size} bytes, over the ${maxBytes} byte limit; it cannot be fetched through this tool.`,
      );
    }
    if (meta["@odata.type"] !== undefined && meta["@odata.type"] !== "#microsoft.graph.fileAttachment") {
      throw new ToolError(
        `Attachment '${meta.name}' is a ${meta["@odata.type"]} (a mail item or reference, not a file); it cannot be fetched through this tool.`,
      );
    }
    const single = await this.request<{ contentBytes?: string }>(
      "GET",
      `/me/messages/${encodeURIComponent(nativeId)}/attachments/${encodeURIComponent(meta.id)}`,
      null, id,
    );
    if (single.contentBytes === undefined) throw new NotFoundError(`${id} attachment ${index}`);
    const content = Buffer.from(single.contentBytes, "base64");
    return { filename: meta.name, mimeType: meta.contentType, size: content.length, content };
  }

  async createDraft(_input: DraftInput): Promise<string> { throw new Error("not implemented"); }
  async updateDraft(_id: string, _input: DraftInput): Promise<string> { throw new Error("not implemented"); }
  async sendDraft(_id: string): Promise<SendResult> { throw new Error("not implemented"); }
  async move(_ids: string[], _target: string): Promise<BulkResult> { throw new Error("not implemented"); }
  async markRead(_ids: string[]): Promise<BulkResult> { throw new Error("not implemented"); }
  async markUnread(_ids: string[]): Promise<BulkResult> { throw new Error("not implemented"); }
  async deleteToTrash(_ids: string[]): Promise<BulkResult> { throw new Error("not implemented"); }

  async close(): Promise<void> {
    this.idCache.clear();
  }
}
