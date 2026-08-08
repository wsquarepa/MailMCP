import { readFileSync } from "node:fs";
import { simpleParser } from "mailparser";
import { describe, expect, it } from "vitest";
import {
  htmlToMarkdown, htmlToPlainText, makeSnippet, stripQuotedAndSignature, truncateBody,
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

describe("htmlToMarkdown", () => {
  it("preserves links inline with verbatim hrefs", () => {
    const md = htmlToMarkdown('<p>See <a href="https://x.test/a?id=1&amp;sig=abc">the docs</a></p>');
    expect(md).toContain("[the docs](https://x.test/a?id=1&sig=abc)");
  });

  it("renders headings, lists, and GFM tables", () => {
    const md = htmlToMarkdown(
      "<h1>Title</h1><ul><li>one</li><li>two</li></ul>" +
      "<table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>",
    );
    expect(md).toContain("# Title");
    expect(md).toContain("-   one");
    expect(md).toContain("| A | B |");
    expect(md).toContain("| 1 | 2 |");
  });

  it("drops images, keeping only alt text", () => {
    const md = htmlToMarkdown('<p><img src="https://t.test/pixel.gif" alt="Logo"> hello</p>');
    expect(md).toContain("Logo");
    expect(md).toContain("hello");
    expect(md).not.toContain("pixel.gif");
  });

  it("drops script and style content", () => {
    const md = htmlToMarkdown("<style>p{color:red}</style><p>Visible</p><script>alert(1)</script>");
    expect(md).toContain("Visible");
    expect(md).not.toContain("alert");
    expect(md).not.toContain("color:red");
  });

  it("tolerates malformed HTML", () => {
    expect(htmlToMarkdown("<div><p>Unclosed <b>bold")).toContain("Unclosed **bold**");
  });

  it("converts a real-world Outlook message cleanly", async () => {
    const source = readFileSync(new URL("../fixtures/outlook-sample.eml", import.meta.url));
    const parsed = await simpleParser(source);
    expect(parsed.html).not.toBe(false);
    const md = htmlToMarkdown(parsed.html as string);
    expect(md).toContain("](https://example.test/zoom/j/82999843780?pwd=SamplePwd123)");
    expect(md).toContain("https://example.test/canvas/pages/final-exam");
    expect(md).toContain("Hi Agent,");
    expect(md).not.toContain("data:image");
    expect(md).not.toContain("iVBOR");
    expect(md).not.toContain("font-family");
    expect(md).not.toContain("elementToProof");
  });
});
