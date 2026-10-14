import { app, BrowserWindow, net, session } from "electron";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { registerExamPageSource } from "./exam-page-authority";
import { parseLearnExamPageRequest, resolveLearnExamPageAsset } from "../protocols/learn-exam-page-protocol";

const windows = new Map<string, BrowserWindow>();

/** Separate, nonpersistent browser session; never receives the general application preload. */
export async function openExamWindow(examId: string, conversationId: string, owner: BrowserWindow): Promise<void> {
  const url = `cyrene-exam://paper/${examId}`;
  if (parseLearnExamPageRequest(url)?.kind !== "document") throw new Error("E_LEARN_EXAM_INVALID_ID");
  const existing = windows.get(examId);
  if (existing && !existing.isDestroyed()) { existing.show(); existing.focus(); return; }
  const rendererRoot = path.join(app.getAppPath(), "dist", "renderer");
  const isolated = session.fromPartition(`cyrene-exam-${examId}`);
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  isolated.setPermissionCheckHandler(() => false);
  isolated.on("will-download", (event) => event.preventDefault());
  if (!(await isolated.protocol.isProtocolHandled("cyrene-exam"))) {
    await isolated.protocol.handle("cyrene-exam", async (request) => {
      const parsed = parseLearnExamPageRequest(request.url);
      const file = parsed?.kind === "document" && parsed.examId === examId
        ? path.join(rendererRoot, "learn-exam.html")
        : parsed?.kind === "asset" ? resolveLearnExamPageAsset(rendererRoot, parsed.relativePath) : null;
      if (!file) return new Response("Forbidden", { status: 403 });
      return net.fetch(pathToFileURL(file).toString());
    });
  }
  const window = new BrowserWindow({ parent: owner, width: 1000, height: 780, show: false,
    title: "学习试卷", webPreferences: { session: isolated, contextIsolation: true, sandbox: true,
      nodeIntegration: false, preload: path.join(app.getAppPath(), "dist", "preload", "preload", "learn-exam-page.js") } });
  windows.set(examId, window);
  const revoke = registerExamPageSource(window.webContents, examId, conversationId);
  window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  window.webContents.on("will-navigate", (event, target) => { if (target !== url) event.preventDefault(); });
  const closeWithOwner = () => { if (!window.isDestroyed()) window.destroy(); };
  owner.once("closed", closeWithOwner);
  window.once("closed", () => { revoke(); windows.delete(examId); owner.removeListener("closed", closeWithOwner); });
  try { await window.loadURL(url); window.show(); }
  catch (error) { closeWithOwner(); throw error; }
}
