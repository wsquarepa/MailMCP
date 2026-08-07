import { describe, expect, it } from "vitest";
import {
  UPLOAD_QUOTA_BYTES, UPLOAD_TTL_MS, UploadQuotaError, UploadStore,
} from "../../src/uploads.js";

const T0 = 1_754_500_000_000;

describe("UploadStore", () => {
  it("stages bytes and returns them to the owning key until expiry", () => {
    const store = new UploadStore();
    const receipt = store.put("alpha", Buffer.from("payload"), T0);
    expect(receipt.size).toBe(7);
    expect(receipt.expiresAt.getTime()).toBe(T0 + UPLOAD_TTL_MS);
    expect(store.get("alpha", receipt.uploadId, T0 + 1)?.toString("utf8")).toBe("payload");
    expect(store.get("alpha", receipt.uploadId, T0 + 2)?.toString("utf8")).toBe("payload"); // reusable
    expect(store.get("alpha", receipt.uploadId, T0 + UPLOAD_TTL_MS)).toBeNull();            // expired
  });

  it("scopes uploads to the key that created them", () => {
    const store = new UploadStore();
    const receipt = store.put("alpha", Buffer.from("secret"), T0);
    expect(store.get("bravo", receipt.uploadId, T0 + 1)).toBeNull();
    expect(store.get("alpha", "0000000000000000", T0 + 1)).toBeNull();
  });

  it("issues distinct unguessable ids", () => {
    const store = new UploadStore();
    const a = store.put("alpha", Buffer.from("x"), T0);
    const b = store.put("alpha", Buffer.from("y"), T0);
    expect(a.uploadId).not.toBe(b.uploadId);
    expect(a.uploadId).toMatch(/^[0-9a-f]{32}$/);
  });

  it("enforces the per-key quota over live bytes and frees it on expiry", () => {
    const store = new UploadStore();
    const chunk = Buffer.alloc(10 * 1024 * 1024);
    store.put("alpha", chunk, T0);
    store.put("alpha", chunk, T0);
    store.put("alpha", chunk, T0);                                    // exactly at 30 MB
    expect(() => store.put("alpha", Buffer.from("x"), T0)).toThrow(UploadQuotaError);
    expect(() => store.put("alpha", Buffer.from("x"), T0)).toThrow(String(UPLOAD_QUOTA_BYTES));
    store.put("bravo", chunk, T0);                                    // other keys unaffected
    const later = store.put("alpha", chunk, T0 + UPLOAD_TTL_MS);      // expiry freed the quota
    expect(store.get("alpha", later.uploadId, T0 + UPLOAD_TTL_MS + 1)).not.toBeNull();
  });
});
