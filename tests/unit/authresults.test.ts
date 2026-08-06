import { describe, expect, it } from "vitest";
import { formatAuthSummary, parseAuthResults } from "../../src/mail/authresults.js";

const HEADERS = [
  "Return-Path: <bounce@example.org>",
  "Authentication-Results: mx.example.test;",
  " spf=pass smtp.mailfrom=example.org;",
  " dkim=pass header.d=example.org;",
  " dmarc=pass header.from=example.org",
  "From: Hermes <hermes@example.org>",
].join("\r\n");

describe("parseAuthResults", () => {
  it("extracts spf, dkim (with domain), and dmarc verdicts", () => {
    expect(parseAuthResults(HEADERS)).toEqual({
      spf: "pass", dkim: "pass", dkimDomain: "example.org", dmarc: "pass",
    });
  });
  it("returns nulls when the header is absent", () => {
    expect(parseAuthResults("From: a <a@b.test>\r\n")).toEqual({
      spf: null, dkim: null, dkimDomain: null, dmarc: null,
    });
  });
  it("handles fail verdicts", () => {
    const failed = HEADERS.replace("spf=pass", "spf=fail").replace("dmarc=pass", "dmarc=fail");
    const auth = parseAuthResults(failed);
    expect(auth.spf).toBe("fail");
    expect(auth.dmarc).toBe("fail");
  });
});

describe("formatAuthSummary", () => {
  it("renders verdicts with the dkim domain", () => {
    expect(formatAuthSummary({ spf: "pass", dkim: "pass", dkimDomain: "example.org", dmarc: "pass" }))
      .toBe("SPF pass · DKIM pass (example.org) · DMARC pass");
  });
  it("renders absent methods as none", () => {
    expect(formatAuthSummary({ spf: null, dkim: null, dkimDomain: null, dmarc: null }))
      .toBe("SPF none · DKIM none · DMARC none");
  });
});
