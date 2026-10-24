import { app, safeStorage, type Session } from "electron";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseLearnExamPageRequest } from "../protocols/learn-exam-page-protocol";

const SNAPSHOT_VERSION = 1;
const SNAPSHOT_FILE = "browser-session.enc";

export interface BrowserSessionTabSnapshot {
  id: string;
  url: string;
  examConversationId?: string;
}

export interface BrowserSessionSnapshot {
  activeTabId: string;
  tabs: BrowserSessionTabSnapshot[];
}

interface PersistedSnapshot extends BrowserSessionSnapshot {
  version: typeof SNAPSHOT_VERSION;
  sessionCookies: Electron.Cookie[];
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string" || !value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function isExamPageUrl(value: unknown): value is string {
  return typeof value === "string" && parseLearnExamPageRequest(value)?.kind === "document";
}

export function isBrowserPanelUrl(value: unknown): value is string {
  return isHttpUrl(value) || isExamPageUrl(value);
}

function readSnapshot(value: unknown): PersistedSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<PersistedSnapshot>;
  if (candidate.version !== SNAPSHOT_VERSION || !Array.isArray(candidate.tabs) || !Array.isArray(candidate.sessionCookies)) return null;

  const ids = new Set<string>();
  const tabs = candidate.tabs.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const tab = item as Partial<BrowserSessionTabSnapshot>;
    if (typeof tab.id !== "string" || !tab.id || ids.has(tab.id)) return [];
    if (tab.url !== "" && !isHttpUrl(tab.url) && !isExamPageUrl(tab.url)) return [];
    if (isExamPageUrl(tab.url) && (typeof tab.examConversationId !== "string" || !tab.examConversationId)) return [];
    ids.add(tab.id);
    return [{ id: tab.id, url: tab.url ?? "", ...(isExamPageUrl(tab.url) ? { examConversationId: tab.examConversationId as string } : {}) }];
  }).slice(0, 50);

  const sessionCookies = candidate.sessionCookies.filter((cookie): cookie is Electron.Cookie =>
    !!cookie
    && typeof cookie === "object"
    && cookie.session === true
    && typeof cookie.name === "string"
    && typeof cookie.value === "string"
    && typeof cookie.domain === "string"
    && cookie.domain.length > 0,
  );

  return {
    version: SNAPSHOT_VERSION,
    activeTabId: typeof candidate.activeTabId === "string" && tabs.some((tab) => tab.id === candidate.activeTabId)
      ? candidate.activeTabId
      : tabs[0]?.id ?? "",
    tabs,
    sessionCookies,
  };
}

function getSnapshotPath(): string {
  return path.join(app.getPath("userData"), SNAPSHOT_FILE);
}

function canEncryptSessionSnapshot(): boolean {
  if (!safeStorage.isEncryptionAvailable()) return false;
  if (process.platform !== "linux") return true;
  try {
    return safeStorage.getSelectedStorageBackend() !== "basic_text";
  } catch {
    return false;
  }
}

function cookieUrl(cookie: Electron.Cookie): string | null {
  const host = cookie.domain?.replace(/^\.+/, "");
  if (!host || /[\s/:]/.test(host)) return null;
  return `${cookie.secure ? "https" : "http"}://${host}${cookie.path || "/"}`;
}

export class BrowserSessionPersistence {
  async restore(browserSession: Session): Promise<BrowserSessionSnapshot | null> {
    const snapshotPath = getSnapshotPath();
    if (!canEncryptSessionSnapshot()) return null;

    let snapshot: PersistedSnapshot | null;
    try {
      const encrypted = await readFile(snapshotPath);
      const decrypted = await safeStorage.decryptStringAsync(encrypted);
      snapshot = readSnapshot(JSON.parse(decrypted.result));
    } catch {
      return null;
    }
    if (!snapshot) return null;

    for (const cookie of snapshot.sessionCookies) {
      const url = cookieUrl(cookie);
      if (!url) continue;
      try {
        const details: Electron.CookiesSetDetails = {
          url,
          name: cookie.name,
          value: cookie.value,
          path: cookie.path || "/",
          secure: cookie.secure,
          httpOnly: cookie.httpOnly,
          sameSite: cookie.sameSite,
        };
        if (!cookie.hostOnly) details.domain = cookie.domain;
        await browserSession.cookies.set(details);
      } catch {
        // 一个失效 Cookie 不应阻断其它站点登录态和标签页恢复。
      }
    }

    return { activeTabId: snapshot.activeTabId, tabs: snapshot.tabs };
  }

  async save(browserSession: Session, tabs: BrowserSessionSnapshot): Promise<void> {
    const snapshotPath = getSnapshotPath();
    await browserSession.cookies.flushStore();

    if (!canEncryptSessionSnapshot()) {
      await rm(snapshotPath, { force: true });
      return;
    }

    const cookies = await browserSession.cookies.get({});
    const snapshot: PersistedSnapshot = {
      version: SNAPSHOT_VERSION,
      activeTabId: tabs.activeTabId,
      tabs: tabs.tabs,
      sessionCookies: cookies.filter((cookie) => cookie.session),
    };
    const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(snapshot));
    const temporaryPath = `${snapshotPath}.${process.pid}.tmp`;
    await mkdir(path.dirname(snapshotPath), { recursive: true });
    try {
      await writeFile(temporaryPath, encrypted);
      await rename(temporaryPath, snapshotPath);
    } finally {
      await rm(temporaryPath, { force: true });
    }
  }
}
