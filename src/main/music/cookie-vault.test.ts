import { describe, it, expect, beforeEach, vi } from "vitest";
import { CookieVault } from "./cookie-vault";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

vi.mock("electron", () => ({
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`)),
    decryptString: vi.fn((b: Buffer) => b.toString("utf8").replace(/^enc:/, "")),
  },
}));

const safeStorageMock = {
  isEncryptionAvailable: vi.fn(() => true),
  encryptString: vi.fn((s: string) => Buffer.from(`enc:${s}`)),
  decryptString: vi.fn((b: Buffer) => b.toString("utf8").replace(/^enc:/, "")),
};

let dir = "";
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "music-vault-"));
});

describe("CookieVault", () => {
  it("writes and reads back a blob atomically", async () => {
    const v = new CookieVault(dir, safeStorageMock as never);
    const ok = await v.persist({ cookies: { MUSIC_U: "u" }, revision: 1 });
    expect(ok).toBe(true);
    const blob = await v.load();
    expect(blob?.formatVersion).toBe(1);
    expect(blob?.provider).toBe("netease-cloud-music");
    expect(blob?.credentialRevision).toBe(1);
    const restored = await v.decrypt(blob!);
    expect(restored.cookies.MUSIC_U).toBe("u");
  });

  it("returns null when no account file exists", async () => {
    const v = new CookieVault(dir, safeStorageMock as never);
    expect(await v.load()).toBeNull();
  });

  it("returns E_ACCOUNT_BLOB_UNREADABLE for unsupported version", async () => {
    const accountPath = path.join(dir, "account.enc");
    await fs.writeFile(accountPath, JSON.stringify({ formatVersion: 99, provider: "x" }));
    const v = new CookieVault(dir, safeStorageMock as never);
    await expect(v.load()).rejects.toThrow(/E_ACCOUNT_BLOB_UNREADABLE/);
  });

  it("falls back to no-persist when safeStorage unavailable", async () => {
    const noSafe = { ...safeStorageMock, isEncryptionAvailable: () => false };
    const v = new CookieVault(dir, noSafe as never);
    const ok = await v.persist({ cookies: {}, revision: 1 });
    expect(ok).toBe(false);
    const exists = await fs.stat(path.join(dir, "account.enc")).then(() => true, () => false);
    expect(exists).toBe(false);
  });

  describe("delete()", () => {
    it("is a no-op when the account file does not exist", async () => {
      const v = new CookieVault(dir, safeStorageMock as never);
      // Should not throw even though there is nothing to remove.
      await expect(v.delete()).resolves.toBeUndefined();
      // And load() should still report null.
      expect(await v.load()).toBeNull();
    });

    it("removes an existing account file", async () => {
      const v = new CookieVault(dir, safeStorageMock as never);
      const ok = await v.persist({ cookies: { MUSIC_U: "u" }, revision: 1 });
      expect(ok).toBe(true);
      const accountPath = path.join(dir, "account.enc");
      // Sanity check: file is on disk before delete.
      await expect(fs.stat(accountPath)).resolves.toBeDefined();

      await v.delete();

      // File should be gone.
      await expect(fs.stat(accountPath)).rejects.toThrow(/ENOENT/);
      // And load() should return null afterwards.
      expect(await v.load()).toBeNull();
    });

    it("after delete, a subsequent persist + load cycle works cleanly", async () => {
      const v = new CookieVault(dir, safeStorageMock as never);
      await v.persist({ cookies: { MUSIC_U: "first" }, revision: 1 });
      await v.delete();
      // After delete, a fresh persist should still succeed and overwrite cleanly.
      await v.persist({ cookies: { MUSIC_U: "second" }, revision: 2 });
      const blob = await v.load();
      expect(blob?.credentialRevision).toBe(2);
    });
  });
});
