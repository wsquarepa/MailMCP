import { describe, expect, it } from "vitest";
import {
  htmlToPlainText, makeSnippet, stripQuotedAndSignature, truncateBody,
} from "../../src/mail/clean.js";

describe("htmlToPlainText", () => {
  it("converts markup to readable text without link noise", () => {
    const text = htmlToPlainText("<p>Hello <b>world</b></p><p>Second</p>");
    expect(text).toContain("Hello world");
    expect(text).toContain("Second");
  });
});

describe("stripQuotedAndSignature", () => {
  it("drops > quoted lines and the On ... wrote: intro", () => {
    const input = [
      "Thanks, merged.",
      "",
      "On Tue, Aug 5, 2026 at 9:00 AM GitHub <n@github.test> wrote:",
      "> The workflow test failed",
      "> on commit abc123",
    ].join("\n");
    expect(stripQuotedAndSignature(input)).toBe("Thanks, merged.");
  });
  it("drops everything after a -- signature marker", () => {
    const input = "Body line.\n-- \nA. Sender\nexample.org";
    expect(stripQuotedAndSignature(input)).toBe("Body line.");
  });
  it("drops Original Message forwards", () => {
    const input = "See below.\n-----Original Message-----\nFrom: x";
    expect(stripQuotedAndSignature(input)).toBe("See below.");
  });
});

describe("makeSnippet", () => {
  it("collapses whitespace and cuts at a word boundary with ellipsis", () => {
    const snippet = makeSnippet("word ".repeat(100), 50);
    expect(snippet.length).toBeLessThanOrEqual(51);
    expect(snippet.endsWith("...")).toBe(true);
  });
  it("returns short text unchanged", () => {
    expect(makeSnippet("Short body.", 200)).toBe("Short body.");
  });
});

describe("truncateBody", () => {
  it("flags truncation and keeps text under the cap", () => {
    const { text, truncated } = truncateBody("x".repeat(60_000), 50_000);
    expect(truncated).toBe(true);
    expect(text.length).toBe(50_000);
  });
  it("passes small bodies through", () => {
    expect(truncateBody("hi", 50_000)).toEqual({ text: "hi", truncated: false });
  });
});
