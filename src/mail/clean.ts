import { convert } from "html-to-text";
import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

export const SNIPPET_MAX_CHARS = 200;
// Display cap for get_message output only. Draft update/send paths always
// operate on the raw stored draft, never on text truncated by this cap.
export const BODY_MAX_CHARS = 30_000;
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024;

const turndown = new TurndownService({
  headingStyle: "atx",
  codeBlockStyle: "fenced",
  bulletListMarker: "-",
});
turndown.use(gfm);
turndown.remove(["script", "style", "title"]);
// Email images are overwhelmingly tracking pixels and layout spacers; keep
// only the alt text so the reader loses nothing meaningful.
turndown.addRule("imgAltText", {
  filter: "img",
  replacement: (_content, node) => (node as HTMLElement).getAttribute("alt") ?? "",
});

export function htmlToMarkdown(html: string): string {
  return turndown.turndown(html);
}

export function htmlToPlainText(html: string): string {
  return convert(html, {
    wordwrap: false,
    selectors: [
      { selector: "a", options: { ignoreHref: true } },
      { selector: "img", format: "skip" },
    ],
  });
}

const QUOTE_INTRO = /^On .{0,120} wrote:\s*$/;
const FORWARD_MARKER = /^-{2,}\s*(Original Message|Forwarded message)\s*-{2,}/i;
const SIGNATURE_MARKER = /^-- $/;

export function stripQuotedAndSignature(text: string): string {
  const kept: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (SIGNATURE_MARKER.test(line) || FORWARD_MARKER.test(line) || QUOTE_INTRO.test(line)) break;
    if (line.startsWith(">")) continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

export function makeSnippet(text: string, maxChars: number): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  const cut = collapsed.slice(0, maxChars - 3);
  const lastSpace = cut.lastIndexOf(" ");
  return `${cut.slice(0, lastSpace > 0 ? lastSpace : cut.length)}...`;
}

export interface BodyWindow {
  text: string;
  start: number;
  end: number;
  total: number;
}

export function windowBody(text: string, offset: number, maxChars: number): BodyWindow {
  const end = Math.min(offset + maxChars, text.length);
  return { text: text.slice(offset, end), start: offset, end, total: text.length };
}
