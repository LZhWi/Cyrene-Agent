import * as fs from "fs";
import * as path from "path";
import { getUserDataDir } from "../runtime/runtime-paths";
import { getEntriesBySource, isUserMemoryVectorStoreReady } from "../rag";
import { getEmbeddingProvider } from "../rag/embedding";
import { memoryJudge } from "./memory-judge";
import { memoryManager } from "./memory-manager";
import { memoryStore } from "./memory-store";
import { enqueueLLMTask } from "../llm-queue";
import type { MemoryCandidate, MemoryJudgeTurn } from "./memory-types";

const LOG_PREFIX = "[Memory]";
/** 与正常提取的上下文窗口对齐（memory-scheduler MEMORY_JUDGE_CONTEXT_TURNS） */
const BATCH_SIZE = 8;
export interface L2BackfillResult {
  complete: boolean;
  reason?: "already_complete" | "no_chat_history" | "rag_unavailable" | "provider_unavailable" | "batch_failed" | "error";
}

/**
 * 回填失败重放只对“摘要文本完全相同”做幂等跳过。
 * 语义近似不在写入阶段删除：时间变化、数量变化或新增列表项的余弦可能高达 0.98，
 * 必须交给 MemoryManager 的疑似重复关系裁决。
 */
function findExactReplayL2Id(content: string): string | null {
  const normalized = content.normalize("NFC").trim();
  const hit = getEntriesBySource("user_memory").find((entry) => entry.text.normalize("NFC").trim() === normalized);
  const l2Id = hit?.metadata?.l2Id;
  return typeof l2Id === "string" && l2Id.length > 0 ? l2Id : null;
}

