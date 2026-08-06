import { setTimeout as delay } from "node:timers/promises";
import { AuthExpiredError, BackendUnavailableError } from "../errors.js";
import { logger } from "../logger.js";

const MAX_ATTEMPTS = 3;

export class GraphHttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly body: string,
    context: string,
  ) {
    super(`Graph request failed (${status}) at ${context}: ${body}`);
  }
}

export interface GraphConnection {
  baseUrl: string;
  mailboxName: string;
  getToken: () => Promise<string>;
}

function retryDelayMs(retryAfter: string | null, attempt: number): number {
  if (retryAfter === null) return 500 * attempt;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(retryAfter);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return 1000;
}

export async function graphRequest<T>(
  connection: GraphConnection,
  method: "GET" | "POST" | "PATCH" | "DELETE",
  path: string,
  body: object | null,
): Promise<T> {
  let lastFailure = "no attempts made";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const token = await connection.getToken();
    let response: Response;
    try {
      response = await fetch(`${connection.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          prefer: 'IdType="ImmutableId"',
          ...(body !== null ? { "content-type": "application/json" } : {}),
        },
        body: body !== null ? JSON.stringify(body) : null,
      });
    } catch (networkError) {
      lastFailure = `network failure on ${method} ${path}: ${String(networkError)}`;
      logger.warn({ mailbox: connection.mailboxName, attempt, error: String(networkError) }, "graph network failure");
      if (attempt < MAX_ATTEMPTS) await delay(retryDelayMs(null, attempt));
      continue;
    }
    if (response.status === 401) throw new AuthExpiredError(connection.mailboxName);
    if (response.status === 429 || response.status >= 500) {
      const responseBody = await response.text();
      lastFailure = `${response.status} on ${method} ${path}: ${responseBody.slice(0, 300)}`;
      logger.warn(
        { mailbox: connection.mailboxName, status: response.status, attempt },
        "graph request throttled or failed, retrying",
      );
      if (attempt < MAX_ATTEMPTS) await delay(retryDelayMs(response.headers.get("retry-after"), attempt));
      continue;
    }
    if (!response.ok) {
      throw new GraphHttpError(response.status, await response.text(), `${method} ${path}`);
    }
    if (response.status === 204 || response.status === 202) return undefined as T;
    return (await response.json()) as T;
  }
  throw new BackendUnavailableError(connection.mailboxName, lastFailure);
}
