// 历史对话召回工具 —— 让昔涟能"回忆"滚出上下文窗口的对话。
//
// 设计（见 docs/history-and-skill-architecture.md）：
// - 不切分、不压缩、不启发式。全部历史无损存入向量库，模型主动召回。
// - 存：每轮 user + assistant 消息用 addHistoryMemory 存入 source="chat_history"
// - 取：recall_history 工具语义检索，按时间排序返回
//
// 复用现有 RAG 引擎（addHistoryMemory / searchHistoryEntries），不另建存储层。

import * as fs from "fs";
import * as path from "path";
import {
  addHistoryMemory,
  deleteHistoryEntriesBySessionId,
  getEntriesBySource,
  searchHistoryEntries,
} from "../rag";
import { getUserDataDir } from "../runtime/runtime-paths";
import { toolRegistry } from "./tool-registry";

const LOG_PREFIX = "[History]";

/**
 * 把一轮对话存入向量库。在 agui-bridge 的 complete 回调里调用。
 * user 和 assistant 各存一条，方便按角色召回。
 * 每次出现写入 metadata.occurrences，供单轮删除时只移除对应位置。
 * 失败不抛错（历史存储是副作用，不能影响主流程）。
 */
export async function indexConversationTurn(
  sessionId: string,
  userText: string,
  assistantText: string,
  turnIds?: { userTurnId?: string; assistantTurnId?: string },
): Promise<void> {
  const ts = Date.now();
  try {
    if (userText) {
      await addHistoryMemory(userText, { sessionId, role: "user", ts, turnId: turnIds?.userTurnId });
    }
    if (assistantText) {
      await addHistoryMemory(assistantText, { sessionId, role: "assistant", ts, turnId: turnIds?.assistantTurnId });
    }
  } catch (e) {
    console.warn(LOG_PREFIX, "索引对话失败:", e);
  }
}

/** 注册 recall_history 工具。在 startup 调一次。 */
export function registerRecallHistoryTool(): void {
  toolRegistry.register({
    id: "recall_history",
    name: "回忆历史",
    description:
      "从所有历史对话中语义检索相关内容。返回按时间排序的相关片段（最多 5 条），每条带角色和时间戳。\n\n" +
      "何时用：\n" +
      "- 用户说「还记得」「上次」「之前」「那个」「前几天」等指代词\n" +
      "- 用户问的事在最近几轮对话里找不到答案\n" +
      "- 用户接续之前的话题但当前上下文没有细节\n\n" +
      "不要用于：\n" +
      "- 当前对话最近几轮里能直接看到的信息\n" +
      "- 完全无关的闲聊\n" +
      "- 用户从没提过的事（查不到就老实说不知道）\n\n" +
      "参数：query（必填，检索关键词或自然语言问题），days（可选，限制最近 N 天，默认 90）。",
    enabled: true,
    risk: "safe",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索关键词或自然语言问题" },
        days: { type: "number", description: "可选，限制最近 N 天，默认 30" },
      },
      required: ["query"],
    },
    execute: async (args) => {
      const query = String(args.query || "").trim();
      if (!query) return "[错误] query 不能为空";

      const days = Number(args.days) || 90;
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

      let hits;
      try {
        hits = await searchHistoryEntries(query, 5);
      } catch (e) {
        return "[recall_history] 检索失败：" + (e instanceof Error ? e.message : String(e));
      }

      const filtered = hits.filter(h => h.createdAt >= cutoff);

      if (filtered.length === 0) {
        return `[recall_history] 没有找到关于 "${query}" 的历史记录`;
      }

      // 按时间正序（最早的在前），让对话脉络自然
      const sorted = [...filtered].sort((a, b) => a.createdAt - b.createdAt);

      const lines = sorted.map(h => {
        const date = new Date(h.createdAt).toLocaleString("zh-CN");
        const role = h.metadata?.role === "user" ? "用户" : "昔涟";
        // 截断过长内容，避免吃太多 token
        const text = h.text.length > 300 ? h.text.slice(0, 300) + "..." : h.text;
        return `[${date}] ${role}：${text}`;
      });

      return `[recall_history] 找到 ${sorted.length} 条相关历史：\n\n${lines.join("\n\n")}`;
    },
  });
}

// ── 历史回填 ──
// 索引曾因去重评分膨胀静默停摆数周（见 vectorstore.add 的 rawScore 注释），
// 修复后把 cyrene-chats 会话日志一次性补进 chat_history 索引，恢复 recall_history 对旧对话的召回。
// - 幂等：v2 标记文件防重跑；即便重跑，相同 occurrence 也不会重复写入。
// - 时效：createdAt 保留消息原始时间（展示与时间排序用），lastRecalledAt 为回填时刻（初期不被衰减压低）。
// - 后台执行不阻塞启动；单条失败跳过，RAG 未初始化则中止且不写标记（下次启动重试）。
interface HistoryBackfillProgress {
  complete: boolean;
  doneSessions: string[];
  sessionOffsets: Record<string, number>;
  indexed: number;
  at: number;
}

