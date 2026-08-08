import type { Config, KeyConfig } from "../config.js";
import { InvalidInputError } from "../errors.js";
import { GraphBackend } from "../graph/backend.js";
import { GraphTokenProvider } from "../graph/tokens.js";
import { ImapSmtpBackend } from "../imap/backend.js";
import type { MailBackend } from "../types.js";
import type { UploadStore } from "../uploads.js";

export const GRAPH_BASE_URL = "https://graph.microsoft.com/v1.0";
// Healthy Graph calls complete in well under 10s; the outliers are Exchange's
// $search substrate grinding (observed up to 182s in production). Fail fast
// with guidance to narrow the query instead of hanging the tool call.
export const GRAPH_REQUEST_TIMEOUT_MS = 30_000;

export interface ToolContext {
  config: Config;
  key: KeyConfig;
  backends: Map<string, MailBackend>;
  uploads: UploadStore;
}

export function buildBackends(config: Config, graphCacheDir: string): Map<string, MailBackend> {
  const backends = new Map<string, MailBackend>();
  for (const [name, mailbox] of Object.entries(config.mailboxes)) {
    if (mailbox.backend === "imap") {
      backends.set(name, new ImapSmtpBackend(name, mailbox));
    } else {
      const tokens = new GraphTokenProvider(name, mailbox.graph.tenant_id, mailbox.graph.client_id, graphCacheDir);
      backends.set(name, new GraphBackend(name, mailbox, {
        baseUrl: GRAPH_BASE_URL,
        mailboxName: name,
        getToken: () => tokens.getToken(),
        requestTimeoutMs: GRAPH_REQUEST_TIMEOUT_MS,
      }));
    }
  }
  return backends;
}

export async function closeBackends(backends: Map<string, MailBackend>): Promise<void> {
  for (const backend of backends.values()) await backend.close();
}

export function resolveMailbox(
  context: ToolContext,
  requested: string | null,
): { name: string; backend: MailBackend } {
  const name = requested ?? context.key.default_mailbox;
  const backend = context.backends.get(name);
  if (backend === undefined) {
    const known = [...context.backends.keys()].join(", ");
    throw new InvalidInputError(`unknown mailbox '${name}'. Configured mailboxes: ${known}`);
  }
  return { name, backend };
}
