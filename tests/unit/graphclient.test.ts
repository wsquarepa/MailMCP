import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AuthExpiredError, BackendUnavailableError } from "../../src/errors.js";
import { GraphHttpError, graphRequest, graphRequestOnce } from "../../src/graph/client.js";

let server: Server;
let baseUrl = "";
let hits = 0;

beforeAll(async () => {
  server = createServer((req, res) => {
    hits += 1;
    if (req.url === "/retry-then-ok") {
      if (hits < 3) { res.writeHead(429, { "retry-after": "0" }).end("throttled"); return; }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/retry-date") {
      if (hits < 2) {
        res.writeHead(503, { "retry-after": new Date(Date.now() + 100).toUTCString() }).end("down");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
      return;
    }
    if (req.url === "/always-503") { res.writeHead(503, { "retry-after": "0" }).end("down"); return; }
    if (req.url === "/drop") { req.socket.destroy(); return; }
    if (req.url === "/unauthorized") { res.writeHead(401).end("expired"); return; }
    if (req.url === "/teapot") { res.writeHead(418).end("nope"); return; }
    if (req.url === "/echo-prefer") {
      res.writeHead(200, { "content-type": "application/json" })
        .end(JSON.stringify({ prefer: req.headers.prefer ?? "" }));
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, () => resolve()));
  const address = server.address();
  baseUrl = `http://localhost:${typeof address === "object" && address !== null ? address.port : 0}`;
});
afterAll(() => server.close());

function connection() {
  return { baseUrl, mailboxName: "school", getToken: async () => "tok" };
}

describe("graphRequest", () => {
  it("retries 429 honoring numeric retry-after, then succeeds", async () => {
    hits = 0;
    const result = await graphRequest<{ ok: boolean }>(connection(), "GET", "/retry-then-ok", null);
    expect(result.ok).toBe(true);
    expect(hits).toBe(3);
  });
  it("parses http-date retry-after", async () => {
    hits = 0;
    const result = await graphRequest<{ ok: boolean }>(connection(), "GET", "/retry-date", null);
    expect(result.ok).toBe(true);
  });
  it("maps exhausted retryable failures to BackendUnavailableError", async () => {
    await expect(graphRequest(connection(), "GET", "/always-503", null))
      .rejects.toThrow(BackendUnavailableError);
  });
  it("retries network-level failures and maps exhaustion to BackendUnavailableError", async () => {
    await expect(graphRequest(connection(), "GET", "/drop", null))
      .rejects.toThrow(BackendUnavailableError);
  });
  it("maps 401 to AuthExpiredError", async () => {
    await expect(graphRequest(connection(), "GET", "/unauthorized", null))
      .rejects.toThrow(AuthExpiredError);
  });
  it("throws GraphHttpError with status and body for non-retryable failures", async () => {
    const error = await graphRequest(connection(), "GET", "/teapot", null).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(GraphHttpError);
    expect((error as GraphHttpError).status).toBe(418);
    expect((error as GraphHttpError).body).toContain("nope");
  });
  it("requests immutable ids on every call", async () => {
    const result = await graphRequest<{ prefer: string }>(connection(), "GET", "/echo-prefer", null);
    expect(result.prefer).toBe('IdType="ImmutableId"');
  });
});

describe("graphRequestOnce", () => {
  it("does not retry a 503: exactly one hit, throws BackendUnavailableError", async () => {
    hits = 0;
    await expect(graphRequestOnce(connection(), "POST", "/always-503", null))
      .rejects.toThrow(BackendUnavailableError);
    expect(hits).toBe(1);
  });
  it("still retries a 429 with Retry-After and succeeds", async () => {
    hits = 0;
    const result = await graphRequestOnce<{ ok: boolean }>(connection(), "POST", "/retry-then-ok", null);
    expect(result.ok).toBe(true);
    expect(hits).toBe(3);
  });
});
