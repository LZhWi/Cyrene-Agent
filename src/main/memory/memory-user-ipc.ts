import { dialog, ipcMain } from "electron";
import * as fs from "fs";
import * as path from "path";
import { IPC } from "../../shared/ipc-channels";
import { getStickerManagerConfig, setStickerEnabled } from "../orchestrator/sticker-settings";
import { addUserSticker, deleteUserSticker } from "../sticker-storage";
import { loadMemoryPanelData } from "../memory/panel";
import { deleteImportedDoc } from "../rag";
import { loadUserProfile, saveUserProfile, getAvatarPath } from "../settings-store";
import { addMcpServer, removeMcpServer, listMcpServers } from "../orchestrator/mcp-manager";
import { toolRegistry } from "../orchestrator/tool-registry";
import { listSkillsForUi, setSkillEnabled } from "../skills";
import type { WindowManager } from "../windows/window-manager";
import {
  reactChatWindow,
  sidebarWindow,
  tasksWindow,
  settingsWindow,
  stickerManagerWindow,
} from "../windows/window-state";
import type { EmbeddingIndexService } from "../services/embedding/embedding-index-service";
import { memoryStore } from "../memory/memory-store";
import { exportMemoryToObsidianVault, syncToBoundVault } from "../memory/obsidian-exporter";
import { loadObsidianVaultConfig, saveObsidianVaultConfig, unbindVault } from "../memory/obsidian-vault-config";
import { startVaultWatcher, stopVaultWatcher } from "../memory/obsidian-importer";

export interface MemoryUserToolIpcDependencies {
  get windowManager(): WindowManager | null;
  embeddingIndexService: EmbeddingIndexService;
}

function broadcastToAuxWindows(channel: string, payload: unknown): void {
  for (const win of [reactChatWindow, sidebarWindow, tasksWindow, settingsWindow]) {
    if (win && !win.isDestroyed()) {
      win.webContents.send(channel, payload);
    }
  }
}

const L0_EDITABLE_KEYS = ["preferredName", "occupation", "longTermInterests", "language", "permanentNote"];
const L1_EDITABLE_KEYS = ["recentGoals", "recentPreferences", "currentProject"];