function readBackfillProgress(marker: string): HistoryBackfillProgress {
  try {
    const parsed = JSON.parse(fs.readFileSync(marker, "utf8")) as Partial<HistoryBackfillProgress>;
    return {
      complete: parsed.complete === true,
      doneSessions: Array.isArray(parsed.doneSessions)
        ? parsed.doneSessions.filter((id): id is string => typeof id === "string")
        : [],
      sessionOffsets: parsed.sessionOffsets && typeof parsed.sessionOffsets === "object"
        ? parsed.sessionOffsets as Record<string, number>
        : {},
      indexed: typeof parsed.indexed === "number" ? parsed.indexed : 0,
      at: typeof parsed.at === "number" ? parsed.at : 0,
    };
  } catch {
    return { complete: false, doneSessions: [], sessionOffsets: {}, indexed: 0, at: 0 };
  }
}

function writeBackfillProgress(marker: string, progress: HistoryBackfillProgress): void {
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify(progress), "utf8");
}

export async function backfillChatHistoryFromChatLogs(): Promise<void> {
  try {
      const dataDir = getUserDataDir();
      const marker = path.join(dataDir, "rag-data", ".history-occurrences-backfill-v2");
      const indexFile = path.join(dataDir, "cyrene-chats", "index.json");
      if (!fs.existsSync(indexFile)) return;

      const sessions = JSON.parse(fs.readFileSync(indexFile, "utf8")) as Array<{ id?: string }>;
      const sessionIds = sessions.flatMap((session) => typeof session?.id === "string" ? [session.id] : []);
      let progress = fs.existsSync(marker)
        ? readBackfillProgress(marker)
        : { complete: false, doneSessions: [], sessionOffsets: {}, indexed: 0, at: 0 };
      if (progress.complete && sessionIds.length > 0 && getEntriesBySource("chat_history").length === 0) {
        progress = { complete: false, doneSessions: [], sessionOffsets: {}, indexed: 0, at: 0 };
      }
      if (progress.complete) return;

      const doneSessions = new Set(progress.doneSessions);
      let indexed = progress.indexed;
      for (const session of sessions) {
        if (!session?.id || doneSessions.has(session.id)) continue;
        const file = path.join(dataDir, "cyrene-chats", "sessions", `${session.id}.json`);
        if (!fs.existsSync(file)) {
          doneSessions.add(session.id);
          continue;
        }
        const data = JSON.parse(fs.readFileSync(file, "utf8")) as {
          messages?: Array<{ id?: unknown; role?: string; content?: unknown; at?: unknown }>;
        };
        const fileMtime = fs.statSync(file).mtimeMs;
        let sessionFailed = false;
        for (const [messageIndex, m] of (data.messages ?? []).entries()) {
          if (messageIndex <= (progress.sessionOffsets[session.id] ?? -1)) continue;
          if (typeof m.content !== "string" || !m.content.trim()) {
            progress.sessionOffsets[session.id] = messageIndex;
            continue;
          }
          const role = m.role === "user" ? "user" : m.role === "model" || m.role === "assistant" ? "assistant" : null;
          if (!role) {
            progress.sessionOffsets[session.id] = messageIndex;
            continue;
          }
          const ts = typeof m.at === "number" ? m.at : undefined;
          const occurrenceTs = ts ?? fileMtime + messageIndex;
          const turnId = typeof m.id === "string" && m.id
            ? m.id
            : `backfill:${session.id}:${messageIndex}`;
          try {
            await addHistoryMemory(
              m.content,
              {
                sessionId: session.id,
                role,
                ts: occurrenceTs,
                turnId,
              },
              ts !== undefined ? { createdAt: ts } : undefined,
            );
            if (!fs.existsSync(file)) {
              deleteHistoryEntriesBySessionId(session.id);
              doneSessions.add(session.id);
              break;
            }
            indexed++;
            progress.sessionOffsets[session.id] = messageIndex;
            writeBackfillProgress(marker, {
              ...progress,
              complete: false,
              doneSessions: [...doneSessions],
              indexed,
              at: Date.now(),
            });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.includes("RAG not initialized")) {
              console.warn(LOG_PREFIX, "回填中止：RAG 未初始化");
              return; // 不写标记，下次启动重试
            }
            sessionFailed = true;
            console.warn(LOG_PREFIX, `会话 ${session.id} 回填失败，将在下次启动重试:`, msg);
            break;
            // 单条失败（如嵌入异常）跳过，不中断整体回填
          }
        }
        if (!sessionFailed) doneSessions.add(session.id);
        writeBackfillProgress(marker, {
          ...progress,
          complete: false,
          doneSessions: [...doneSessions],
          indexed,
          at: Date.now(),
        });
      }
      const complete = sessionIds.every((id) => doneSessions.has(id));
      writeBackfillProgress(marker, {
        ...progress,
        complete,
        doneSessions: [...doneSessions],
        indexed,
        at: Date.now(),
      });
      if (complete) {
        console.log(LOG_PREFIX, `历史回填完成：${indexed} 条`);
      } else {
        console.warn(LOG_PREFIX, "历史回填未完成，失败位置将在下次启动继续");
      }
  } catch (e) {
    console.warn(LOG_PREFIX, "历史回填失败:", e);
  }
}
