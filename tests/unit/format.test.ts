import { describe, expect, it } from "vitest";
import { windowBody } from "../../src/mail/clean.js";
import { formatBulk, formatListing, formatMessage } from "../../src/mail/format.js";
import type { MessageFull, MessageSummary } from "../../src/types.js";

const SUMMARY: MessageSummary = {
  id: "INBOX:4213",
  from: { name: "GitHub", address: "notifications@github.test" },
  subject: "[MailMCP] CI failed on main",
  date: new Date(Date.UTC(2026, 7, 6, 9, 12)),
  unread: true,
  hasAttachments: false,
  snippet: "The workflow test failed on commit abc123.",
  surfacedHeaders: { "X-Spam-Score": "-1.2" },
};

describe("formatListing", () => {
  it("renders the spec's listing entry shape", () => {
    const text = formatListing("hermes", "INBOX", [SUMMARY], "1 unread shown");
    expect(text).toContain("[hermes INBOX:4213] unread · 2026-08-06 09:12");
    expect(text).toContain("GitHub <notifications@github.test> · Subj: [MailMCP] CI failed on main");
    expect(text).toContain("atts: 0 · X-Spam-Score: -1.2");
    expect(text).toContain('"The workflow test failed on commit abc123."');
  });
  it("says so when there are no messages", () => {
    expect(formatListing("hermes", "INBOX", [], "no matches")).toContain("No messages");
  });
});

describe("formatMessage", () => {
  const FULL: MessageFull = {
    ...SUMMARY,
    replyTo: null,
    returnPath: "bounce@github.test",
    to: [{ name: "", address: "hermes@example.org" }],
    cc: [],
    auth: { spf: "pass", dkim: "pass", dkimDomain: "github.test", dmarc: "pass" },
    bodyMarkdown: "Full body here.",
    bodyRaw: "<p>Full body here.</p>",
    attachments: [],
    rawHeaders: "Received: from x\r\nFrom: GitHub <notifications@github.test>",
  };
  it("leads with envelope, then auth summary, then body", () => {
    const text = formatMessage("hermes", FULL, {
      includeRawHeaders: false,
      raw: false,
      body: windowBody(FULL.bodyMarkdown, 0, 30_000),
    });
    const envelopeIndex = text.indexOf("From: GitHub <notifications@github.test>");
    const authIndex = text.indexOf("SPF pass · DKIM pass (github.test) · DMARC pass");
    const bodyIndex = text.indexOf("Full body here.");
    expect(envelopeIndex).toBeGreaterThanOrEqual(0);
    expect(authIndex).toBeGreaterThan(envelopeIndex);
    expect(bodyIndex).toBeGreaterThan(authIndex);
    expect(text).not.toContain("Received: from x");
  });
  it("appends raw headers only on request", () => {
    const text = formatMessage("hermes", FULL, {
      includeRawHeaders: true,
      raw: false,
      body: windowBody(FULL.bodyMarkdown, 0, 30_000),
    });
    expect(text).toContain("Received: from x");
  });
  it("notes the continuation point for windowed bodies", () => {
    const text = formatMessage("hermes", FULL, {
      includeRawHeaders: false,
      raw: false,
      body: { text: "Full", start: 0, end: 4, total: 20 },
    });
    expect(text).toContain(
      "[body continues: showing chars 0-4 of 20; call get_message again with body_offset=4]",
    );
  });

  it("appends raw=true to the continuation note for raw bodies", () => {
    const text = formatMessage("hermes", FULL, {
      includeRawHeaders: false,
      raw: true,
      body: { text: "Full", start: 0, end: 4, total: 20 },
    });
    expect(text).toContain(
      "[body continues: showing chars 0-4 of 20; call get_message again with body_offset=4 and raw=true]",
    );
  });

  it("emits no note when the window reaches the end", () => {
    const text = formatMessage("hermes", FULL, {
      includeRawHeaders: false,
      raw: false,
      body: { text: "tail", start: 16, end: 20, total: 20 },
    });
    expect(text).not.toContain("[body continues");
  });
});

describe("formatBulk", () => {
  it("reports per-id outcomes with changed ids mapped", () => {
    const text = formatBulk("Moved to junk", {
      done: [
        { id: "INBOX:1", newId: "Junk:7" },
        { id: "g:abc:0f2e", newId: "g:abc:0f2e" },
        { id: "INBOX:2", newId: null },
      ],
      failed: [{ id: "INBOX:99", reason: "not found" }],
    });
    expect(text).toContain("Moved to junk: 3 done, 1 failed.");
    expect(text).toContain("INBOX:1 -> Junk:7.");
    expect(text).not.toContain("g:abc:0f2e ->");
    expect(text).toContain("INBOX:2: moved, new id unknown (re-list to get it).");
    expect(text).toContain("INBOX:99: not found.");
  });
  it("stays quiet when nothing changed ids and nothing failed", () => {
    const text = formatBulk("Marked read", {
      done: [{ id: "INBOX:1", newId: "INBOX:1" }],
      failed: [],
    });
    expect(text).toBe("Marked read: 1 done, 0 failed.");
  });
});