// ── L2 回填提取 ──
// MemoryJudge 曾因 thinking 预算被挤占瘫痪数周（见 memory-judge maxTokens 注释），
// 期间轮次被调度器水位线当作"无值得记录"消费掉，正常流程不会重提。
// 修复后读取会话日志、按 8 轮分批重跑修好的 Judge，补写 L2。
// v4 回填未完成时按会话持久化 sessionOffsets，并保留 coveredUntilTs 兼容旧标记；
// complete=true 后永久封存，不再重放正常提取成功的新轮次。当前调度器会持久化失败残余并自行重试，
// 历史聊天回填只负责修复既有空窗，避免每次启动依赖语义判重重新提取正常轮次。
// - 幂等：会话水位线 + 完全相同摘要守卫；语义近似候选不在写入阶段丢弃。
// - 时效：createdAt 用该批轮次的原始时间（批内最晚一条），面板形成时间反映真实发生时间；
//   weight 从 0 起、衰减/召回语义与正常创建完全一致。
// - 只写 L2：L0/L1 是"当前状态"层，重放旧提取会覆盖现在的字段。
// - 后台执行不阻塞启动；任一批失败即中止本轮（水位线只推到已成功批的边界，下次启动续跑）；
//   RAG 未初始化则中止且不推水位线（下次启动重试）。
export function backfillL2FromChatLogs(): Promise<L2BackfillResult> {
  return (async () => {
    try {
      const dataDir = getUserDataDir();
      const marker = path.join(dataDir, ".l2-backfill-v4");
      let coveredUntilTs = 0;
      let baselineCoveredUntilTs = 0;
      const sessionOffsets: Record<string, number> = {};
      let previouslyComplete = false;
      if (fs.existsSync(marker)) {
        try {
          const m = JSON.parse(fs.readFileSync(marker, "utf8")) as {
            complete?: boolean;
            coveredUntilTs?: number;
            baselineCoveredUntilTs?: number;
            sessionOffsets?: Record<string, number>;
          };
          previouslyComplete = m.complete === true;
          coveredUntilTs = typeof m.coveredUntilTs === "number" ? m.coveredUntilTs : 0;
          if (m.sessionOffsets && typeof m.sessionOffsets === "object") {
            for (const [sid, offset] of Object.entries(m.sessionOffsets)) {
              if (typeof offset === "number") sessionOffsets[sid] = offset;
            }
            baselineCoveredUntilTs = typeof m.baselineCoveredUntilTs === "number"
              ? m.baselineCoveredUntilTs
              : 0;
          } else {
            // 旧 v4 只有全局水位：把它冻结为迁移基线，之后新增进度按会话记录。
            baselineCoveredUntilTs = coveredUntilTs;
          }
        } catch {
          // 标记损坏视为从零开始（去重守卫保证不写重复）
        }
      } else {
        // 首次迁移：v3 是"一次性全量回填"标记，complete 说明历史已回填到它落标那一刻；
        // 用其落标时间作为水位线起点，之后只补增量。
        const v3 = path.join(dataDir, ".l2-backfill-v3");
        if (fs.existsSync(v3)) {
          try {
            const m = JSON.parse(fs.readFileSync(v3, "utf8")) as { complete?: boolean; at?: number };
            if (m.complete === true && typeof m.at === "number") {
              coveredUntilTs = m.at;
              baselineCoveredUntilTs = m.at;
              previouslyComplete = true;
            }
          } catch { /* 旧标记损坏则从零开始，去重守卫兜底 */ }
        }
      }
      if (previouslyComplete) {
        if (!fs.existsSync(marker)) {
          fs.writeFileSync(marker, JSON.stringify({
            complete: true,
            coveredUntilTs,
            baselineCoveredUntilTs,
            sessionOffsets,
            at: Date.now(),
          }));
        }
        return { complete: true, reason: "already_complete" };
      }
      const indexFile = path.join(dataDir, "cyrene-chats", "index.json");
      if (!fs.existsSync(indexFile)) return { complete: true, reason: "no_chat_history" };
      if (!isUserMemoryVectorStoreReady()) {
        console.warn(LOG_PREFIX, "L2 回填中止：RAG 未初始化");
        return { complete: false, reason: "rag_unavailable" }; // 不写标记，下次启动重试
      }
      const provider = getEmbeddingProvider();
      if (!provider) {
        console.warn(LOG_PREFIX, "L2 回填中止：嵌入 provider 不可用");
        return { complete: false, reason: "provider_unavailable" };
      }

      const sessions = JSON.parse(fs.readFileSync(indexFile, "utf8")) as Array<{ id?: string }>;
      let batches = 0;
      let written = 0;
      let skippedDup = 0;
      let failedBatches = 0;
      // 判重命中的既有条目："用户又说了一遍"也算一次召回，收尾统一刷统计，
      // 防止 aging 条目被去重拦住重述信号、长期卡在降级态。
      const recalledByDedup = new Set<string>();
      let newWatermark = coveredUntilTs;
      const writeProgress = (complete: boolean) => {
        fs.writeFileSync(marker, JSON.stringify({
          complete,
          coveredUntilTs: newWatermark,
          baselineCoveredUntilTs,
          sessionOffsets,
          at: Date.now(),
        }));
      };
      for (const session of sessions) {
        if (!session?.id) continue;
        const file = path.join(dataDir, "cyrene-chats", "sessions", `${session.id}.json`);
        if (!fs.existsSync(file)) continue;
        const data = JSON.parse(fs.readFileSync(file, "utf8")) as {
          messages?: Array<{ role?: string; content?: unknown; at?: unknown }>;
        };

        // 配对成轮次：user → 其后第一条 model/assistant
        const turns: Array<MemoryJudgeTurn & { ts: number }> = [];
        let pendingUser: { text: string; ts: number } | null = null;
        for (const m of data.messages ?? []) {
          if (typeof m.content !== "string" || !m.content.trim()) continue;
          const ts = typeof m.at === "number" ? m.at : Date.now();
          if (m.role === "user") {
            if (pendingUser) turns.push({ userInput: pendingUser.text, assistantReply: "", ts: pendingUser.ts });
            pendingUser = { text: m.content, ts };
          } else if (m.role === "model" || m.role === "assistant") {
            if (pendingUser) {
              // 轮次游标必须绑定 user 消息：若上次启动时回复尚未落盘，之后补上的
              // assistant 时间更晚；用回复时间会让同一 user 轮次在下次启动再次回填。
              turns.push({ userInput: pendingUser.text, assistantReply: m.content, ts: pendingUser.ts });
              pendingUser = null;
            }
          }
        }
        if (pendingUser) turns.push({ userInput: pendingUser.text, assistantReply: "", ts: pendingUser.ts });

        // 只重放水位线之后的增量轮次；边界重叠由 0.9 余弦判重兜底。
        const sessionOffset = sessionOffsets[session.id] ?? baselineCoveredUntilTs;
        const due = turns.filter((t) => t.ts > sessionOffset);
        if (due.length === 0) continue;

        let sessionFailed = false;
        const sid = session.id;
        const totalBatches = Math.ceil(due.length / BATCH_SIZE);
        for (let k = 0; k < totalBatches; k++) {
          const batch = due.slice(k * BATCH_SIZE, (k + 1) * BATCH_SIZE);
          const batchTs = Math.max(...batch.map((t) => t.ts));
          batches += 1;
          let candidates: MemoryCandidate[];
          try {
            // 入后台 LLM 串行队列：与聊天侧 judge/心情观察器排队，共享限流检测与
            // 5s 退避重试——回填通常在启动后前几分钟跑，若用户立刻聊天，
            // 两路并发打同一 key 会撞 RPM 限流。失败语义不变：reject 仍走下方
            // catch，水位线不推进，下次启动续跑。
            candidates = await enqueueLLMTask(`L2Backfill-${sid}-${k}`, () => memoryJudge.judgeRecentTurns(
              batch.map(({ userInput, assistantReply }) => ({ userInput, assistantReply })),
              `backfill-${sid}`,
            ));
          } catch (e) {
            console.warn(LOG_PREFIX, `L2 回填会话 ${sid} 第 ${k} 批提取失败（下次启动续跑）:`, e);
            failedBatches += 1;
            sessionFailed = true;
            break; // 水位线只推到已成功批的边界，失败批及之后留给下次启动
          }
          for (const candidate of candidates) {
            if (candidate.layer !== "L2") continue; // L0/L1 不回填，避免覆盖当前状态
            const duplicateL2Id = findExactReplayL2Id(candidate.content);
            if (duplicateL2Id) {
              skippedDup += 1;
              recalledByDedup.add(duplicateL2Id);
              continue;
            }
            candidate.createdAt = batchTs;
            try {
              await memoryManager.writeMemory([candidate]);
              written += 1;
            } catch (e) {
              console.warn(LOG_PREFIX, "L2 回填单条写入失败（下次启动重试）:", e);
              failedBatches += 1;
              sessionFailed = true;
              break;
            }
          }
          if (sessionFailed) break;
          sessionOffsets[sid] = Math.max(sessionOffsets[sid] ?? baselineCoveredUntilTs, batchTs);
          newWatermark = Math.max(newWatermark, batchTs);
        }
        if (sessionFailed) break; // 本轮不再继续后续会话，下次启动从水位线续跑
      }
      // 判重命中统一刷一次召回统计（单次 load/save）。幂等：失败续跑时同轮重放
      // 会再次命中再刷一遍，weight 有 100 上限、lastAccessedAt 只会更新不会更旧。
      if (recalledByDedup.size > 0) {
        try {
          await memoryStore.recordL2RecallsBatch([...recalledByDedup]);
        } catch (e) {
          console.warn(LOG_PREFIX, "判重命中条目召回统计刷新失败（跳过）:", e);
        }
      }
      if (failedBatches > 0) {
        writeProgress(false);
        console.log(LOG_PREFIX, `L2 回填提取未完成：分析 ${batches} 批，写入 ${written} 条，跳过重复 ${skippedDup} 条，${failedBatches} 批失败（下次启动续跑）`);
        return { complete: false, reason: "batch_failed" };
      }
      writeProgress(true);
      console.log(LOG_PREFIX, `L2 回填提取完成：分析 ${batches} 批，写入 ${written} 条，跳过重复 ${skippedDup} 条`);
      return { complete: true };
    } catch (e) {
      console.warn(LOG_PREFIX, "L2 回填失败:", e);
      return { complete: false, reason: "error" };
    }
  })();
}