export function registerMemoryUserToolIpc(deps: MemoryUserToolIpcDependencies): void {
  const { windowManager, embeddingIndexService } = deps;

  // Sticker manager window controls
  ipcMain.handle(IPC.SETTINGS_OPEN_STICKER_MANAGER, async () => {
    console.log("[stickers] open sticker manager requested");
    return windowManager?.createStickerManagerWindow();
  });

  ipcMain.on(IPC.STICKERS_MINIMIZE, () => {
    stickerManagerWindow?.minimize();
  });

  ipcMain.on(IPC.STICKERS_CLOSE, () => {
    stickerManagerWindow?.close();
  });

  ipcMain.handle(IPC.STICKERS_GET_CONFIG, () => getStickerManagerConfig());

  ipcMain.handle(IPC.STICKERS_SET_ENABLED, (_event, payload: unknown) => {
    const record = payload as { id?: unknown; enabled?: unknown };
    const id = typeof record?.id === "string" ? record.id : null;
    if (!id) return getStickerManagerConfig();
    setStickerEnabled(id, Boolean(record.enabled));
    return getStickerManagerConfig();
  });

  ipcMain.handle(IPC.STICKERS_PICK_FILE, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }],
    });
    return result.canceled ? null : result.filePaths[0];
  });

  ipcMain.handle(IPC.STICKERS_ADD, async (_event, payload: unknown) => {
    const { sourcePath, id, description, phrases } = payload as {
      sourcePath: string;
      id: string;
      description: string;
      phrases: string[];
    };
    try {
      await addUserSticker(sourcePath, id, description, phrases);
      embeddingIndexService.invalidateStickerEmbeddingIndex();
      embeddingIndexService.refreshStickerEmbeddingIndex("user-sticker-add");
    } catch (err) {
      console.error("[stickers] add failed:", err);
      throw err;
    }
    return getStickerManagerConfig();
  });

  ipcMain.handle(IPC.STICKERS_DELETE, async (_event, id: string) => {
    try {
      await deleteUserSticker(id);
      embeddingIndexService.invalidateStickerEmbeddingIndex();
      embeddingIndexService.refreshStickerEmbeddingIndex("user-sticker-delete");
    } catch (err) {
      console.error("[stickers] delete failed:", err);
      throw err;
    }
    return getStickerManagerConfig();
  });

  ipcMain.handle(IPC.STICKERS_GET_ENABLED, () => {
    return getStickerManagerConfig().filter((s) => s.enabled);
  });

  // User avatar / profile
  ipcMain.handle(IPC.USER_GET_AVATAR, () => {
    const avatarPath = getAvatarPath();
    if (!fs.existsSync(avatarPath)) return null;
    const buf = fs.readFileSync(avatarPath);
    const ext = path.extname(avatarPath).toLowerCase();
    const mime =
      ext === ".png"
        ? "image/png"
        : ext === ".jpg" || ext === ".jpeg"
          ? "image/jpeg"
          : ext === ".webp"
            ? "image/webp"
            : "image/png";
    return "data:" + mime + ";base64," + buf.toString("base64");
  });

  // Memory panel
  ipcMain.handle(IPC.MEMORY_PANEL_GET_DATA, () => loadMemoryPanelData());

  ipcMain.handle(IPC.MEMORY_PANEL_DELETE_IMPORTED_DOC, (_event, payload: { importId: string; fileName?: string }) => {
    const deleted = deleteImportedDoc(payload.importId, payload.fileName);
    return { ok: true, deleted };
  });

  ipcMain.handle(IPC.MEMORY_PANEL_SAVE_L0, async (_event, raw: Record<string, unknown>) => {
    const patch: Partial<{
      preferredName: string;
      occupation: string;
      longTermInterests: string;
      language: string;
      permanentNote: string;
    }> = {};
    for (const key of L0_EDITABLE_KEYS) {
      if (key in raw && typeof raw[key] === "string") {
        (patch as Record<string, unknown>)[key] = (raw[key] as string).trim();
      }
    }
    await memoryStore.updateL0(patch);
    return { ok: true };
  });

  ipcMain.handle(IPC.MEMORY_PANEL_SAVE_L1, async (_event, raw: Record<string, unknown>) => {
    const patch: Partial<{
      recentGoals: string;
      recentPreferences: string;
      currentProject: string;
    }> = {};
    for (const key of L1_EDITABLE_KEYS) {
      if (key in raw && typeof raw[key] === "string") {
        (patch as Record<string, unknown>)[key] = (raw[key] as string).trim();
      }
    }
    await memoryStore.updateL1(patch);
    return { ok: true };
  });

  // ── Obsidian Vault 绑定 / 同步 / 配置 ──

  // 一次性导出（不绑定）：弹目录选择框 → 调导出器
  ipcMain.handle(IPC.MEMORY_EXPORT_OBSIDIAN_VAULT, async () => {
    const result = await dialog.showOpenDialog({
      title: "选择 Obsidian Vault 导出位置",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    return exportMemoryToObsidianVault(result.filePaths[0]);
  });

  // 绑定 vault：弹目录选择 → 保存路径 → 立即同步一次 → 启动回流监听
  ipcMain.handle(IPC.OBSIDIAN_VAULT_BIND, async () => {
    const result = await dialog.showOpenDialog({
      title: "选择要绑定的 Obsidian Vault 文件夹",
      properties: ["openDirectory", "createDirectory"],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { ok: false, canceled: true };
    }
    const vaultPath = result.filePaths[0];
    saveObsidianVaultConfig({ vaultPath });
    // 绑定后立即同步一次
    const syncResult = await syncToBoundVault();
    // 启动 Obsidian → PMRS 回流监听
    startVaultWatcher(vaultPath);
    return { ok: syncResult.ok, vaultPath, fileCount: syncResult.fileCount, error: syncResult.error };
  });

  // 解绑：先停监听再清配置
  ipcMain.handle(IPC.OBSIDIAN_VAULT_UNBIND, () => {
    stopVaultWatcher();
    unbindVault();
    return { ok: true };
  });

  // 读配置
  ipcMain.handle(IPC.OBSIDIAN_VAULT_GET_CONFIG, () => {
    return loadObsidianVaultConfig();
  });

  // 设置自动同步开关
  ipcMain.handle(IPC.OBSIDIAN_VAULT_SET_AUTO_SYNC, (_event, autoSync: boolean) => {
    const updated = saveObsidianVaultConfig({ autoSync: Boolean(autoSync) });
    return { ok: true, config: updated };
  });

  // 立即同步
  ipcMain.handle(IPC.OBSIDIAN_VAULT_SYNC_NOW, async () => {
    return syncToBoundVault();
  });

  ipcMain.handle(IPC.USER_GET_PROFILE, () => loadUserProfile());

  ipcMain.handle(IPC.USER_SAVE_PROFILE, (_event, profile: Partial<{ avatarPath?: string } & Record<string, unknown>>) => {
    const saved = saveUserProfile(profile);
    broadcastToAuxWindows(IPC.USER_PROFILE_CHANGED, saved);
    return saved;
  });

  ipcMain.handle(IPC.USER_UPLOAD_AVATAR, async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "bmp"] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const srcPath = result.filePaths[0];
    const avatarPath = getAvatarPath();
    fs.mkdirSync(path.dirname(avatarPath), { recursive: true });
    fs.copyFileSync(srcPath, avatarPath);
    const profile = saveUserProfile({ avatarPath });
    broadcastToAuxWindows(IPC.USER_AVATAR_CHANGED, null);
    return { avatarPath, profile };
  });

  // MCP servers
  ipcMain.handle(IPC.MCP_ADD_SERVER, async (_event, config: unknown) => {
    console.log("[MCP IPC] add-server:", JSON.stringify(config).slice(0, 200));
    const result = await addMcpServer(config as Parameters<typeof addMcpServer>[0]);
    console.log("[MCP IPC] add-server result:", JSON.stringify(result));
    return result;
  });

  ipcMain.handle(IPC.MCP_REMOVE_SERVER, async (_event, serverId: string) => {
    console.log("[MCP IPC] remove-server:", serverId);
    const result = await removeMcpServer(serverId);
    console.log("[MCP IPC] remove-server result:", JSON.stringify(result));
    return result;
  });

  ipcMain.handle(IPC.MCP_LIST_SERVERS, () => {
    const servers = listMcpServers();
    console.log("[MCP IPC] list-servers:", servers.length + " servers");
    return servers;
  });

  // Tool toggles
  ipcMain.handle(IPC.TOOL_SET_ENABLED, (_event, payload: unknown) => {
    const p = payload as { id?: string; enabled?: boolean };
    if (!p.id) return { ok: false, error: "missing tool id" };
    toolRegistry.setEnabled(p.id, p.enabled !== false);
    console.log("[Tool] " + p.id + " enabled=" + (p.enabled !== false));
    return { ok: true };
  });

  ipcMain.handle(IPC.TOOL_GET_ENABLED, () => {
    const tools = toolRegistry.getAllTools();
    const result: Record<string, boolean> = {};
    for (const t of tools) {
      result[t.id] = t.enabled;
    }
    return result;
  });

  // Skill toggles
  ipcMain.handle(IPC.SKILL_LIST, () => listSkillsForUi());

  ipcMain.handle(IPC.SKILL_SET_ENABLED, (_event, payload: unknown) => {
    const p = payload as { id?: string; enabled?: boolean };
    if (!p.id) return { ok: false, error: "missing skill id" };
    setSkillEnabled(p.id, p.enabled !== false);
    console.log("[Skill] " + p.id + " enabled=" + (p.enabled !== false));
    return { ok: true };
  });

  // 启动时：若已绑定 vault，恢复 Obsidian → PMRS 回流监听
  const existingConfig = loadObsidianVaultConfig();
  if (existingConfig.vaultPath) {
    startVaultWatcher(existingConfig.vaultPath);
  }
}
