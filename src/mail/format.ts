import type { MailboxAccess } from "../auth.js";
import type { Folder, MessageFull, MessageSummary, BulkResult, Address } from "../types.js";
import { formatAuthSummary } from "./authresults.js";
import type { BodyWindow } from "./clean.js";

export function formatDate(date: Date | null): string {
  if (date === null) return "unknown-date";
  return date.toISOString().slice(0, 16).replace("T", " ");
}

function formatAddress(addr: Address | null): string {
  if (addr === null) return "unknown";
  return addr.name !== "" ? `${addr.name} <${addr.address}>` : addr.address;
}

function surfacedLine(summary: MessageSummary): string {
  const atts = `atts: ${summary.hasAttachments ? "yes" : "0"}`;
  const headers = Object.entries(summary.surfacedHeaders).map(([k, v]) => `${k}: ${v}`);
  return [atts, ...headers].join(" · ");
}

export function formatListing(
  mailbox: string,
  folder: string,
  entries: MessageSummary[],
  totalNote: string,
): string {
  if (entries.length === 0) {
    return `No messages in ${mailbox} ${folder} (${totalNote}).`;
  }
  const blocks = entries.map((m) => {
    const flag = m.unread ? "unread" : "read";
    return [
      `[${mailbox} ${m.id}] ${flag} · ${formatDate(m.date)}`,
      `  ${formatAddress(m.from)} · Subj: ${m.subject}`,
      `  ${surfacedLine(m)}`,
      `  "${m.snippet}"`,
    ].join("\n");
  });
  return [`${mailbox} ${folder}: ${totalNote}`, "", ...blocks].join("\n");
}

export interface MessageView {
  includeRawHeaders: boolean;
  raw: boolean;
  body: BodyWindow;
}

export function formatMessage(mailbox: string, message: MessageFull, view: MessageView): string {
  const lines = [
    `[${mailbox} ${message.id}] ${message.unread ? "unread" : "read"}`,
    `From: ${formatAddress(message.from)}`,
  ];
  if (message.replyTo !== null) lines.push(`Reply-To: ${formatAddress(message.replyTo)}`);
  if (message.returnPath !== null) lines.push(`Return-Path: ${message.returnPath}`);
  lines.push(`To: ${message.to.map(formatAddress).join(", ")}`);
  if (message.cc.length > 0) lines.push(`Cc: ${message.cc.map(formatAddress).join(", ")}`);
  lines.push(`Date: ${formatDate(message.date)}`, `Subject: ${message.subject}`);
  lines.push(`Auth: ${formatAuthSummary(message.auth)}`);
  for (const [k, v] of Object.entries(message.surfacedHeaders)) lines.push(`${k}: ${v}`);
  if (message.attachments.length > 0) {
    const atts = message.attachments
      .map((a) => `  [${a.index}] ${a.filename} (${a.mimeType}, ${a.size} bytes)`)
      .join("\n");
    lines.push(`Attachments:\n${atts}`);
  }
  lines.push("", view.body.text);
  if (view.body.end < view.body.total) {
    const rawHint = view.raw ? " and raw=true" : "";
    lines.push(
      "",
      `[body continues: showing chars ${view.body.start}-${view.body.end} of ${view.body.total}; call get_message again with body_offset=${view.body.end}${rawHint}]`,
    );
  }
  if (view.includeRawHeaders) lines.push("", "--- raw headers ---", message.rawHeaders);
  return lines.join("\n");
}

export function formatBulk(verb: string, result: BulkResult): string {
  const parts = [`${verb}: ${result.done.length} done, ${result.failed.length} failed.`];
  for (const entry of result.done) {
    if (entry.newId === null) {
      parts.push(`${entry.id}: moved, new id unknown (re-list to get it).`);
    } else if (entry.newId !== entry.id) {
      parts.push(`${entry.id} -> ${entry.newId}.`);
    }
  }
  for (const failure of result.failed) {
    parts.push(`${failure.id}: ${failure.reason}.`);
  }
  return parts.join(" ");
}

export function formatFolders(folders: Folder[]): string {
  return folders
    .map((f) => (f.specialUse !== null ? `${f.name} (special: ${f.specialUse})` : f.name))
    .join("\n");
}

export function formatAccounts(rows: MailboxAccess[]): string {
  return rows
    .map((r) => {
      const perms = r.permissions.length > 0 ? r.permissions.join(", ") : "none";
      const marker = r.isDefault ? " [default]" : "";
      return `${r.mailbox}${marker} · ${r.address} · permissions: ${perms}`;
    })
    .join("\n");
}
