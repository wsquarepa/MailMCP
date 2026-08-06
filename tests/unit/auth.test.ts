import { describe, expect, it } from "vitest";
import { accessibleMailboxes, effectivePermissions, findKey, requirePermission } from "../../src/auth.js";
import type { Config } from "../../src/config.js";
import { PermissionError } from "../../src/errors.js";

const IMAP_SERVER = { host: "h", port: 1, secure: true, user: "u", pass: "p" };
const CONFIG: Config = {
  mailboxes: {
    hermes: { backend: "imap", address: "Hermes <h@x.test>", imap: IMAP_SERVER, smtp: IMAP_SERVER },
    shared: {
      backend: "imap", address: "Pool <p@x.test>", imap: IMAP_SERVER, smtp: IMAP_SERVER,
      public: ["read", "draft"],
    },
  },
  keys: [
    {
      name: "hermes", token: "tok-0123456789abcdef", default_mailbox: "hermes",
      grants: { hermes: ["read", "draft", "send"], shared: ["send"] },
    },
    { name: "guest", token: "tok-fedcba9876543210", default_mailbox: "shared" },
  ],
};

describe("findKey", () => {
  it("resolves a key by token and rejects unknown tokens", () => {
    expect(findKey(CONFIG, "tok-0123456789abcdef")?.name).toBe("hermes");
    expect(findKey(CONFIG, "wrong")).toBeNull();
  });
});

describe("effectivePermissions", () => {
  it("unions public baseline with explicit grants", () => {
    const perms = effectivePermissions(CONFIG, CONFIG.keys[0]!, "shared");
    expect([...perms].sort()).toEqual(["draft", "read", "send"]);
  });
  it("gives public-only access to keys without grants", () => {
    expect(effectivePermissions(CONFIG, CONFIG.keys[1]!, "shared")).toEqual(["read", "draft"]);
    expect(effectivePermissions(CONFIG, CONFIG.keys[1]!, "hermes")).toEqual([]);
  });
});

describe("accessibleMailboxes", () => {
  it("lists only mailboxes with at least one permission, flagging the default", () => {
    const rows = accessibleMailboxes(CONFIG, CONFIG.keys[1]!);
    expect(rows).toEqual([
      { mailbox: "shared", permissions: ["read", "draft"], isDefault: true, address: "Pool <p@x.test>" },
    ]);
  });
});

describe("requirePermission", () => {
  it("throws PermissionError naming current grants", () => {
    expect(() => requirePermission(CONFIG, CONFIG.keys[1]!, "shared", "send"))
      .toThrow(PermissionError);
  });
  it("passes silently when granted", () => {
    expect(() => requirePermission(CONFIG, CONFIG.keys[0]!, "hermes", "send")).not.toThrow();
  });
});
