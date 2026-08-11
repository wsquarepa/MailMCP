import { createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AmbiguousIdError, NotFoundError } from "../../src/errors.js";
import { GraphBackend } from "../../src/graph/backend.js";
import { encodeShortId } from "../../src/graph/shortid.js";
import { FakeGraph } from "../fakes/fakeGraph.js";

const CONFIG = {
  backend: "graph" as const,
  address: "Agent <school@school.test>",
  graph: { tenant_id: "t", client_id: "c" },
  surface_headers: ["X-Spam-Score"],
};

const hash4 = (s: string): string => createHash("sha256").update(s).digest("hex").slice(0, 4);

// Deterministic birthday-collision search over sha256(counter) hash4 prefixes
// (16-bit space): finds a colliding pair in-process, no network, no randomness.
function findHash4Collision(): { a: string; b: string } {
  const seen = new Map<string, string>();
  for (let i = 0; ; i += 1) {
    const id = `collide-${i}`;
    const h = hash4(id);
    const existing = seen.get(h);
    if (existing !== undefined) return { a: existing, b: id };
    seen.set(h, id);
  }
}

describe("GraphBackend reads (fake Graph)", () => {
  const fake = new FakeGraph();
  let backend: GraphBackend;
  // Stored ms .482 inside second :31: rendered values truncate, forcing range resolution.
  const receivedAt = new Date("2026-08-06T18:01:31.482Z");
  let nativeId = "";
  let draftNativeId = "";

  beforeAll(async () => {
    const baseUrl = await fake.start();
    nativeId = fake.seed({
      folder: "inbox", subject: "graph-read", fromName: "Sender", fromAddress: "s@x.test",
      body: "Graph body line.", isRead: false, receivedAt,
      headers: { "X-Spam-Score": "-2.0", "Authentication-Results": "mx; spf=pass; dkim=pass header.d=x.test; dmarc=pass" },
    });
    fake.seed({
      folder: "inbox", subject: "already-read", fromName: "Other", fromAddress: "o@x.test",
      body: "read one", isRead: true, receivedAt: new Date("2026-08-06T17:00:00Z"), headers: {},
    });
    draftNativeId = fake.seed({
      folder: "drafts", subject: "a-draft", fromName: "Agent", fromAddress: "school@school.test",
      body: "draft body", isRead: true, receivedAt: new Date("2026-08-06T16:00:00.250Z"), headers: {},
    });
    backend = new GraphBackend("school", CONFIG, {
      baseUrl, mailboxName: "school", getToken: async () => "test-token", requestTimeoutMs: 5000,
    });
  });
  afterAll(async () => await fake.stop());

  it("lists unread by default with compliant filter/order and surfaced headers", async () => {
    const messages = await backend.listMessages({ folder: null, includeRead: false, limit: 20, offset: 0 });
    expect(messages).toHaveLength(1);
    const m = messages[0]!;
    expect(m.subject).toBe("graph-read");
    expect(m.id).toMatch(/^g:[0-9a-z]+:[0-9a-f]{4}$/);
    expect(m.snippet).toContain("Graph body line.");
    expect(m.surfacedHeaders["X-Spam-Score"]).toBe("-2.0");
  });

  it("lists the drafts folder ordered by createdDateTime", async () => {
    const drafts = await backend.listMessages({ folder: "drafts", includeRead: true, limit: 20, offset: 0 });
    expect(drafts.some((m) => m.subject === "a-draft")).toBe(true);
  });

  it("resolves a received short id via range query after a cache wipe", async () => {
    const shortId = encodeShortId(nativeId, receivedAt);
    backend.clearIdCache();
    const full = await backend.getMessage(shortId);
    expect(full.subject).toBe("graph-read");
    expect(full.auth.spf).toBe("pass");
    expect(full.bodyMarkdown).toContain("Graph body line.");
    expect(full.rawHeaders).toContain("X-Spam-Score");
  });

  it("resolves a DRAFT short id via createdDateTime on a cold cache", async () => {
    const shortId = encodeShortId(draftNativeId, new Date("2026-08-06T16:00:00.250Z"));
    backend.clearIdCache();
    const draft = await backend.getMessage(shortId);
    expect(draft.subject).toBe("a-draft");
  });

  it("throws AmbiguousIdError when two same-second messages collide on hash4", async () => {
    const collisionSecond = new Date("2026-08-06T19:30:00.100Z");
    const { a: idA, b: idB } = findHash4Collision();
    const firstId = fake.seed({
      folder: "inbox", subject: "collide-1", fromName: "A", fromAddress: "a@x.test",
      body: "one", isRead: true, receivedAt: collisionSecond, headers: {}, id: idA,
    });
    fake.seed({
      folder: "inbox", subject: "collide-2", fromName: "B", fromAddress: "b@x.test",
      body: "two", isRead: true, receivedAt: collisionSecond, headers: {}, id: idB,
    });
    backend.clearIdCache();
    const shortId = encodeShortId(firstId, collisionSecond);
    await expect(backend.getMessage(shortId)).rejects.toThrow(AmbiguousIdError);
  });

  it("raises NotFoundError for an id whose hash matches nothing", async () => {
    const bogus = encodeShortId("nonexistent-native-id", receivedAt);
    backend.clearIdCache();
    await expect(backend.getMessage(bogus)).rejects.toThrow(NotFoundError);
  });

  it("search with a from filter skips messages whose sender address is null", async () => {
    fake.seed({
      folder: "inbox", subject: "system-notice", fromName: "Postmaster", fromAddress: null,
      body: "postmaster delivery notice", isRead: true,
      receivedAt: new Date("2026-08-06T15:00:00Z"), headers: {},
    });
    const hits = await backend.search({
      folder: null, query: "postmaster", from: "s@x.test", subject: null,
      since: null, before: null, unreadOnly: false, limit: 10,
    });
    expect(hits).toHaveLength(0);
  });

  it("searches a user-created folder by display name despite its null wellKnownName", async () => {
    fake.seed({
      folder: "custom", subject: "alpha-report", fromName: "PM", fromAddress: "pm@x.test",
      body: "quarterly report", isRead: true,
      receivedAt: new Date("2026-08-06T14:00:00Z"), headers: {},
    });
    const hits = await backend.search({
      folder: "Project Alpha", query: null, from: null, subject: "alpha-report",
      since: null, before: null, unreadOnly: false, limit: 10,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.subject).toBe("alpha-report");
  });

  it("searches with free text and client-side criteria in one folder", async () => {
    const hits = await backend.search({
      folder: null, query: "Graph body", from: "s@x.test", subject: null,
      since: null, before: null, unreadOnly: true, limit: 10,
    });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.subject).toBe("graph-read");
  });
});
