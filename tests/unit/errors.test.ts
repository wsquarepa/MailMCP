import { describe, expect, it } from "vitest";
import {
  AuthExpiredError, NotFoundError, PermissionError, SentButUnreconciledError,
} from "../../src/errors.js";

describe("agent-facing error messages", () => {
  it("permission error names key, permission, mailbox, and current grants", () => {
    const err = new PermissionError("openclaw", "send", "shared", ["read", "draft"]);
    expect(err.message).toBe(
      "Key 'openclaw' does not have 'send' on mailbox 'shared'. Its grants there: read, draft.",
    );
  });
  it("permission error with no grants says none", () => {
    const err = new PermissionError("openclaw", "read", "school", []);
    expect(err.message).toContain("Its grants there: none.");
  });
  it("not-found error tells the agent to re-list", () => {
    expect(new NotFoundError("INBOX:4213").message).toBe(
      "Message INBOX:4213 not found; it may have been moved or deleted. Call list_messages for current ids.",
    );
  });
  it("auth-expired error names the re-auth command", () => {
    expect(new AuthExpiredError("school").message).toBe(
      "Mailbox 'school' needs re-authentication. A human must run: mailmcp auth school.",
    );
  });
  it("sent-but-unreconciled forbids resending", () => {
    const err = new SentButUnreconciledError("Drafts:9", "Sent append failed");
    expect(err.message).toContain("WAS sent");
    expect(err.message).toContain("Do NOT send it again");
    expect(err.message).toContain("Sent append failed");
  });
});
