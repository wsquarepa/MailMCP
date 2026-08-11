import type { MailboxConfig } from "../config.js";
import { AmbiguousIdError, InvalidInputError, NotFoundError, ToolError } from "../errors.js";
import { parseAuthResults } from "../mail/authresults.js";
import {
  SNIPPET_MAX_CHARS, htmlToMarkdown, makeSnippet, stripQuotedAndSignature,
} from "../mail/clean.js";
import type {
  Address, AttachmentContent, AttachmentMeta, BulkResult, DraftInput, Folder,
  ListOptions, MailBackend, MessageFull, MessageSummary, SearchOptions, SendResult,
} from "../types.js";
import { GraphHttpError, graphRequest, graphRequestOnce, type GraphConnection } from "./client.js";
import { decodeShortId, encodeShortId, matchesShortId } from "./shortid.js";

export type GraphMailboxConfig = Extract<MailboxConfig, { backend: "graph" }>;

// Graph returns "address": null for some system-generated senders.
interface GraphRecipient { emailAddress: { name?: string; address?: string | null } }
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
  const { name, address } = recipient.emailAddress;
  if (address === undefined || address === null) return null;
  return { name: name ?? "", address };
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

  // Same as request(), but for the non-idempotent POSTs (send, move,
  // createReply, create draft, attachment upload) that must never be blindly
  // replayed on a dropped connection or 5xx.
  private async requestOnce<T>(
    path: string,
    body: object | null,
    notFoundId: string | null,
  ): Promise<T> {
    try {
      return await graphRequestOnce<T>(this.connection, "POST", path, body);
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
      // wellKnownName is an explicit JSON null on user-created folders.
      const page: { value: { id: string; displayName: string; wellKnownName?: string | null }[]; "@odata.nextLink"?: string } =
        await this.request("GET", path, null, null);
      for (const folder of page.value) {
        map.set(folder.displayName.toLowerCase(), folder.id);
        if (folder.wellKnownName !== undefined && folder.wellKnownName !== null) {
          map.set(folder.wellKnownName.toLowerCase(), folder.id);
        }
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
    const folders = await this.request<{ value: { displayName: string; wellKnownName?: string | null }[] }>(
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
        if (options.from !== null && toAddress(m.from)?.address.toLowerCase() !== options.from.toLowerCase()) return false;
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
        if (options.from !== null && toAddress(m.from)?.address.toLowerCase() !== options.from.toLowerCase()) return false;
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
    const isHtml = message.body?.contentType === "html";
    const bodyMarkdown = isHtml ? htmlToMarkdown(rawBody).trim() : rawBody.trim();
    const rawHeaders = this.rawHeadersOf(message);
    return {
      ...summary,
      replyTo: toAddress(message.replyTo?.[0]),
      returnPath: (message.internetMessageHeaders ?? [])
        .find((h) => h.name.toLowerCase() === "return-path")?.value ?? null,
      to: (message.toRecipients ?? []).map((r) => toAddress(r)).filter((a): a is Address => a !== null),
      cc: (message.ccRecipients ?? []).map((r) => toAddress(r)).filter((a): a is Address => a !== null),
      auth: parseAuthResults(rawHeaders),
      bodyMarkdown,
      bodyRaw: rawBody,
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

  private recipientsJson(addresses: Address[]): { emailAddress: { name: string; address: string } }[] {
    return addresses.map((a) => ({ emailAddress: { name: a.name, address: a.address } }));
  }

  private draftPatchBody(input: DraftInput): Record<string, unknown> {
    const patch: Record<string, unknown> = {};
    if (input.subject !== null) patch["subject"] = input.subject;
    if (input.body !== null) patch["body"] = { contentType: "text", content: input.body };
    if (input.to !== null) patch["toRecipients"] = this.recipientsJson(input.to);
    if (input.cc !== null) patch["ccRecipients"] = this.recipientsJson(input.cc);
    if (input.bcc !== null) patch["bccRecipients"] = this.recipientsJson(input.bcc);
    return patch;
  }

  private async assertIsDraft(id: string): Promise<string> {
    const nativeId = await this.resolveId(id);
    const probe = await this.request<GraphMessage>(
      "GET", `/me/messages/${encodeURIComponent(nativeId)}?$select=id,isDraft`, null, id,
    );
    if (!(probe.isDraft ?? false)) {
      throw new InvalidInputError(`message ${id} is not a draft; only drafts can be updated or sent`);
    }
    return nativeId;
  }

  private async addAttachments(nativeId: string, id: string, input: DraftInput): Promise<void> {
    for (const attachment of input.attachments ?? []) {
      await this.requestOnce(`/me/messages/${encodeURIComponent(nativeId)}/attachments`, {
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: attachment.filename,
        contentType: attachment.mimeType,
        contentBytes: attachment.content.toString("base64"),
      }, id);
    }
  }

  async createDraft(input: DraftInput): Promise<string> {
    let draft: GraphMessage;
    if (input.replyToMessageId !== null) {
      const originalNative = await this.resolveId(input.replyToMessageId);
      draft = await this.requestOnce<GraphMessage>(
        `/me/messages/${encodeURIComponent(originalNative)}/createReply`, {}, input.replyToMessageId,
      );
      const patch = this.draftPatchBody(input);
      if (Object.keys(patch).length > 0) {
        draft = await this.request<GraphMessage>(
          "PATCH", `/me/messages/${encodeURIComponent(draft.id)}`, patch, null,
        );
      }
    } else {
      draft = await this.requestOnce<GraphMessage>("/me/messages", this.draftPatchBody(input), null);
    }
    await this.addAttachments(draft.id, draft.id, input);
    return this.shortIdFor(draft);
  }

  async updateDraft(id: string, input: DraftInput): Promise<string> {
    const nativeId = await this.assertIsDraft(id);
    if (input.attachments !== null) {
      const existing = await this.request<{ value: { id: string }[] }>(
        "GET", `/me/messages/${encodeURIComponent(nativeId)}/attachments?$select=id`, null, id,
      );
      for (const attachment of existing.value) {
        await this.request(
          "DELETE",
          `/me/messages/${encodeURIComponent(nativeId)}/attachments/${encodeURIComponent(attachment.id)}`,
          null, id,
        );
      }
      await this.addAttachments(nativeId, id, input);
    }
    const patch = this.draftPatchBody(input);
    const updated = Object.keys(patch).length > 0
      ? await this.request<GraphMessage>("PATCH", `/me/messages/${encodeURIComponent(nativeId)}`, patch, id)
      : await this.request<GraphMessage>(
          "GET", `/me/messages/${encodeURIComponent(nativeId)}?${LIST_SELECT}`, null, id,
        );
    return this.shortIdFor(updated);
  }

  async sendDraft(id: string): Promise<SendResult> {
    const nativeId = await this.assertIsDraft(id);
    const draft = await this.request<GraphMessage>(
      "GET",
      `/me/messages/${encodeURIComponent(nativeId)}?$select=id,toRecipients,ccRecipients,bccRecipients,receivedDateTime,createdDateTime`,
      null, id,
    );
    const recipients = [
      ...(draft.toRecipients ?? []), ...(draft.ccRecipients ?? []), ...(draft.bccRecipients ?? []),
    ].map((r) => toAddress(r)).filter((a): a is Address => a !== null && a.address !== "");
    if (recipients.length === 0) {
      throw new InvalidInputError(`draft ${id} has no recipients; update_draft it with a 'to' first`);
    }
    await this.requestOnce(`/me/messages/${encodeURIComponent(nativeId)}/send`, {}, id);
    // Graph moves the draft to Sent itself; nothing to reconcile.
    return { recipients, warning: null };
  }

  private async moveDestination(target: string): Promise<string> {
    const requested = target.toLowerCase();
    const wellKnown = WELL_KNOWN[requested] ?? requested;
    if (wellKnown === "deleteditems") {
      throw new InvalidInputError("moving to Trash is not allowed; use delete_message instead");
    }
    if (Object.values(WELL_KNOWN).includes(wellKnown)) return wellKnown;
    const id = (await this.folderIds()).get(requested);
    if (id === undefined) {
      const known = [...(await this.folderIds()).keys()].join(", ");
      throw new InvalidInputError(`unknown folder '${target}'. Folders: ${known}`);
    }
    return id;
  }

  private async perId(
    ids: string[],
    operation: (nativeId: string, shortId: string) => Promise<{ id: string; newId: string | null }>,
  ): Promise<BulkResult> {
    const result: BulkResult = { done: [], failed: [] };
    for (const id of ids) {
      try {
        result.done.push(await operation(await this.resolveId(id), id));
      } catch (error) {
        result.failed.push({ id, reason: error instanceof Error ? error.message : String(error) });
      }
    }
    return result;
  }

  async move(ids: string[], target: string): Promise<BulkResult> {
    let destination: string;
    try {
      destination = await this.moveDestination(target);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return { done: [], failed: ids.map((id) => ({ id, reason })) };
    }
    return this.perId(ids, async (nativeId, shortId) => {
      const moved = await this.requestOnce<GraphMessage>(
        `/me/messages/${encodeURIComponent(nativeId)}/move`, { destinationId: destination }, shortId,
      );
      return { id: shortId, newId: this.shortIdFor(moved) };
    });
  }

  private async patchIsRead(ids: string[], isRead: boolean): Promise<BulkResult> {
    return this.perId(ids, async (nativeId, shortId) => {
      await this.request("PATCH", `/me/messages/${encodeURIComponent(nativeId)}`, { isRead }, shortId);
      return { id: shortId, newId: shortId };
    });
  }

  async markRead(ids: string[]): Promise<BulkResult> {
    return this.patchIsRead(ids, true);
  }

  async markUnread(ids: string[]): Promise<BulkResult> {
    return this.patchIsRead(ids, false);
  }

  async deleteToTrash(ids: string[]): Promise<BulkResult> {
    return this.perId(ids, async (nativeId, shortId) => {
      const moved = await this.requestOnce<GraphMessage>(
        `/me/messages/${encodeURIComponent(nativeId)}/move`, { destinationId: "deleteditems" }, shortId,
      );
      return { id: shortId, newId: this.shortIdFor(moved) };
    });
  }

  async close(): Promise<void> {
    this.idCache.clear();
  }
}
