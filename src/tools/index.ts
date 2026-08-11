import addressparser from "nodemailer/lib/addressparser/index.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { accessibleMailboxes, requirePermission } from "../auth.js";
import type { Permission } from "../config.js";
import { InvalidInputError, ToolError } from "../errors.js";
import { logger } from "../logger.js";
import { ATTACHMENT_MAX_BYTES, BODY_MAX_CHARS, windowBody } from "../mail/clean.js";
import {
  formatAccounts, formatBulk, formatFolders, formatListing, formatMessage,
} from "../mail/format.js";
import type { Address, DraftAttachment, DraftInput, MailBackend } from "../types.js";
import { UPLOAD_MAX_BYTES } from "../uploads.js";
import { resolveMailbox, type ToolContext } from "./registry.js";

const TEXT_MIME_PREFIXES = ["text/", "application/json", "application/xml"];

// Matches the zone designators zod's datetime({ offset: true }) admits.
const ZONE_SUFFIX = /(?:Z|[+-]\d{2}:?\d{2})$/;
const DATETIME_ARG = z.string().datetime({ offset: true, local: true });

// A zone-less timestamp is pinned to UTC so parsing never depends on the
// server's timezone.
function parseDatetimeArg(value: string): Date {
  return new Date(ZONE_SUFFIX.test(value) ? value : `${value}Z`);
}

function text(value: string): CallToolResult {
  return { content: [{ type: "text", text: value }] };
}

