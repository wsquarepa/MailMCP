import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { filePlugin } from "../../src/graph/tokens.js";

function fakeContext(initial: string): {
  ctx: Parameters<Required<import("@azure/msal-node").ICachePlugin>["beforeCacheAccess"]>[0];
  serialized: () => string;
} {
  let state = initial;
  const tokenCache = {
    deserialize: (data: string) => { state = data; },
    serialize: () => state,
  };
  return {
    ctx: { tokenCache, cacheHasChanged: true } as never,
    serialized: () => state,
  };
}

describe("filePlugin", () => {
  const dir = mkdtempSync(join(tmpdir(), "mailmcp-tokens-"));
  const path = join(dir, "school.json");

  it("writes the serialized cache after access and reads it back before access", async () => {
    const plugin = filePlugin(path);
    const writer = fakeContext("{\"cache\":1}");
    await plugin.afterCacheAccess(writer.ctx);
    expect(await readFile(path, "utf8")).toBe("{\"cache\":1}");
    const reader = fakeContext("");
    await plugin.beforeCacheAccess(reader.ctx);
    expect(reader.serialized()).toBe("{\"cache\":1}");
  });

  it("tolerates a missing cache file on first run", async () => {
    const plugin = filePlugin(join(dir, "does-not-exist.json"));
    const reader = fakeContext("untouched");
    await expect(plugin.beforeCacheAccess(reader.ctx)).resolves.toBeUndefined();
    expect(reader.serialized()).toBe("untouched");
  });
});
