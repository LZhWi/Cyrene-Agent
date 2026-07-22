// channels/history-log —— 渠道侧每个 sender 的对话历史 (滑窗用).
//
// 每个 sessionId 对应 userData/channels/history/<sessionId>.jsonl
// 启动时把整个文件读进内存, append 时只追加. 文件按 MAX_LINES 截断防膨胀.
//
// 数据流:
//   dispatcher.handleIncoming 入站/出站 → appendHistory(senderSessionId, role, content)
//   dispatcher.handleIncoming 下一轮进 → loadRecentHistory(senderSessionId, 16) 拉最近 16 条
//
// 跟 message-log 的区别:
//   message-log 是"运营可见"的人类可读日志 (UI 显示给人看)
//   history-log 是 agent 喂的"对话上下文", LLM 需要, 机器格式
//
// 跟 RAG 索引 (indexConversationTurn) 的区别:
//   RAG 是语义检索 (cosine similarity), 长期持久
//   history-log 是精确窗口 (sliding window), 短期明确
import * as fs from "fs";
import * as path from "path";
import { getUserDataDir } from "../runtime/runtime-paths";

const LOG = "[ChannelHistory]";

/** 一条消息: 谁说的 + 内容 + 时间戳 ISO */
export interface HistoryEntry {
  role: "user" | "assistant";
  content: string;
  at: string;
}

const MAX_FILE_LINES = 200; // 最近 200 条, 远大于滑动窗口 16

function dir(): string {
  return path.join(getUserDataDir(), "channels", "history");
}

/** sessionId 可能不安全做文件名, 用 sha256 hex 兜底. dispatcher 给的已是 hash+prefix 形式也 OK. */
function safeName(sessionId: string): string {
  // dispatcher 的 sessionId 形如 "channel:feishu:e72a9d...", 替换 : 为 _ 即可
  return sessionId.replace(/[:/\\<>:"|?*]/g, "_");
}

function filePath(sessionId: string): string {
  return path.join(dir(), `${safeName(sessionId)}.jsonl`);
}

/** 追加一条. role 只能是 user/assistant (dispatcher 内部强制).
 *  返回写入的 HistoryEntry（含权威 at，用于回传给端上做跨端去重）；跳过/失败时返回 null。 */
export function appendHistory(sessionId: string, role: "user" | "assistant", content: string): HistoryEntry | null {
  if (!sessionId || !content) return null;
  const entry: HistoryEntry = { role, content, at: new Date().toISOString() };
  const fp = filePath(sessionId);
  try {
    fs.mkdirSync(dir(), { recursive: true });
    fs.appendFileSync(fp, JSON.stringify(entry) + "\n", "utf8");
    // 文件过大时截断 (只留最后 MAX_FILE_LINES 行)
    const buf = fs.readFileSync(fp, "utf8");
    const lines = buf.split("\n");
    if (lines.length > MAX_FILE_LINES + 1) {
      const trimmed = lines.slice(lines.length - MAX_FILE_LINES).join("\n");
      fs.writeFileSync(fp, trimmed.endsWith("\n") ? trimmed : trimmed + "\n", "utf8");
    }
    return entry;
  } catch (err) {
    console.warn(LOG, "appendHistory 失败:", sessionId, err instanceof Error ? err.message : err);
    return null;
  }
}

/** 读最近 N 条历史, 按时间顺序 (旧 → 新). */
export function loadRecentHistory(sessionId: string, limit: number): HistoryEntry[] {
  if (!sessionId || limit <= 0) return [];
  const fp = filePath(sessionId);
  if (!fs.existsSync(fp)) return [];
  try {
    const buf = fs.readFileSync(fp, "utf8");
    const lines = buf.split("\n").filter((l) => l.length > 0);
    const parsed: HistoryEntry[] = [];
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as HistoryEntry;
        if (e && (e.role === "user" || e.role === "assistant") && typeof e.content === "string") {
          parsed.push(e);
        }
      } catch {
        /* skip bad line */
      }
    }
    // 取尾部 limit 条
    const sliced = parsed.slice(-limit);
    return sliced;
  } catch (err) {
    console.warn(LOG, "loadRecentHistory 失败:", sessionId, err instanceof Error ? err.message : err);
    return [];
  }
}

