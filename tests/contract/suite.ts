import { expect, it, afterAll, beforeAll, describe } from "vitest";
import type { Address, MailBackend } from "../../src/types.js";
import { NotFoundError } from "../../src/errors.js";

export interface BackendDescriptor {
  name: string;
  makeBackend: () => Promise<{ backend: MailBackend; cleanup: () => Promise<void> }>;
  seed: (subject: string, body: string) => Promise<void>;
  bogusId: string;
  selfAddress: Address;
}

const EMPTY = {
  replyToMessageId: null, to: null, cc: null, bcc: null,
  subject: null, body: null, attachments: null,
};

export function runMailBackendContract(descriptor: BackendDescriptor): void {
  describe(`MailBackend contract: ${descriptor.name}`, () => {
    let backend: MailBackend;
    let cleanup: () => Promise<void>;
    const marker = `suite-${descriptor.name}-${process.pid}-${Math.floor(performance.now())}`;

    beforeAll(async () => {
      ({ backend, cleanup } = await descriptor.makeBackend());
      await descriptor.seed(marker, `body of ${marker}`);
    });
    afterAll(async () => await cleanup());

    async function idOf(subject: string, folder: string | null): Promise<string> {
      const found = await backend.search({
        folder, query: null, from: null, subject,
        since: null, before: null, unreadOnly: false, limit: 5,
      });
      expect(found.length).toBeGreaterThan(0);
      return found[0]!.id;
    }

    it("lists the seeded message as unread by default, with snippet", async () => {
      const messages = await backend.listMessages({ folder: null, includeRead: false, limit: 50, offset: 0 });
      const found = messages.find((m) => m.subject === marker);
      expect(found).toBeDefined();
      expect(found?.unread).toBe(true);
      expect(found?.snippet).toContain("body of");
    });

    it("gets the full message", async () => {
      const full = await backend.getMessage(await idOf(marker, null));
      expect(full.subject).toBe(marker);
      expect(full.bodyText).toContain("body of");
      expect(full.rawHeaders.length).toBeGreaterThan(0);
    });

    it("raises the stale-id error shape for unknown ids", async () => {
      await expect(backend.getMessage(descriptor.bogusId)).rejects.toThrow(NotFoundError);
    });

    it("marks read and unread with per-id failure isolation", async () => {
      const id = await idOf(marker, null);
      const mixed = await backend.markRead([id, descriptor.bogusId]);
      expect(mixed.done.map((d) => d.id)).toEqual([id]);
      expect(mixed.failed.map((f) => f.id)).toEqual([descriptor.bogusId]);
      const unread = await backend.markUnread([id]);
      expect(unread.done).toHaveLength(1);
    });

    it("walks the full draft lifecycle: create, update via returned id, send", async () => {
      const draftId = await backend.createDraft({
        ...EMPTY, to: [descriptor.selfAddress], subject: `${marker}-draft`, body: "v1",
      });
      const updatedId = await backend.updateDraft(draftId, { ...EMPTY, body: "v2" });
      const draft = await backend.getMessage(updatedId);
      expect(draft.bodyText).toContain("v2");
      expect(draft.subject).toBe(`${marker}-draft`);
      const sent = await backend.sendDraft(updatedId);
      expect(sent.recipients.map((r) => r.address)).toContain(descriptor.selfAddress.address);
    });

    it("rejects trash as a move target and deletes to trash instead", async () => {
      const id = await idOf(marker, null);
      const rejected = await backend.move([id], "trash");
      expect(rejected.done).toEqual([]);
      expect(rejected.failed[0]?.reason).toContain("delete_message");
      const moved = await backend.move([id], "junk");
      expect(moved.failed).toEqual([]);
      expect(moved.done).toHaveLength(1);
      const junkId = moved.done[0]!.newId ?? (await idOf(marker, "junk"));
      const deleted = await backend.deleteToTrash([junkId]);
      expect(deleted.failed).toEqual([]);
      expect(deleted.done).toHaveLength(1);
    });
  });
}
