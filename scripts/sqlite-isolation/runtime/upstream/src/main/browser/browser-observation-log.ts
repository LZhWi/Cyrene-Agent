import fs from "node:fs/promises";
import path from "node:path";
import { app } from "electron";
import { rotateIfNeeded } from "../log-sink-file";
import type { RuntimeSnapshot } from "./playwright-page-snapshot";

const LOG_FILE_NAME = "browser-observations.jsonl";
const MAX_LOG_FILE_BYTES = 5 * 1024 * 1024;

function safePageLocation(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return `${url.origin}${url.pathname}`;
  } catch {
    return undefined;
  }
}

/** Persist selector-related detail outside the model-facing observation. */
export async function appendBrowserObservationLog(input: {
  tabId: string;
  url: string;
  snapshot: RuntimeSnapshot;
}): Promise<void> {
  try {
    const logDirectory = path.join(app.getPath("userData"), "logs");
    const logPath = path.join(logDirectory, LOG_FILE_NAME);
    await fs.mkdir(logDirectory, { recursive: true });
    rotateIfNeeded(logPath, MAX_LOG_FILE_BYTES);
    const record = {
      capturedAt: new Date().toISOString(),
      tabId: input.tabId,
      pageLocation: safePageLocation(input.url),
      totalReferences: input.snapshot.totalReferences,
      elements: input.snapshot.elements,
    };
    await fs.appendFile(logPath, `${JSON.stringify(record)}\n`, "utf8");
  } catch (error) {
    console.warn("[BrowserPanel] 写入浏览器观察记录失败", error);
  }
}
