import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, interpolateEnv, loadConfig } from "../../src/config.js";

const VALID = `
mailboxes:
  hermes:
    backend: imap
    address: "Hermes Agent <hermes@example.test>"
    imap: { host: localhost, port: 3993, secure: true, user: hermes@example.test, pass: "\${TEST_PASS}" }
    smtp: { host: localhost, port: 3465, secure: true, user: hermes@example.test, pass: "\${TEST_PASS}" }
    surface_headers: [X-Spam-Score]
  school:
    backend: graph
    address: "W <w@school.test>"
    graph: { tenant_id: t-1, client_id: c-1 }
    public: [read]
keys:
  - name: hermes
    token: \${TEST_TOKEN}
    default_mailbox: hermes
    grants:
      hermes: [read, draft, send, organize, delete]
`;

function writeTemp(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "mailmcp-config-"));
  const path = join(dir, "config.yml");
  writeFileSync(path, content);
  return path;
}

const ENV = { TEST_PASS: "s3cret", TEST_TOKEN: "tok-0123456789abcdef" };

describe("interpolateEnv", () => {
  it("substitutes ${VAR} references", () => {
    expect(interpolateEnv("a ${TEST_PASS} b", ENV)).toBe("a s3cret b");
  });
  it("throws naming the missing variable", () => {
    expect(() => interpolateEnv("${NOPE_MISSING}", ENV)).toThrow("NOPE_MISSING");
  });
});

describe("loadConfig", () => {
  it("parses a valid config with interpolated secrets", () => {
    const config = loadConfig(writeTemp(VALID), ENV);
    const hermes = config.mailboxes["hermes"];
    expect(hermes?.backend).toBe("imap");
    if (hermes?.backend === "imap") expect(hermes.imap.pass).toBe("s3cret");
    expect(config.keys[0]?.token).toBe("tok-0123456789abcdef");
  });
  it("rejects a misspelled permission", () => {
    const bad = VALID.replace("[read, draft, send, organize, delete]", "[read, sendd]");
    expect(() => loadConfig(writeTemp(bad), ENV)).toThrow();
  });
  it("rejects unknown fields", () => {
    const bad = VALID.replace("surface_headers:", "surface_headerz:");
    expect(() => loadConfig(writeTemp(bad), ENV)).toThrow();
  });
  it("rejects grants referencing an unknown mailbox", () => {
    const bad = VALID.replace("hermes: [read, draft, send, organize, delete]", "ghost: [read]");
    expect(() => loadConfig(writeTemp(bad), ENV)).toThrow("ghost");
  });
  it("rejects an unknown default_mailbox", () => {
    const bad = VALID.replace("default_mailbox: hermes", "default_mailbox: ghost");
    expect(() => loadConfig(writeTemp(bad), ENV)).toThrow("ghost");
  });
  it("rejects a key whose default mailbox grants it nothing", () => {
    const bad = VALID.replace(/    grants:\n      hermes: \[read, draft, send, organize, delete\]\n/, "");
    expect(() => loadConfig(writeTemp(bad), ENV)).toThrow("no permissions");
  });
  it("rejects duplicate key names and duplicate tokens", () => {
    const dupName = VALID + `  - name: hermes\n    token: tok-aaaaaaaaaaaaaaaa\n    default_mailbox: school\n`;
    expect(() => loadConfig(writeTemp(dupName), ENV)).toThrow("duplicate");
    const dupToken = VALID + `  - name: other\n    token: \${TEST_TOKEN}\n    default_mailbox: school\n`;
    expect(() => loadConfig(writeTemp(dupToken), ENV)).toThrow("duplicate");
  });
  it("throws ConfigError for duplicate key names", () => {
    const dupName = VALID + `  - name: hermes\n    token: tok-aaaaaaaaaaaaaaaa\n    default_mailbox: school\n`;
    expect(() => loadConfig(writeTemp(dupName), ENV)).toThrow(ConfigError);
  });
  it("preserves YAML metacharacters in interpolated secrets", () => {
    const previous = process.env.MAILMCP_TEST_SECRET;
    process.env.MAILMCP_TEST_SECRET = `pa" #ss`;
    try {
      const content = `
mailboxes:
  hermes:
    backend: imap
    address: "Hermes Agent <hermes@example.test>"
    imap:
      host: localhost
      port: 3993
      secure: true
      user: hermes@example.test
      pass: \${MAILMCP_TEST_SECRET}
    smtp:
      host: localhost
      port: 3465
      secure: true
      user: hermes@example.test
      pass: \${TEST_PASS}
keys:
  - name: hermes
    token: \${TEST_TOKEN}
    default_mailbox: hermes
    grants:
      hermes: [read]
`;
      const env = { ...ENV, MAILMCP_TEST_SECRET: process.env.MAILMCP_TEST_SECRET };
      const config = loadConfig(writeTemp(content), env);
      const hermes = config.mailboxes["hermes"];
      expect(hermes?.backend).toBe("imap");
      if (hermes?.backend === "imap") expect(hermes.imap.pass).toBe(`pa" #ss`);
    } finally {
      if (previous === undefined) {
        delete process.env.MAILMCP_TEST_SECRET;
      } else {
        process.env.MAILMCP_TEST_SECRET = previous;
      }
    }
  });
});
