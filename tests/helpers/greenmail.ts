import { createTransport } from "nodemailer";
import type { MailboxConfig } from "../../src/config.js";

export const TEST_USER = { user: "agent@example.test", pass: "secret" };

export function imapMailboxConfig(): Extract<MailboxConfig, { backend: "imap" }> {
  return {
    backend: "imap",
    address: "Agent <agent@example.test>",
    imap: { host: "localhost", port: 3143, secure: false, ...TEST_USER },
    smtp: { host: "localhost", port: 3025, secure: false, ...TEST_USER },
    surface_headers: ["X-Spam-Score"],
  };
}

export async function seedMessage(
  subject: string,
  body: string,
  headers: Record<string, string>,
  attachments: { filename: string; content: Buffer }[],
): Promise<void> {
  const transport = createTransport({ host: "localhost", port: 3025, secure: false });
  await transport.sendMail({
    from: "Sender <sender@example.test>",
    to: "agent@example.test",
    subject,
    text: body,
    headers,
    attachments: attachments.map((a) => ({ filename: a.filename, content: a.content })),
  });
}
