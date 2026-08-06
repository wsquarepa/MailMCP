import { ImapSmtpBackend } from "../../src/imap/backend.js";
import { imapMailboxConfig, seedMessage } from "../helpers/greenmail.js";
import { runMailBackendContract } from "./suite.js";

runMailBackendContract({
  name: "imap",
  makeBackend: async () => {
    const backend = new ImapSmtpBackend("suite", imapMailboxConfig());
    return { backend, cleanup: () => backend.close() };
  },
  seed: (subject, body) => seedMessage(subject, body, {}, []),
  bogusId: "INBOX:999999",
  selfAddress: { name: "Agent", address: "agent@example.test" },
});