// Every invocation, success or failure, logs one completion line with the
// key name; bodies, tokens, and passwords never appear in log fields.
async function runTool(
  toolName: string,
  keyName: string,
  mailbox: string | null,
  fn: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const startedAt = performance.now();
  let isError = false;
  try {
    return await fn();
  } catch (error) {
    isError = true;
    if (error instanceof ToolError) {
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
    logger.error({ key: keyName, tool: toolName, error: String(error) }, "unexpected tool failure");
    return {
      isError: true,
      content: [{ type: "text", text: "Internal server error; the operator should check server logs." }],
    };
  } finally {
    logger.info(
      { key: keyName, tool: toolName, mailbox, ms: Math.round(performance.now() - startedAt), isError },
      "tool call completed",
    );
  }
}

function parseRecipients(field: string, raw: string[] | undefined): Address[] | null {
  if (raw === undefined) return null;
  return raw.map((entry) => {
    const parsed = addressparser(entry, { flatten: true });
    const first = parsed[0];
    if (parsed.length !== 1 || first === undefined || !(first.address ?? "").includes("@")) {
      throw new InvalidInputError(`${field} entry '${entry}' is not a valid email address`);
    }
    return { name: first.name, address: first.address ?? "" };
  });
}

const draftFields = {
  to: z.array(z.string()).optional(),
  cc: z.array(z.string()).optional(),
  bcc: z.array(z.string()).optional(),
  subject: z.string().optional(),
  body: z.string().optional(),
  attachments: z.array(z.object({
    filename: z.string().optional(),
    mime_type: z.string().optional(),
    upload_id: z.string().optional(),
    source_message_id: z.string().optional(),
    source_index: z.number().int().min(0).optional(),
  })).optional(),
};

interface AttachmentArg {
  filename?: string | undefined;
  mime_type?: string | undefined;
  upload_id?: string | undefined;
  source_message_id?: string | undefined;
  source_index?: number | undefined;
}

interface DraftArgs {
  reply_to_message_id?: string | undefined; to?: string[] | undefined; cc?: string[] | undefined; bcc?: string[] | undefined;
  subject?: string | undefined; body?: string | undefined;
  attachments?: AttachmentArg[] | undefined;
}

const ATTACHMENT_SHAPES =
  "each attachments entry is either { filename, mime_type, upload_id } for bytes staged via POST /upload, " +
  "or { source_message_id, source_index, filename? } to copy an attachment from an existing message";

const MAX_DRAFT_ATTACHMENTS = 10;

async function resolveAttachments(
  raw: AttachmentArg[] | undefined,
  context: ToolContext,
  mailbox: string,
  backend: MailBackend,
): Promise<DraftAttachment[] | null> {
  if (raw === undefined) return null;
  if (raw.length > MAX_DRAFT_ATTACHMENTS) {
    throw new InvalidInputError(
      `${raw.length} attachment entries provided; a draft takes at most ${MAX_DRAFT_ATTACHMENTS} per call. Send fewer or split across messages.`,
    );
  }
  const resolved: DraftAttachment[] = [];
  for (const entry of raw) {
    if (entry.upload_id !== undefined && entry.source_message_id === undefined) {
      if (entry.filename === undefined || entry.mime_type === undefined || entry.source_index !== undefined) {
        throw new InvalidInputError(ATTACHMENT_SHAPES);
      }
      const bytes = context.uploads.get(context.key.name, entry.upload_id, Date.now());
      if (bytes === null) {
        throw new InvalidInputError(
          `attachment '${entry.filename}': upload_id '${entry.upload_id}' is unknown or expired; ` +
          "POST the bytes to /upload again and use the returned upload_id",
        );
      }
      resolved.push({ filename: entry.filename, mimeType: entry.mime_type, content: bytes });
    } else if (entry.source_message_id !== undefined && entry.upload_id === undefined) {
      if (entry.source_index === undefined || entry.mime_type !== undefined) {
        throw new InvalidInputError(ATTACHMENT_SHAPES);
      }
      requirePermission(context.config, context.key, mailbox, "read");
      const source = await backend.getAttachment(entry.source_message_id, entry.source_index, ATTACHMENT_MAX_BYTES);
      if (source.content.length > UPLOAD_MAX_BYTES) {
        throw new InvalidInputError(
          `attachment ${entry.source_index} of message ${entry.source_message_id} is ${source.content.length} bytes; ` +
          `outgoing attachments are capped at ${UPLOAD_MAX_BYTES} bytes, so it cannot be attached to a draft`,
        );
      }
      resolved.push({
        filename: entry.filename ?? source.filename,
        mimeType: source.mimeType,
        content: source.content,
      });
    } else {
      throw new InvalidInputError(ATTACHMENT_SHAPES);
    }
  }
  return resolved;
}

function toDraftInput(args: DraftArgs, attachments: DraftAttachment[] | null): DraftInput {
  return {
    replyToMessageId: args.reply_to_message_id ?? null,
    to: parseRecipients("to", args.to),
    cc: parseRecipients("cc", args.cc),
    bcc: parseRecipients("bcc", args.bcc),
    subject: args.subject ?? null,
    body: args.body ?? null,
    attachments,
  };
}

// Exactly one creation mode: reply (id + body) or fresh (to + subject + body).
function assertCreateMode(args: DraftArgs): void {
  if (args.reply_to_message_id !== undefined) {
    const forbidden = ["to", "cc", "bcc", "subject"].filter((f) => args[f as keyof DraftArgs] !== undefined);
    if (forbidden.length > 0) {
      throw new InvalidInputError(
        `create_draft takes either reply_to_message_id (a reply) or fresh-message fields, not both; remove ${forbidden.join(", ")}`,
      );
    }
    if (args.body === undefined) {
      throw new InvalidInputError("a reply draft needs a body");
    }
    return;
  }
  const missing = ["to", "subject", "body"].filter((f) => args[f as keyof DraftArgs] === undefined);
  if (missing.length > 0) {
    throw new InvalidInputError(
      `create_draft needs either reply_to_message_id or a fresh message with to, subject, and body; missing: ${missing.join(", ")}`,
    );
  }
}

export function registerTools(server: McpServer, context: ToolContext): void {
  const key = context.key;
  const gate = (mailboxArg: string | undefined, permission: Permission) => {
    const { name, backend } = resolveMailbox(context, mailboxArg ?? null);
    requirePermission(context.config, key, name, permission);
    return { name, backend };
  };

  server.registerTool("list_accounts", {
    description: "List the mailboxes this key can access, with permissions and the default mailbox.",
    inputSchema: {},
  }, async () => runTool("list_accounts", key.name, null, async () =>
    text(formatAccounts(accessibleMailboxes(context.config, key))),
  ));

  server.registerTool("list_folders", {
    description: "List folders in a mailbox, marking special roles (inbox, junk, trash, archive, drafts, sent).",
    inputSchema: { mailbox: z.string().optional() },
  }, async (args) => runTool("list_folders", key.name, args.mailbox ?? null, async () => {
    const { backend } = gate(args.mailbox, "read");
    return text(formatFolders(await backend.listFolders()));
  }));

  server.registerTool("list_messages", {
    description: "List messages. Defaults: inbox, unread only, newest 20. Each entry has id, sender, subject, date, flags, and a snippet.",
    inputSchema: {
      mailbox: z.string().optional(),
      folder: z.string().optional(),
      include_read: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
      offset: z.number().int().min(0).optional(),
    },
  }, async (args) => runTool("list_messages", key.name, args.mailbox ?? null, async () => {
    const { name, backend } = gate(args.mailbox, "read");
    const options = {
      folder: args.folder ?? null,
      includeRead: args.include_read ?? false,
      limit: args.limit ?? 20,
      offset: args.offset ?? 0,
    };
    const messages = await backend.listMessages(options);
    const scope = options.includeRead ? "all" : "unread";
    const note = `showing up to ${options.limit} ${scope}, offset ${options.offset}`;
    return text(formatListing(name, options.folder ?? "INBOX", messages, note));
  }));

  server.registerTool("search_messages", {
    description: "Search one folder (default inbox) by text, sender, subject, or date range. since/before take ISO 8601 datetimes; a timestamp without a zone designator is treated as UTC.",
    inputSchema: {
      mailbox: z.string().optional(),
      folder: z.string().optional(),
      query: z.string().optional(),
      from: z.string().optional(),
      subject: z.string().optional(),
      since: DATETIME_ARG.optional(),
      before: DATETIME_ARG.optional(),
      unread_only: z.boolean().optional(),
      limit: z.number().int().min(1).max(100).optional(),
    },
  }, async (args) => runTool("search_messages", key.name, args.mailbox ?? null, async () => {
    const { name, backend } = gate(args.mailbox, "read");
    const hits = await backend.search({
      folder: args.folder ?? null,
      query: args.query ?? null,
      from: args.from ?? null,
      subject: args.subject ?? null,
      since: args.since !== undefined ? parseDatetimeArg(args.since) : null,
      before: args.before !== undefined ? parseDatetimeArg(args.before) : null,
      unreadOnly: args.unread_only ?? false,
      limit: args.limit ?? 20,
    });
    return text(formatListing(name, args.folder ?? "INBOX", hits, `${hits.length} matches`));
  }));

  server.registerTool("get_message", {
    description: "Read a full message: envelope, auth summary (SPF/DKIM/DMARC), body as markdown with links preserved. Set raw for the unconverted stored body (HTML when the message has one). Bodies over 30000 chars are windowed; follow the body_offset hint in the output to page. Set raw_headers for the complete header block.",
    inputSchema: {
      mailbox: z.string().optional(),
      id: z.string(),
      raw: z.boolean().optional(),
      raw_headers: z.boolean().optional(),
      body_offset: z.number().int().min(0).optional(),
    },
  }, async (args) => runTool("get_message", key.name, args.mailbox ?? null, async () => {
    const { name, backend } = gate(args.mailbox, "read");
    const message = await backend.getMessage(args.id);
    const raw = args.raw === true;
    const body = raw ? message.bodyRaw : message.bodyMarkdown;
    const offset = args.body_offset ?? 0;
    if (offset > 0 && body.length === 0) {
      throw new InvalidInputError(
        `body_offset ${offset} was provided but the ${raw ? "raw" : "markdown"} body is empty. Call get_message without body_offset.`,
      );
    }
    if (offset > 0 && offset >= body.length) {
      throw new InvalidInputError(
        `body_offset ${offset} is past the end of the body (${body.length} characters). Use an offset below ${body.length}.`,
      );
    }
    return text(formatMessage(name, message, {
      includeRawHeaders: args.raw_headers ?? false,
      raw,
      body: windowBody(body, offset, BODY_MAX_CHARS),
    }));
  }));

  server.registerTool("get_attachment", {
    description: "Fetch one attachment by message id and index (from get_message). Text types return as text, binary as base64. 10 MB cap.",
    inputSchema: {
      mailbox: z.string().optional(),
      id: z.string(),
      index: z.number().int().min(0),
    },
  }, async (args) => runTool("get_attachment", key.name, args.mailbox ?? null, async () => {
    const { backend } = gate(args.mailbox, "read");
    const attachment = await backend.getAttachment(args.id, args.index, ATTACHMENT_MAX_BYTES);
    if (TEXT_MIME_PREFIXES.some((p) => attachment.mimeType.startsWith(p))) {
      return text(`${attachment.filename} (${attachment.mimeType}):\n${attachment.content.toString("utf8")}`);
    }
    return {
      content: [{
        type: "resource",
        resource: {
          uri: `attachment://${encodeURIComponent(attachment.filename)}`,
          mimeType: attachment.mimeType,
          blob: attachment.content.toString("base64"),
        },
      }],
    };
  }));

  server.registerTool("create_draft", {
    description: "Create a draft: either a reply (reply_to_message_id + body; threading and recipients handled server-side) or a fresh message (to + subject + body). Nothing is sent until send_draft. Attachments are references, never inline bytes: stage a file with POST /upload (raw body, same bearer token, 3 MB cap) and pass { filename, mime_type, upload_id }, or copy from an existing message with { source_message_id, source_index }.",
    inputSchema: {
      mailbox: z.string().optional(),
      reply_to_message_id: z.string().optional(),
      ...draftFields,
    },
  }, async (args) => runTool("create_draft", key.name, args.mailbox ?? null, async () => {
    const { name, backend } = gate(args.mailbox, "draft");
    assertCreateMode(args);
    const attachments = await resolveAttachments(args.attachments, context, name, backend);
    const id = await backend.createDraft(toDraftInput(args, attachments));
    return text(`Draft created with id ${id}. Review with get_message, revise with update_draft, send with send_draft.`);
  }));

  server.registerTool("update_draft", {
    description: "Update a draft's provided fields; others are preserved. Providing attachments replaces the draft's whole attachment set, using the same reference shapes as create_draft. Returns the draft's CURRENT id; always use the returned id afterwards.",
    inputSchema: {
      mailbox: z.string().optional(),
      draft_id: z.string(),
      ...draftFields,
    },
  }, async (args) => runTool("update_draft", key.name, args.mailbox ?? null, async () => {
    const { name, backend } = gate(args.mailbox, "draft");
    const attachments = await resolveAttachments(args.attachments, context, name, backend);
    const id = await backend.updateDraft(args.draft_id, toDraftInput(args, attachments));
    return text(`Draft updated; current id is ${id}. Use this id for further updates or send_draft.`);
  }));

  server.registerTool("send_draft", {
    description: "Send an existing draft. This is the only way to send mail.",
    inputSchema: {
      mailbox: z.string().optional(),
      draft_id: z.string(),
    },
  }, async (args) => runTool("send_draft", key.name, args.mailbox ?? null, async () => {
    const { backend } = gate(args.mailbox, "send");
    const sent = await backend.sendDraft(args.draft_id);
    const rendered = sent.recipients
      .map((r) => (r.name !== "" ? `${r.name} <${r.address}>` : r.address))
      .join(", ");
    const confirmation = `Sent draft ${args.draft_id} to: ${rendered}`;
    return text(sent.warning !== null ? `${confirmation}\n${sent.warning}` : confirmation);
  }));

  server.registerTool("move_message", {
    description: "Move messages to a folder, or the special targets junk/archive/inbox. Trash requires delete_message.",
    inputSchema: {
      mailbox: z.string().optional(),
      ids: z.array(z.string()).min(1),
      target: z.string(),
    },
  }, async (args) => runTool("move_message", key.name, args.mailbox ?? null, async () => {
    const { backend } = gate(args.mailbox, "organize");
    return text(formatBulk(`Moved to ${args.target}`, await backend.move(args.ids, args.target)));
  }));

  server.registerTool("mark_read", {
    description: "Mark messages as read.",
    inputSchema: { mailbox: z.string().optional(), ids: z.array(z.string()).min(1) },
  }, async (args) => runTool("mark_read", key.name, args.mailbox ?? null, async () => {
    const { backend } = gate(args.mailbox, "organize");
    return text(formatBulk("Marked read", await backend.markRead(args.ids)));
  }));

  server.registerTool("mark_unread", {
    description: "Mark messages as unread.",
    inputSchema: { mailbox: z.string().optional(), ids: z.array(z.string()).min(1) },
  }, async (args) => runTool("mark_unread", key.name, args.mailbox ?? null, async () => {
    const { backend } = gate(args.mailbox, "organize");
    return text(formatBulk("Marked unread", await backend.markUnread(args.ids)));
  }));

  server.registerTool("delete_message", {
    description: "Move messages to Trash. There is no permanent delete.",
    inputSchema: { mailbox: z.string().optional(), ids: z.array(z.string()).min(1) },
  }, async (args) => runTool("delete_message", key.name, args.mailbox ?? null, async () => {
    const { backend } = gate(args.mailbox, "delete");
    return text(formatBulk("Deleted to Trash", await backend.deleteToTrash(args.ids)));
  }));
}
