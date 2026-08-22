// 文件/工具权限档位 — 控制 agent 能做什么
// 四档：read-only / scoped / per-action / full
// 未来 fetch_url、run_shell、install_mcp_server 等"危险工具"都要先过 checkPermission

import { ipcMain, BrowserWindow } from "electron";
import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import { IPC } from "../shared/ipc-channels";

const LOG_PREFIX = "[Permission]";

export type AgentFileAccessLevel = "read-only" | "scoped" | "per-action" | "full";

export const ACCESS_LEVEL_LABEL: Record<AgentFileAccessLevel, string> = {
  "read-only": "只读",
  "scoped": "指定目录",
  "per-action": "每次审批",
  "full": "完全访问",
};

// 工具危险等级：决定该工具在哪些档位下可用
// input-control（键鼠/截屏控制）按 shell 同档处理：read-only/scoped 拒绝，per-action 审批，full 允许
export type ToolRiskLevel = "safe" | "fs-read" | "fs-write" | "shell" | "network" | "input-control";

/**
 * 默认放行（不阻塞）但仍发通知卡片让用户可阻止的工具白名单。
 * 这些工具风险较低且日常使用频繁，每次审批会打断对话流畅度。
 * 用户仍可通过点击通知卡片的"阻止"按钮来中止（但工具可能已开始执行）。
 *
 * 注意：write_file 不在此列表中，它在 checkPermission 里按路径条件判断：
 *   - 写入桌面路径 → 3 秒通知（notifyApproval）
 *   - 写入其他路径 → 60 秒审批（requestApproval）
 */
const AUTO_ALLOW_TOOL_IDS = new Set<string>([
  "weather",        // 天气查询
  "web_search",     // 联网搜索
  "fetch_url",      // 网页抓取
  "read_file",      // 读取文件
  "list_dir",       // 列出目录
  "read_image",     // 读取图片
  "delegate_task",  // 子任务委派
]);

/**
 * 判断 write_file 的目标路径是否在"安全目录"（桌面）下。
 * 桌面路径走 3 秒通知模式；其他路径走 60 秒审批。
 */
function isSafeWritePath(args: Record<string, unknown>): boolean {
  const raw = typeof args.path === "string" ? args.path.trim() : "";
  if (!raw) return false;
  try {
    const { app } = require("electron");
    const desktop = app.getPath("desktop");
    const normalized = require("path").resolve(raw);
    return normalized.startsWith(desktop + require("path").sep) || normalized === desktop;
  } catch {
    return false;
  }
}

/**
 * 给定档位 + 工具危险等级 → 返回授权策略：
 *   - "allow"       直接放行
 *   - "ask"         弹审批 UI，用户点同意才放行
 *   - "deny"        直接拒绝（agent 会收到拒绝原因）
 */
export function policyFor(level: AgentFileAccessLevel, risk: ToolRiskLevel): "allow" | "ask" | "deny" {
  // safe 工具（纯计算、纯检索本地内置数据）任何档位都允许
  if (risk === "safe") return "allow";

  switch (level) {
    case "read-only":
      return risk === "fs-read" || risk === "network" ? "allow" : "deny";
    case "scoped":
      // 当前版本没有可配置目录白名单；旧 persisted scoped 值必须 fail closed，不能退化为全盘访问。
      if (risk === "network") return "allow";
      return "deny";
    case "per-action":
      // 每次审批：除 safe 外都弹审批
      return "ask";
    case "full":
      return "allow";
  }
}

// ── 当前档位的内存缓存（main 进程持有） ───────────────────
let currentLevel: AgentFileAccessLevel = "read-only";

export function getCurrentLevel(): AgentFileAccessLevel {
  return currentLevel;
}

export function setCurrentLevel(level: AgentFileAccessLevel): void {
  if (currentLevel === level) return;
  console.log(LOG_PREFIX, "档位切换:", currentLevel, "→", level);
  currentLevel = level;
  persistLevel(level);
}

// ── 持久化 ────────────────────────────────────────────────

function getStorePath(): string {
  return path.join(app.getPath("userData"), "agent-permission.json");
}

function persistLevel(level: AgentFileAccessLevel): void {
  try {
    const filePath = getStorePath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ level }, null, 2), "utf8");
  } catch (err) {
    console.error(LOG_PREFIX, "持久化档位失败:", err);
  }
}

/**
 * 启动时从磁盘加载上次保存的档位；不存在则用默认 read-only。
 * 必须在 app.whenReady 之后调用（依赖 app.getPath）。
 */
