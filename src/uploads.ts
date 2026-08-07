import { randomBytes } from "node:crypto";

export const UPLOAD_MAX_BYTES = 3 * 1024 * 1024;
export const UPLOAD_TTL_MS = 30 * 60 * 1000;
export const UPLOAD_QUOTA_BYTES = 30 * 1024 * 1024;

export class UploadQuotaError extends Error {
  constructor(keyName: string, liveBytes: number) {
    super(
      `Key '${keyName}' has ${liveBytes} bytes of staged uploads, over the ${UPLOAD_QUOTA_BYTES} byte quota. ` +
      `Staged uploads expire ${UPLOAD_TTL_MS / 60_000} minutes after creation; wait for expiry or stage smaller files.`,
    );
  }
}

export interface UploadReceipt {
  uploadId: string;
  size: number;
  expiresAt: Date;
}

interface StagedUpload {
  keyName: string;
  bytes: Buffer;
  expiresAtMs: number;
}

// Deliberate simplification: in-memory only, so staged uploads die on restart.
// Acceptable for a stage-then-reference flow measured in seconds; the upgrade
// path is a disk-backed store behind the same put/get interface.
export class UploadStore {
  private readonly entries = new Map<string, StagedUpload>();

  private prune(nowMs: number): void {
    for (const [id, entry] of this.entries) {
      if (entry.expiresAtMs <= nowMs) this.entries.delete(id);
    }
  }

  private liveBytes(keyName: string): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      if (entry.keyName === keyName) total += entry.bytes.length;
    }
    return total;
  }

  put(keyName: string, bytes: Buffer, nowMs: number): UploadReceipt {
    this.prune(nowMs);
    const live = this.liveBytes(keyName);
    if (live + bytes.length > UPLOAD_QUOTA_BYTES) throw new UploadQuotaError(keyName, live);
    const uploadId = randomBytes(16).toString("hex");
    const expiresAtMs = nowMs + UPLOAD_TTL_MS;
    this.entries.set(uploadId, { keyName, bytes, expiresAtMs });
    return { uploadId, size: bytes.length, expiresAt: new Date(expiresAtMs) };
  }

  get(keyName: string, uploadId: string, nowMs: number): Buffer | null {
    this.prune(nowMs);
    const entry = this.entries.get(uploadId);
    if (entry === undefined || entry.keyName !== keyName) return null;
    return entry.bytes;
  }
}
