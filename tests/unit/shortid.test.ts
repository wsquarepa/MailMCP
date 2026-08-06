import { describe, expect, it } from "vitest";
import { decodeShortId, encodeShortId, isGraphId, matchesShortId } from "../../src/graph/shortid.js";

const NATIVE = "AAMkAGI2TG93AAA=";
const WHEN = new Date("2026-08-06T18:01:31Z");

describe("short id codec", () => {
  it("round-trips: encode then decode recovers the second and matches the native id", () => {
    const id = encodeShortId(NATIVE, WHEN);
    expect(id.startsWith("g:")).toBe(true);
    expect(id.length).toBeLessThan(16);
    const { second, hash4 } = decodeShortId(id);
    expect(second.toISOString()).toBe("2026-08-06T18:01:31.000Z");
    expect(hash4).toHaveLength(4);
    expect(matchesShortId(id, NATIVE)).toBe(true);
  });
  it("does not match a different native id", () => {
    expect(matchesShortId(encodeShortId(NATIVE, WHEN), "different-id")).toBe(false);
  });
  it("truncates sub-second timestamps to the containing second", () => {
    const id = encodeShortId(NATIVE, new Date("2026-08-06T18:01:31.482Z"));
    expect(decodeShortId(id).second.toISOString()).toBe("2026-08-06T18:01:31.000Z");
  });
  it("rejects malformed ids", () => {
    expect(() => decodeShortId("g:not-base36")).toThrow();
    expect(() => decodeShortId("INBOX:42")).toThrow();
  });
  it("classifies id families", () => {
    expect(isGraphId("g:abc123:0f2e")).toBe(true);
    expect(isGraphId("INBOX:42")).toBe(false);
  });
});
