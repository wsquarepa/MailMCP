import type { AuthResults } from "../types.js";

// RFC 8601 Authentication-Results. Headers fold across lines; unfold first.
function unfold(rawHeaders: string): string {
  return rawHeaders.replace(/\r?\n[ \t]+/g, " ");
}

export function parseAuthResults(rawHeaders: string): AuthResults {
  const line = unfold(rawHeaders)
    .split(/\r?\n/)
    .find((l) => /^authentication-results:/i.test(l));
  if (line === undefined) {
    return { spf: null, dkim: null, dkimDomain: null, dmarc: null };
  }
  const method = (name: string): string | null =>
    line.match(new RegExp(`\\b${name}=([a-z]+)`, "i"))?.[1]?.toLowerCase() ?? null;
  return {
    spf: method("spf"),
    dkim: method("dkim"),
    dkimDomain: line.match(/\bdkim=[a-z]+[^;]*\bheader\.d=([^\s;]+)/i)?.[1] ?? null,
    dmarc: method("dmarc"),
  };
}

export function formatAuthSummary(auth: AuthResults): string {
  const dkim =
    auth.dkim !== null && auth.dkimDomain !== null ? `${auth.dkim} (${auth.dkimDomain})` : auth.dkim ?? "none";
  return `SPF ${auth.spf ?? "none"} · DKIM ${dkim} · DMARC ${auth.dmarc ?? "none"}`;
}
