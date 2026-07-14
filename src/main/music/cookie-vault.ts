import { safeStorage } from "electron";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { EncryptedAccountBlob } from "./types";

export interface PersistPayload {
  cookies: Record<string, string>;
  revision: number;
}

const FORMAT_VERSION = 1 as const;
const PROVIDER = "netease-cloud-music" as const;
const FILENAME = "account.enc";

export class CookieVault {
  constructor(
    private readonly userDataMusicDir: string,
    private readonly storage: Pick<typeof safeStorage, "isEncryptionAvailable" | "encryptString" | "decryptString"> = safeStorage,
  ) {}

  private get accountPath(): string {
    return path.join(this.userDataMusicDir, FILENAME);
  }

  async persist(payload: PersistPayload): Promise<boolean> {
    if (!this.storage.isEncryptionAvailable()) {
      return false;
    }
    const blob: EncryptedAccountBlob = {
      formatVersion: FORMAT_VERSION,
      provider: PROVIDER,
      savedAt: Date.now(),
      credentialRevision: payload.revision,
      payload: this.storage.encryptString(JSON.stringify({ cookies: payload.cookies })),
    };
    await fs.mkdir(this.userDataMusicDir, { recursive: true });
    const tmp = this.accountPath + ".tmp";
    await fs.writeFile(tmp, this._serialize(blob));
    await fs.rename(tmp, this.accountPath);
    return true;
  }

  async load(): Promise<EncryptedAccountBlob | null> {
    let raw: Buffer;
    try {
      raw = await fs.readFile(this.accountPath);
    } catch (e: unknown) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new Error(`E_ACCOUNT_BLOB_UNREADABLE: ${(e as Error).message}`);
    }
    let parsed: EncryptedAccountBlob;
    try {
      parsed = this._deserialize(raw);
    } catch (e: unknown) {
      throw new Error(`E_ACCOUNT_BLOB_UNREADABLE: ${(e as Error).message}`);
    }
    if (parsed.formatVersion !== FORMAT_VERSION) {
      throw new Error(`E_ACCOUNT_BLOB_UNREADABLE: formatVersion=${parsed.formatVersion}`);
    }
    if (parsed.provider !== PROVIDER) {
      throw new Error(`E_ACCOUNT_BLOB_UNREADABLE: provider=${parsed.provider}`);
    }
    return parsed;
  }

  async decrypt(blob: EncryptedAccountBlob): Promise<PersistPayload> {
    const json = this.storage.decryptString(blob.payload);
    const data = JSON.parse(json) as { cookies: Record<string, string> };
    return { cookies: data.cookies, revision: blob.credentialRevision };
  }

  private _serialize(blob: EncryptedAccountBlob): Buffer {
    return Buffer.from(JSON.stringify({
      formatVersion: blob.formatVersion,
      provider: blob.provider,
      savedAt: blob.savedAt,
      credentialRevision: blob.credentialRevision,
      payloadB64: blob.payload.toString("base64"),
    }));
  }

  private _deserialize(raw: Buffer): EncryptedAccountBlob {
    const obj = JSON.parse(raw.toString("utf8")) as {
      formatVersion: number;
      provider: string;
      savedAt: number;
      credentialRevision: number;
      payloadB64: string;
    };
    return {
      formatVersion: obj.formatVersion as 1,
      provider: obj.provider as "netease-cloud-music",
      savedAt: obj.savedAt,
      credentialRevision: obj.credentialRevision,
      payload: Buffer.from(obj.payloadB64, "base64"),
    };
  }
}
