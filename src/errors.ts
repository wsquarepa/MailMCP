import type { Permission } from "./config.js";

// Message text is the agent-facing contract: it must state what to do next.
export class ToolError extends Error {}

export class PermissionError extends ToolError {
  constructor(keyName: string, permission: Permission, mailbox: string, granted: Permission[]) {
    const grants = granted.length > 0 ? granted.join(", ") : "none";
    super(`Key '${keyName}' does not have '${permission}' on mailbox '${mailbox}'. Its grants there: ${grants}.`);
  }
}

export class NotFoundError extends ToolError {
  constructor(id: string) {
    super(`Message ${id} not found; it may have been moved or deleted. Call list_messages for current ids.`);
  }
}

export class AmbiguousIdError extends ToolError {
  constructor(id: string) {
    super(`Message id ${id} matches more than one message. Call list_messages for current ids.`);
  }
}

export class AuthExpiredError extends ToolError {
  constructor(mailbox: string) {
    super(`Mailbox '${mailbox}' needs re-authentication. A human must run: mailmcp auth ${mailbox}.`);
  }
}

export class BackendUnavailableError extends ToolError {
  constructor(mailbox: string, cause: string) {
    super(`Mailbox '${mailbox}' is temporarily unavailable (${cause}). This is transient; retry later.`);
  }
}

export class InvalidInputError extends ToolError {
  constructor(detail: string) {
    super(`Invalid input: ${detail}`);
  }
}

// Post-SMTP cleanup failure: the message left the building. The one forbidden
// agent reaction is a resend, so the message says so in its first sentence.
export class SentButUnreconciledError extends ToolError {
  constructor(id: string, cause: string) {
    super(
      `Draft ${id} WAS sent successfully. Do NOT send it again. ` +
      `Post-send cleanup failed (${cause}); the draft may still exist and the Sent copy may be missing. ` +
      `A human or a later list_messages can reconcile.`,
    );
  }
}
