import { ImapSmtpBackend } from "../../src/imap/backend.js";
import { imapMailboxConfig, seedHtmlMessage, seedMessage } from "../helpers/greenmail.js";
import { runMailBackendContract } from "./suite.js";

runMailBackendContract({
  name: "imap",
  makeBackend: async () => {
    const backend = new ImapSmtpBackend("suite", imapMailboxConfig());
    return { backend, cleanup: () => backend.close() };
  },
  seed: (subject, body) => seedMessage(subject, body, {}, []),
  seedHtml: (subject, html) => seedHtmlMessage(subject, html),
  bogusId: "INBOX:999999",
  selfAddress: { name: "Agent", address: "agent@example.test" },
  draftsFolder: "Drafts",
  sentFolder: "Sent",
});
