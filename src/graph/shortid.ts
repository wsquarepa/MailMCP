import { createHash } from "node:crypto";
import { InvalidInputError } from "../errors.js";

const SHORT_ID_PATTERN = /^g:([0-9a-z]+):([0-9a-f]{4})$/;

function hash4Of(nativeId: string): string {
  return createHash("sha256").update(nativeId).digest("hex").slice(0, 4);
}

export function encodeShortId(nativeId: string, timestamp: Date): string {
  const epochSeconds = Math.floor(timestamp.getTime() / 1000);
  return `g:${epochSeconds.toString(36)}:${hash4Of(nativeId)}`;
}

export function decodeShortId(shortId: string): { second: Date; hash4: string } {
  const match = SHORT_ID_PATTERN.exec(shortId);
  if (match === null) {
    throw new InvalidInputError(`'${shortId}' is not a valid graph message id (expected g:<ts>:<hash>)`);
  }
  const epochSeconds = parseInt(match[1]!, 36);
  if (Number.isNaN(epochSeconds)) {
    throw new InvalidInputError(`'${shortId}' has an unparseable timestamp component`);
  }
  return { second: new Date(epochSeconds * 1000), hash4: match[2]! };
}

export function matchesShortId(shortId: string, nativeId: string): boolean {
  return decodeShortId(shortId).hash4 === hash4Of(nativeId);
}

export function isGraphId(id: string): boolean {
  return SHORT_ID_PATTERN.test(id);
}