export function initPermissionFromDisk(): void {
  try {
    const filePath = getStorePath();
    if (!fs.existsSync(filePath)) {
      console.log(LOG_PREFIX, "未找到持久化档位文件，使用默认 read-only");
      return;
    }
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8")) as { level?: unknown };
    if (isValidLevel(raw?.level)) {
      currentLevel = raw.level;
      console.log(LOG_PREFIX, "从磁盘加载档位:", currentLevel);
    } else {
      console.warn(LOG_PREFIX, "档位文件内容无效，回退默认");
    }
  } catch (err) {
    console.error(LOG_PREFIX, "加载档位失败:", err);
  }
}

// ── 审批弹窗（per-action 档位下使用） ─────────────────────
// 通过 IPC 把审批请求发到任意一个有焦点的窗口（一般是 chat 或 settings），
// 渲染端弹一个卡片，用户点同意/拒绝后回传结果。

interface PendingApproval {
  resolve: (allowed: boolean) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

const pendingApprovals = new Map<string, PendingApproval>();
let approvalCounter = 0;

export interface ApprovalRequest {
  id: string;
  toolId: string;
  toolName: string;
  toolDescription: string;
  args: Record<string, unknown>;
  risk: ToolRiskLevel;
  /** 通知模式：true=已自动放行，卡片只用于通知和可阻止；false=等待用户审批 */
  notifyOnly?: boolean;
  /** 指定审批只发送到某个窗口；缺省时保留现有广播行为。 */
  targetWebContentsId?: number;
}

/**
 * 向用户发起一次审批请求，等用户点同意/拒绝。
 * 60 秒不响应自动拒绝。
 */
export function requestApproval(request: Omit<ApprovalRequest, "id">): Promise<boolean> {
  return new Promise<boolean>((resolve, reject) => {
    const id = "approve-" + (++approvalCounter) + "-" + Date.now();
    const timer = setTimeout(() => {
      pendingApprovals.delete(id);
      console.warn(LOG_PREFIX, "审批超时（60s 未响应），自动拒绝:", request.toolId);
      resolve(false);
    }, 60_000);
    pendingApprovals.set(id, { resolve, reject, timer });

    const payload: ApprovalRequest = { id, ...request };
    console.log(LOG_PREFIX, "向渲染端发送审批请求:", id, request.toolId);

    // 广播给所有窗口（chat 窗口会优先显示卡片）
    const wins = BrowserWindow.getAllWindows().filter((win) => (
      request.targetWebContentsId === undefined || win.webContents.id === request.targetWebContentsId
    ));
    if (wins.length === 0) {
      // 没有窗口可以审批 → 直接拒绝
      clearTimeout(timer);
      pendingApprovals.delete(id);
      console.warn(LOG_PREFIX, "无窗口可审批，自动拒绝");
      resolve(false);
      return;
    }
    for (const win of wins) {
      win.webContents.send(IPC.PERMISSION_APPROVAL_REQUEST, payload);
    }
  });
}

/**
 * 通知模式审批：发通知卡片，等待 3 秒。
 * - 用户点"阻止" → 返回 false（拒绝）
 * - 3 秒超时未操作 → 返回 true（默认允许）
 * - 用户点"允许" → 立即返回 true
 */
const NOTIFY_WAIT_MS = 3000;

const pendingNotifications = new Map<string, { resolve: (allowed: boolean) => void; timer: NodeJS.Timeout }>();

export function notifyApproval(request: Omit<ApprovalRequest, "id">): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const id = "notify-" + (++approvalCounter) + "-" + Date.now();
    const payload: ApprovalRequest = { id, ...request, notifyOnly: true };
    console.log(LOG_PREFIX, "发送工具执行通知（3s 等待）:", id, request.toolId);

    const timer = setTimeout(() => {
      pendingNotifications.delete(id);
      console.log(LOG_PREFIX, "通知超时（3s），默认允许:", request.toolId);
      resolve(true);
    }, NOTIFY_WAIT_MS);
    pendingNotifications.set(id, { resolve, timer });

    const wins = BrowserWindow.getAllWindows().filter((win) => (
      request.targetWebContentsId === undefined || win.webContents.id === request.targetWebContentsId
    ));
    if (wins.length === 0) {
      clearTimeout(timer);
      pendingNotifications.delete(id);
      console.warn(LOG_PREFIX, "无窗口可通知，默认允许");
      resolve(true);
      return;
    }
    for (const win of wins) {
      win.webContents.send(IPC.PERMISSION_APPROVAL_REQUEST, payload);
    }
  });
}

// ── IPC 注册 ──────────────────────────────────────────────

