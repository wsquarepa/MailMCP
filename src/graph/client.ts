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
  requestTimeoutMs: number;
}

function retryDelayMs(retryAfter: string | null, attempt: number): number {
  if (retryAfter === null) return 500 * attempt;
  const seconds = Number(retryAfter);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(retryAfter);
  if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now());
  return 1000;
}

type GraphMethod = "GET" | "POST" | "PATCH" | "DELETE";

// One HTTP attempt. Throws directly for outcomes neither caller ever retries
// (401, non-retryable 4xx); returns a tagged result for outcomes graphRequest
// and graphRequestOnce disagree on how to handle (network failure, 429/5xx).
type Attempt<T> =
  | { kind: "ok"; value: T }
  | { kind: "network"; message: string }
  | { kind: "timeout"; message: string }
  | { kind: "retryable"; status: number; body: string; retryAfter: string | null };

async function attemptOnce<T>(
  connection: GraphConnection,
  method: GraphMethod,
  path: string,
  body: object | null,
): Promise<Attempt<T>> {
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
      signal: AbortSignal.timeout(connection.requestTimeoutMs),
    });
  } catch (networkError) {
    if (networkError instanceof DOMException && networkError.name === "TimeoutError") {
      return {
        kind: "timeout",
        message: `request timed out after ${connection.requestTimeoutMs}ms on ${method} ${path}`,
      };
    }
    return { kind: "network", message: `network failure on ${method} ${path}: ${String(networkError)}` };
  }
  if (response.status === 401) throw new AuthExpiredError(connection.mailboxName);
  if (response.status === 429 || response.status >= 500) {
    const responseBody = await response.text();
    return {
      kind: "retryable",
      status: response.status,
      body: responseBody.slice(0, 300),
      retryAfter: response.headers.get("retry-after"),
    };
  }
  if (!response.ok) {
    throw new GraphHttpError(response.status, await response.text(), `${method} ${path}`);
  }
  if (response.status === 204 || response.status === 202) return { kind: "ok", value: undefined as T };
  return { kind: "ok", value: (await response.json()) as T };
}

// Idempotent requests (reads, PATCH, DELETE): network failures and 429/5xx
// are retried up to MAX_ATTEMPTS, since replaying them is always safe.
// Timeouts are not retried: a server still grinding on a slow operation
// (e.g. a $search over a large mailbox) will almost certainly exceed the
// deadline again, so retrying only multiplies the wait.
export async function graphRequest<T>(
  connection: GraphConnection,
  method: GraphMethod,
  path: string,
  body: object | null,
): Promise<T> {
  let lastFailure = "no attempts made";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const result = await attemptOnce<T>(connection, method, path, body);
    if (result.kind === "ok") return result.value;
    if (result.kind === "timeout") {
      logger.warn({ mailbox: connection.mailboxName, attempt, error: result.message }, "graph request timed out");
      throw new BackendUnavailableError(
        connection.mailboxName,
        `${result.message}; the server is responding slowly. Retry later, or narrow the operation, e.g. tighter search criteria such as since/before or subject instead of a free-text query`,
      );
    }
    if (result.kind === "network") {
      lastFailure = result.message;
      logger.warn({ mailbox: connection.mailboxName, attempt, error: result.message }, "graph network failure");
      if (attempt < MAX_ATTEMPTS) await delay(retryDelayMs(null, attempt));
      continue;
    }
    lastFailure = `${result.status} on ${method} ${path}: ${result.body}`;
    logger.warn(
      { mailbox: connection.mailboxName, status: result.status, attempt },
      "graph request throttled or failed, retrying",
    );
    if (attempt < MAX_ATTEMPTS) await delay(retryDelayMs(result.retryAfter, attempt));
  }
  throw new BackendUnavailableError(connection.mailboxName, lastFailure);
}

// Non-idempotent requests (send, move, createReply, create draft, attachment
// upload): a dropped connection or 5xx gives no signal on whether Graph
// processed the request, so replaying it risks a duplicate mail operation.
// Single attempt only. 429 is safe to retry: Graph rejects a throttled
// request before processing it, so no work could have happened.
export async function graphRequestOnce<T>(
  connection: GraphConnection,
  method: GraphMethod,
  path: string,
  body: object | null,
): Promise<T> {
  let lastFailure = "no attempts made";
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const result = await attemptOnce<T>(connection, method, path, body);
    if (result.kind === "ok") return result.value;
    if (result.kind === "network" || result.kind === "timeout") {
      throw new BackendUnavailableError(
        connection.mailboxName,
        `${result.message}; the request may or may not have completed; verify before retrying`,
      );
    }
    if (result.status >= 500) {
      throw new BackendUnavailableError(
        connection.mailboxName,
        `${result.status} on ${method} ${path}: ${result.body}; the request may or may not have completed; verify before retrying`,
      );
    }
    lastFailure = `${result.status} on ${method} ${path}: ${result.body}`;
    logger.warn(
      { mailbox: connection.mailboxName, status: result.status, attempt },
      "graph request throttled, retrying (single-attempt operation, throttle rejected before processing)",
    );
    if (attempt < MAX_ATTEMPTS) await delay(retryDelayMs(result.retryAfter, attempt));
  }
  throw new BackendUnavailableError(connection.mailboxName, lastFailure);
}