/** 启动时所有 session 文件预读 (可选, dispatcher 用不到, 给将来 Phase 4 调试 UI 留接口). */
export function reloadAllHistory(): Map<string, HistoryEntry[]> {
  const out = new Map<string, HistoryEntry[]>();
  try {
    fs.mkdirSync(dir(), { recursive: true });
    for (const name of fs.readdirSync(dir())) {
      if (!name.endsWith(".jsonl")) continue;
      const sid = name.replace(/\.jsonl$/, "").replace(/_/g, ":");
      // 不尝试反推回原 sessionId, 这里只是占位接口, Phase 4 可优化
      out.set(sid, loadRecentHistory(sid, MAX_FILE_LINES));
    }
  } catch {
    /* ignore */
  }
  return out;
}

// ── 同步支持（sync 模块用）──
//
// 同步以"安全文件名 (stem)"为键：PC 与 RN 采用同一 safeName 规则，stem 天然是稳定的
// 跨端同步键，无需反推原 sessionId。以下函数按 stem 直接读写整份历史文件。

/** 列出所有历史会话的 stem（去掉 .jsonl 后缀的安全文件名）。 */
export function listHistoryStems(): string[] {
  try {
    fs.mkdirSync(dir(), { recursive: true });
    return fs
      .readdirSync(dir())
      .filter((name) => name.endsWith(".jsonl"))
      .map((name) => name.replace(/\.jsonl$/, ""));
  } catch (err) {
    console.warn(LOG, "listHistoryStems 失败:", err instanceof Error ? err.message : err);
    return [];
  }
}

/** 把 sessionId 转成同步用的 stem（与内部落盘文件名一致）。 */
export function stemForSession(sessionId: string): string {
  return safeName(sessionId);
}

/** 按 stem 读取整份历史（按落盘顺序，旧 → 新）。 */
export function readHistoryByStem(stem: string): HistoryEntry[] {
  const fp = path.join(dir(), `${stem}.jsonl`);
  if (!fs.existsSync(fp)) return [];
  try {
    const buf = fs.readFileSync(fp, "utf8");
    const lines = buf.split("\n").filter((l) => l.length > 0);
    const parsed: HistoryEntry[] = [];
    for (const line of lines) {
      try {
        const e = JSON.parse(line) as HistoryEntry;
        if (e && (e.role === "user" || e.role === "assistant") && typeof e.content === "string" && typeof e.at === "string") {
          parsed.push(e);
        }
      } catch {
        /* skip bad line */
      }
    }
    return parsed;
  } catch (err) {
    console.warn(LOG, "readHistoryByStem 失败:", stem, err instanceof Error ? err.message : err);
    return [];
  }
}

/**
 * 按 stem 覆盖写入整份历史（调用方负责去重/排序/截断）。
 * 用于同步合并后落盘；末尾补换行保持 JSONL 一致。
 */
export function writeHistoryByStem(stem: string, entries: HistoryEntry[]): void {
  if (!stem) return;
  const fp = path.join(dir(), `${stem}.jsonl`);
  try {
    fs.mkdirSync(dir(), { recursive: true });
    const capped = entries.length > MAX_FILE_LINES ? entries.slice(-MAX_FILE_LINES) : entries;
    const body = capped.map((e) => JSON.stringify(e)).join("\n");
    fs.writeFileSync(fp, body.length > 0 ? body + "\n" : "", "utf8");
  } catch (err) {
    console.warn(LOG, "writeHistoryByStem 失败:", stem, err instanceof Error ? err.message : err);
  }
}
