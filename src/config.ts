import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod";

export const PERMISSIONS = ["read", "draft", "send", "organize", "delete"] as const;
export type Permission = (typeof PERMISSIONS)[number];

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const permissionList = z.array(z.enum(PERMISSIONS));

const serverSchema = z.object({
  host: z.string(),
  port: z.number().int().positive(),
  secure: z.boolean(),
  user: z.string(),
  pass: z.string(),
}).strict();

const mailboxCommon = {
  address: z.string().min(3),
  surface_headers: z.array(z.string()).optional(),
  public: permissionList.optional(),
};

const mailboxSchema = z.discriminatedUnion("backend", [
  z.object({ backend: z.literal("imap"), imap: serverSchema, smtp: serverSchema, ...mailboxCommon }).strict(),
  z.object({
    backend: z.literal("graph"),
    graph: z.object({ tenant_id: z.string().min(1), client_id: z.string().min(1) }).strict(),
    ...mailboxCommon,
  }).strict(),
]);

const keySchema = z.object({
  name: z.string().min(1),
  token: z.string().min(16),
  default_mailbox: z.string(),
  grants: z.record(z.string(), permissionList).optional(),
}).strict();

const configSchema = z.object({
  mailboxes: z.record(z.string(), mailboxSchema),
  keys: z.array(keySchema).min(1),
}).strict();

export type Config = z.infer<typeof configSchema>;
export type MailboxConfig = z.infer<typeof mailboxSchema>;
export type KeyConfig = z.infer<typeof keySchema>;

export function interpolateEnv(raw: string, env: NodeJS.ProcessEnv): string {
  return raw.replace(/\$\{([A-Za-z0-9_]+)\}/g, (_match, name: string) => {
    const value = env[name];
    if (value === undefined) {
      throw new ConfigError(`Config references undefined environment variable ${name}`);
    }
    return value;
  });
}

function interpolateDeep(value: unknown, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === "string") return interpolateEnv(value, env);
  if (Array.isArray(value)) return value.map((entry: unknown): unknown => interpolateDeep(entry, env));
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]: [string, unknown]): [string, unknown] => [
        key,
        interpolateDeep(entry, env),
      ]),
    );
  }
  return value;
}

export function loadConfig(path: string, env: NodeJS.ProcessEnv): Config {
  const raw = readFileSync(path, "utf8");
  const config = configSchema.parse(interpolateDeep(parse(raw), env));
  const seenNames = new Set<string>();
  const seenTokens = new Set<string>();
  for (const key of config.keys) {
    if (seenNames.has(key.name)) throw new ConfigError(`Config: duplicate key name '${key.name}'`);
    if (seenTokens.has(key.token)) throw new ConfigError(`Config: duplicate token on key '${key.name}'`);
    seenNames.add(key.name);
    seenTokens.add(key.token);
    const defaultMailbox = config.mailboxes[key.default_mailbox];
    if (defaultMailbox === undefined) {
      throw new ConfigError(
        `Key '${key.name}': default_mailbox '${key.default_mailbox}' is not a configured mailbox`,
      );
    }
    for (const mailbox of Object.keys(key.grants ?? {})) {
      if (!(mailbox in config.mailboxes)) {
        throw new ConfigError(`Key '${key.name}': grant references unknown mailbox '${mailbox}'`);
      }
    }
    const effective = new Set([
      ...(defaultMailbox.public ?? []),
      ...(key.grants?.[key.default_mailbox] ?? []),
    ]);
    if (effective.size === 0) {
      throw new ConfigError(
        `Key '${key.name}': default mailbox '${key.default_mailbox}' grants it no permissions`,
      );
    }
  }
  return config;
}
