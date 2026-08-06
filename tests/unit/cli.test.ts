import { describe, expect, it } from "vitest";
import { parseCliArguments, validatePort } from "../../src/cli.js";

describe("parseCliArguments", () => {
  it("parses serve", () => {
    expect(parseCliArguments(["serve"])).toEqual({ command: "serve" });
  });
  it("parses auth with a mailbox", () => {
    expect(parseCliArguments(["auth", "school"])).toEqual({ command: "auth", mailbox: "school" });
  });
  it("rejects auth without a mailbox", () => {
    expect(() => parseCliArguments(["auth"])).toThrow("Usage");
  });
  it("rejects surplus arguments", () => {
    expect(() => parseCliArguments(["serve", "extra"])).toThrow("Usage");
    expect(() => parseCliArguments(["auth", "school", "extra"])).toThrow("Usage");
  });
  it("rejects unknown commands", () => {
    expect(() => parseCliArguments(["frobnicate"])).toThrow("Usage");
  });
});

describe("validatePort", () => {
  it("accepts in-range integers", () => {
    expect(validatePort("8080")).toBe(8080);
  });
  it("rejects non-integers and out-of-range values", () => {
    expect(() => validatePort("abc")).toThrow("PORT");
    expect(() => validatePort("0")).toThrow("PORT");
    expect(() => validatePort("70000")).toThrow("PORT");
    expect(() => validatePort("80.5")).toThrow("PORT");
  });
});
