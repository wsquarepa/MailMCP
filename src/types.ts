export interface Address {
  name: string;
  address: string;
}

export type SpecialFolder = "inbox" | "junk" | "trash" | "archive" | "drafts" | "sent";

export interface Folder {
  name: string;
  specialUse: SpecialFolder | null;
}

export interface AuthResults {
  spf: string | null;
  dkim: string | null;
  dkimDomain: string | null;
  dmarc: string | null;
}

export interface MessageSummary {
  id: string;
  from: Address | null;
  subject: string;
  date: Date | null;
  unread: boolean;
  hasAttachments: boolean;
  snippet: string;
  surfacedHeaders: Record<string, string>;
}

export interface AttachmentMeta {
  index: number;
  filename: string;
  mimeType: string;
  size: number;
}

export interface MessageFull extends MessageSummary {
  replyTo: Address | null;
  returnPath: string | null;
  to: Address[];
  cc: Address[];
  auth: AuthResults;
  bodyText: string;
  bodyTruncated: boolean;
  // Markdown-converted display body (trimmed, untruncated; windowing is the
  // tool layer's job) and the unconverted stored body (verbatim).
  bodyMarkdown: string;
  bodyRaw: string;
  attachments: AttachmentMeta[];
  rawHeaders: string;
}

export interface AttachmentContent {
  filename: string;
  mimeType: string;
  size: number;
  content: Buffer;
}

export interface DraftAttachment {
  filename: string;
  mimeType: string;
  content: Buffer;
}

// null fields mean "not provided": createDraft treats them as empty,
// updateDraft preserves the stored draft's value (from the raw draft,
// never from a truncated display view).
export interface DraftInput {
  replyToMessageId: string | null;
  to: Address[] | null;
  cc: Address[] | null;
  bcc: Address[] | null;
  subject: string | null;
  body: string | null;
  attachments: DraftAttachment[] | null;
}

export interface ListOptions {
  folder: string | null;
  includeRead: boolean;
  limit: number;
  offset: number;
}

export interface SearchOptions {
  folder: string | null;
  query: string | null;
  from: string | null;
  subject: string | null;
  since: Date | null;
  before: Date | null;
  unreadOnly: boolean;
  limit: number;
}

// done entries carry the message's post-operation id. newId === id when the
// id is unchanged; newId === null when the backend could not learn the new id
// (the message moved successfully but must be re-listed).
export interface BulkResult {
  done: { id: string; newId: string | null }[];
  failed: { id: string; reason: string }[];
}

export interface SendResult {
  recipients: Address[];
  warning: string | null;
}

export interface MailBackend {
  listFolders(): Promise<Folder[]>;
  listMessages(options: ListOptions): Promise<MessageSummary[]>;
  search(options: SearchOptions): Promise<MessageSummary[]>;
  getMessage(id: string): Promise<MessageFull>;
  getAttachment(id: string, index: number, maxBytes: number): Promise<AttachmentContent>;
  createDraft(input: DraftInput): Promise<string>;
  updateDraft(id: string, input: DraftInput): Promise<string>;
  sendDraft(id: string): Promise<SendResult>;
  move(ids: string[], target: string): Promise<BulkResult>;
  markRead(ids: string[]): Promise<BulkResult>;
  markUnread(ids: string[]): Promise<BulkResult>;
  deleteToTrash(ids: string[]): Promise<BulkResult>;
  close(): Promise<void>;
}
