import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";

export interface FakeMessageInput {
  folder: string; subject: string; fromName: string; fromAddress: string;
  body: string; isRead: boolean; receivedAt: Date; headers: Record<string, string>;
}

export interface FakeMessage {
  id: string; folder: string; subject: string; fromName: string; fromAddress: string;
  toRecipients: { name: string; address: string }[];
  ccRecipients: { name: string; address: string }[];
  bccRecipients: { name: string; address: string }[];
  body: string; bodyType: "text" | "html"; isRead: boolean; isDraft: boolean;
  receivedAtMs: number | null; createdAtMs: number;
  headers: Record<string, string>;
  attachments: { id: string; name: string; contentType: string; contentBytes: string }[];
}

const FOLDERS = ["inbox", "junkemail", "deleteditems", "archive", "drafts", "sentitems"] as const;
const folderId = (wellKnown: string): string => `fid-${wellKnown}`;

function renderSecond(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 19)}Z`;
}

const recipientsJson = (list: { name: string; address: string }[]): object[] =>
  list.map((r) => ({ emailAddress: { name: r.name, address: r.address } }));

function fullJson(m: FakeMessage): Record<string, unknown> {
  return {
    id: m.id,
    subject: m.subject,
    from: { emailAddress: { name: m.fromName, address: m.fromAddress } },
    replyTo: [],
    toRecipients: recipientsJson(m.toRecipients),
    ccRecipients: recipientsJson(m.ccRecipients),
    bccRecipients: recipientsJson(m.bccRecipients),
    isRead: m.isRead,
    isDraft: m.isDraft,
    hasAttachments: m.attachments.length > 0,
    receivedDateTime: m.receivedAtMs !== null ? renderSecond(m.receivedAtMs) : undefined,
    createdDateTime: renderSecond(m.createdAtMs),
    bodyPreview: m.body.slice(0, 255),
    body: { contentType: m.bodyType, content: m.body },
    internetMessageHeaders: Object.entries(m.headers).map(([name, value]) => ({ name, value })),
    parentFolderId: folderId(m.folder),
  };
}

// Real Graph returns only $select-ed properties (id always included).
function projected(m: FakeMessage, select: string | null): object {
  const full = fullJson(m);
  if (select === null) {
    const { internetMessageHeaders: _h, body: _b, ...defaults } = full;
    return defaults;
  }
  const wanted = new Set(select.split(",").map((s) => s.trim()));
  wanted.add("id");
  return Object.fromEntries(Object.entries(full).filter(([k]) => wanted.has(k)));
}

export class FakeGraph {
  private server: Server | null = null;
  private base = "";
  private readonly messages: FakeMessage[] = [];

  seed(input: FakeMessageInput): string {
    const id = `AAMk${randomUUID()}=`;
    this.messages.push({
      id, folder: input.folder, subject: input.subject,
      fromName: input.fromName, fromAddress: input.fromAddress,
      toRecipients: [{ name: "Agent", address: "school@school.test" }],
      ccRecipients: [], bccRecipients: [],
      body: input.body, bodyType: "text", isRead: input.isRead, isDraft: input.folder === "drafts",
      receivedAtMs: input.folder === "drafts" ? null : input.receivedAt.getTime(),
      createdAtMs: input.receivedAt.getTime(),
      headers: input.headers, attachments: [],
    });
    return id;
  }

  messagesIn(folder: string): FakeMessage[] {
    return this.messages.filter((m) => m.folder === folder);
  }

  private byId(id: string): FakeMessage | undefined {
    return this.messages.find((m) => m.id === id);
  }

  // Clauses the backend may emit, ANDed. Unknown clauses -> throw (400).
  private applyFilter(candidates: FakeMessage[], filter: string): FakeMessage[] {
    let result = candidates;
    for (const clause of filter.split(" and ")) {
      const range = clause.match(/^(receivedDateTime|createdDateTime) (ge|lt) (.+)$/);
      const isRead = clause.match(/^isRead eq (true|false)$/);
      if (range !== null) {
        const bound = Date.parse(range[3]!);
        result = result.filter((m) => {
          const value = range[1] === "receivedDateTime" ? m.receivedAtMs : m.createdAtMs;
          if (value === null) return false;
          return range[2] === "ge" ? value >= bound : value < bound;
        });
      } else if (isRead !== null) {
        result = result.filter((m) => m.isRead === (isRead[1] === "true"));
      } else {
        throw new Error(`fakeGraph: unsupported filter clause '${clause}'`);
      }
    }
    return result;
  }

  // Outlook restriction: with both $filter and $orderby, the filter must
  // lead with the $orderby property. Enforced so backend violations fail CI.
  private checkFilterOrder(filter: string | null, orderby: string | null): string | null {
    if (filter === null || orderby === null) return null;
    const property = orderby.split(" ")[0]!;
    if (!filter.split(" and ")[0]!.startsWith(property)) {
      return `InefficientFilter: $orderby property '${property}' must lead the $filter`;
    }
    return null;
  }

  private handle(method: string, pathname: string, query: URLSearchParams, body: string): {
    status: number; json: object;
  } {
    if (method === "GET" && pathname === "/me/mailFolders") {
      return {
        status: 200,
        json: { value: FOLDERS.map((f) => ({ id: folderId(f), displayName: f, wellKnownName: f })) },
      };
    }
    const listMatch = pathname.match(/^\/me(?:\/mailFolders\/([^/]+))?\/messages$/);
    if (method === "GET" && listMatch !== null) {
      const scope = listMatch[1];
      let candidates: FakeMessage[];
      if (scope === undefined) {
        candidates = [...this.messages];
      } else {
        const wellKnown = FOLDERS.find((f) => f === scope || folderId(f) === scope);
        if (wellKnown === undefined) return { status: 404, json: { error: { code: "ErrorFolderNotFound" } } };
        candidates = this.messagesIn(wellKnown);
      }
      const filter = query.get("$filter");
      const search = query.get("$search");
      const orderby = query.get("$orderby");
      if (search !== null && filter !== null) {
        return { status: 400, json: { error: { code: "SearchWithFilter", message: "cannot combine $search and $filter" } } };
      }
      const orderError = this.checkFilterOrder(filter, orderby);
      if (orderError !== null) {
        return { status: 400, json: { error: { code: "InefficientFilter", message: orderError } } };
      }
      try {
        if (filter !== null) candidates = this.applyFilter(candidates, filter);
      } catch (error) {
        return { status: 400, json: { error: { code: "BadFilter", message: String(error) } } };
      }
      if (search !== null) {
        const needle = search.replace(/^"|"$/g, "").toLowerCase();
        candidates = candidates.filter(
          (m) => m.subject.toLowerCase().includes(needle) || m.body.toLowerCase().includes(needle),
        );
      }
      if (orderby !== null) {
        const property = orderby.split(" ")[0]!;
        const valueOf = (m: FakeMessage): number =>
          property === "createdDateTime" ? m.createdAtMs : m.receivedAtMs ?? 0;
        candidates = [...candidates].sort((a, b) => valueOf(b) - valueOf(a));
      }
      const skip = Number(query.get("$skip") ?? "0");
      const top = Number(query.get("$top") ?? "10");
      const select = query.get("$select");
      const page = candidates.slice(skip, skip + top).map((m) => projected(m, select));
      // Real Graph emits @odata.nextLink whenever more results remain; clients
      // must follow it to see all candidates.
      if (skip + top < candidates.length) {
        const next = new URLSearchParams(query);
        next.set("$skip", String(skip + top));
        return {
          status: 200,
          json: { value: page, "@odata.nextLink": `${this.base}${pathname}?${next.toString()}` },
        };
      }
      return { status: 200, json: { value: page } };
    }
    const singleMatch = pathname.match(/^\/me\/messages\/([^/]+)(\/.*)?$/);
    if (singleMatch !== null) {
      const message = this.byId(decodeURIComponent(singleMatch[1]!));
      if (message === undefined) return { status: 404, json: { error: { code: "ErrorItemNotFound" } } };
      const sub = singleMatch[2] ?? "";
      if (method === "GET" && sub === "") {
        return { status: 200, json: projected(message, query.get("$select")) };
      }
      if (method === "GET" && sub === "/attachments") {
        return {
          status: 200,
          json: {
            value: message.attachments.map((a) => ({
              "@odata.type": "#microsoft.graph.fileAttachment",
              id: a.id, name: a.name, contentType: a.contentType,
              size: Buffer.from(a.contentBytes, "base64").length, contentBytes: a.contentBytes,
            })),
          },
        };
      }
      return this.handleWrite(method, message, sub, body);
    }
    if (method === "POST" && pathname === "/me/messages") {
      const parsed = JSON.parse(body) as {
        subject?: string; body?: { contentType: "text" | "html"; content: string };
        toRecipients?: { emailAddress: { name?: string; address: string } }[];
        ccRecipients?: { emailAddress: { name?: string; address: string } }[];
        bccRecipients?: { emailAddress: { name?: string; address: string } }[];
      };
      const fromWire = (
        list: { emailAddress: { name?: string; address: string } }[] | undefined,
      ): { name: string; address: string }[] =>
        (list ?? []).map((r) => ({ name: r.emailAddress.name ?? "", address: r.emailAddress.address }));
      const id = `AAMk${randomUUID()}=`;
      this.messages.push({
        id, folder: "drafts", subject: parsed.subject ?? "",
        fromName: "Agent", fromAddress: "school@school.test",
        toRecipients: fromWire(parsed.toRecipients),
        ccRecipients: fromWire(parsed.ccRecipients),
        bccRecipients: fromWire(parsed.bccRecipients),
        body: parsed.body?.content ?? "", bodyType: parsed.body?.contentType ?? "text",
        isRead: true, isDraft: true,
        receivedAtMs: null, createdAtMs: 1_754_500_000_123, headers: {}, attachments: [],
      });
      return { status: 201, json: fullJson(this.byId(id)!) };
    }
    return { status: 404, json: { error: { code: "fakeGraph: unhandled route", method, pathname } } };
  }

  // Write routes are completed in Task 14; until then unmatched writes 404.
  private handleWrite(_method: string, _message: FakeMessage, sub: string, _body: string): {
    status: number; json: object;
  } {
    return { status: 404, json: { error: { code: "fakeGraph: write route not yet implemented", sub } } };
  }

  async start(): Promise<string> {
    this.server = createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://localhost");
      let body = "";
      req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
      req.on("end", () => {
        const { status, json } = this.handle(req.method ?? "GET", url.pathname, url.searchParams, body);
        res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(json));
      });
    });
    await new Promise<void>((resolve) => this.server!.listen(0, () => resolve()));
    const address = this.server.address();
    this.base = `http://localhost:${typeof address === "object" && address !== null ? address.port : 0}`;
    return this.base;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}
