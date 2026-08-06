import type { Config, KeyConfig, Permission } from "./config.js";
import { PERMISSIONS } from "./config.js";
import { PermissionError } from "./errors.js";

export function findKey(config: Config, token: string): KeyConfig | null {
  return config.keys.find((key) => key.token === token) ?? null;
}

export function effectivePermissions(config: Config, key: KeyConfig, mailboxName: string): Permission[] {
  const mailbox = config.mailboxes[mailboxName];
  if (mailbox === undefined) return [];
  const merged = new Set<Permission>([...(mailbox.public ?? []), ...(key.grants?.[mailboxName] ?? [])]);
  return PERMISSIONS.filter((p) => merged.has(p));
}

export interface MailboxAccess {
  mailbox: string;
  permissions: Permission[];
  isDefault: boolean;
  address: string;
}

export function accessibleMailboxes(config: Config, key: KeyConfig): MailboxAccess[] {
  return Object.entries(config.mailboxes)
    .map(([name, mailbox]) => ({
      mailbox: name,
      permissions: effectivePermissions(config, key, name),
      isDefault: name === key.default_mailbox,
      address: mailbox.address,
    }))
    .filter((row) => row.permissions.length > 0);
}

export function requirePermission(
  config: Config,
  key: KeyConfig,
  mailboxName: string,
  permission: Permission,
): void {
  const granted = effectivePermissions(config, key, mailboxName);
  if (!granted.includes(permission)) {
    throw new PermissionError(key.name, permission, mailboxName, granted);
  }
}