export function registerPermissionIpc(): void {
  ipcMain.handle(IPC.PERMISSION_GET_LEVEL, () => {
    return { level: currentLevel };
  });

  ipcMain.handle(IPC.PERMISSION_SET_LEVEL, (_event, level: AgentFileAccessLevel) => {
    if (!isValidLevel(level)) {
      return { ok: false, error: "无效的档位: " + String(level) };
    }
    setCurrentLevel(level);
    return { ok: true, level: currentLevel };
  });

  // 渲染端审批 UI 回传结果
  ipcMain.handle(IPC.PERMISSION_APPROVAL_RESOLVE, (_event, payload: { id: string; allowed: boolean }) => {
    // 通知模式：3 秒等待中的 Promise resolve
    if (payload?.id?.startsWith("notify-")) {
      const pending = pendingNotifications.get(payload.id);
      if (pending) {
        clearTimeout(pending.timer);
        pendingNotifications.delete(payload.id);
        console.log(LOG_PREFIX, "通知结果:", payload.id, payload.allowed ? "允许" : "阻止");
        pending.resolve(Boolean(payload.allowed));
      }
      return { ok: true };
    }

    // 审批模式：等待中的 Promise resolve
    const pending = pendingApprovals.get(payload?.id);
    if (!pending) {
      console.warn(LOG_PREFIX, "审批回传未匹配到 pending:", payload?.id);
      return { ok: false };
    }
    clearTimeout(pending.timer);
    pendingApprovals.delete(payload.id);
    console.log(LOG_PREFIX, "审批结果:", payload.id, payload.allowed ? "同意" : "拒绝");
    pending.resolve(Boolean(payload.allowed));
    return { ok: true };
  });

  console.log(LOG_PREFIX, "IPC handlers 已注册");
}

function isValidLevel(value: unknown): value is AgentFileAccessLevel {
  return value === "read-only" || value === "scoped" || value === "per-action" || value === "full";
}

/**
 * 一站式权限检查：根据当前档位 + 工具危险等级，决定执行/审批/拒绝。
 * - allow → 返回 true
 * - ask   → 触发审批，等用户回应
 * - deny  → 返回 false
 *
 * 白名单工具（AUTO_ALLOW_TOOL_IDS）：即使 policy 是 ask/deny 也直接放行，
 * 但会异步发通知卡片让用户知道 AI 在干什么，用户可点"阻止"中止后续（不阻塞当前执行）。
 */
export async function checkPermission(input: {
  toolId: string;
  toolName: string;
  toolDescription: string;
  args: Record<string, unknown>;
  risk: ToolRiskLevel;
  targetWebContentsId?: number;
}): Promise<{ allowed: boolean; reason?: string }> {
  const level = currentLevel;
  const policy = policyFor(level, input.risk);
  console.log(LOG_PREFIX, "checkPermission:", input.toolId, "risk=" + input.risk, "level=" + level, "→", policy);

  // scoped 的目录白名单尚未实现，必须在所有自动放行/写入特殊分支之前拒绝文件访问。
  if (level === "scoped" && (input.risk === "fs-read" || input.risk === "fs-write")) {
    return { allowed: false, reason: "指定目录档尚未配置授权目录，已拒绝此次文件访问。" };
  }

  // 白名单工具：3 秒通知等待，超时默认允许，用户可阻止
  // write_file 特殊处理：仅桌面路径走 3 秒通知，其他路径走 60 秒审批
  const isWriteFileToDesktop = input.toolId === "write_file" && isSafeWritePath(input.args);
  if (AUTO_ALLOW_TOOL_IDS.has(input.toolId) || isWriteFileToDesktop) {
    const allowed = await notifyApproval({
      toolId: input.toolId,
      toolName: input.toolName,
      toolDescription: input.toolDescription,
      args: input.args,
      risk: input.risk,
      targetWebContentsId: input.targetWebContentsId,
    });
    if (allowed) return { allowed: true };
    return { allowed: false, reason: "用户阻止了此次操作。" };
  }

  // write_file 写非桌面路径：无论档位如何，都走 60 秒审批（不被 read-only 直接拒绝）
  if (input.toolId === "write_file" && !isWriteFileToDesktop) {
    const approved = await requestApproval({
      toolId: input.toolId,
      toolName: input.toolName,
      toolDescription: input.toolDescription,
      args: input.args,
      risk: input.risk,
      targetWebContentsId: input.targetWebContentsId,
    });
    if (approved) return { allowed: true };
    return { allowed: false, reason: "用户拒绝了此次操作。" };
  }

  if (policy === "allow") return { allowed: true };
  if (policy === "deny") {
    return {
      allowed: false,
      reason: "当前档位「" + ACCESS_LEVEL_LABEL[level] + "」不允许此操作（risk=" + input.risk + "）。请到设置 → 昔涟 → 本地文件权限提升档位。",
    };
  }
  // ask → 弹审批
  const approved = await requestApproval({
    toolId: input.toolId,
    toolName: input.toolName,
    toolDescription: input.toolDescription,
    args: input.args,
    risk: input.risk,
    targetWebContentsId: input.targetWebContentsId,
  });
  if (approved) return { allowed: true };
  return { allowed: false, reason: "用户拒绝了此次操作。" };
}
