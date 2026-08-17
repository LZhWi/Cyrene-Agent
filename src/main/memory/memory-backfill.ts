import * as fs from "fs";
import * as path from "path";
import { getUserDataDir } from "../runtime/runtime-paths";
import { getEntriesBySource, isUserMemoryVectorStoreReady } from "../rag";
import { cosineSimilarity } from "../rag/vectorstore";
import { getEmbeddingProvider, type EmbeddingProvider } from "../rag/embedding";
import { memoryJudge } from "./memory-judge";
import { memoryManager } from "./memory-manager";
import { enqueueLLMTask } from "../llm-queue";
import type { MemoryCandidate, MemoryJudgeTurn } from "./memory-types";

const LOG_PREFIX = "[Memory]";
/** 与正常提取的上下文窗口对齐（memory-scheduler MEMORY_JUDGE_CONTEXT_TURNS） */
const BATCH_SIZE = 8;
/** 与现有 user_memory 向量纯余弦 ≥ 该值视为重复，跳过写入。
 * 取 0.9：误判与漏拦的代价不对称——误判（主题相近但事实全新的候选被吞）
 * 会被水位线永久消费、无法自愈；漏拦（重跑边界重叠产生的改写型重复）
 * 只是多写一条近似条目，后续压缩器（SIMILARITY_THRESHOLD 0.85）会合并。
 * 实测边界案例："日常使用Apple Music并计划接入接口" vs "希望AI推荐歌单" ≈0.85~0.86，
 * 0.85 会误吞新事实，0.9 可放行。 */
const DEDUP_COSINE = 0.9;

export interface L2BackfillResult {
  complete: boolean;
  reason?: "already_complete" | "no_chat_history" | "rag_unavailable" | "provider_unavailable" | "batch_failed" | "error";
}

/**
 * 与现有 L2 记忆判重：对候选文本做嵌入，与 user_memory 全部向量比纯余弦。
 * 嵌入失败时返回 false 不阻塞写入（后续压缩器仍会合并近似条目）。
 */
async function isDuplicateL2(content: string, provider: EmbeddingProvider): Promise<boolean> {
  try {
    const emb = await provider.embed(content);
    return getEntriesBySource("user_memory").some((e) => cosineSimilarity(emb, e.embedding) >= DEDUP_COSINE);
  } catch {
    return false;
  }
}

// ── L2 回填提取 ──
// MemoryJudge 曾因 thinking 预算被挤占瘫痪数周（见 memory-judge maxTokens 注释），
// 期间轮次被调度器水位线当作"无值得记录"消费掉，正常流程不会重提。
// 修复后读取会话日志、按 8 轮分批重跑修好的 Judge，补写 L2。
// v4 起改为增量水位线：不再一次性跑完就永久封印，而是持久化 coveredUntilTs，
// 每次启动只重放水位线之后的轮次——后台提取再次停摆（超时/坏配置）时，
// 修复后重启即可自动补齐空窗期，无需再发新版本标记。
// - 幂等：水位线 + 去重守卫双保险；写入前与现有 user_memory 比纯余弦 ≥0.9 判重。
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
      let previouslyComplete = false;
      if (fs.existsSync(marker)) {
        try {
          const m = JSON.parse(fs.readFileSync(marker, "utf8")) as { complete?: boolean; coveredUntilTs?: number };
          previouslyComplete = m.complete === true;
          coveredUntilTs = typeof m.coveredUntilTs === "number" ? m.coveredUntilTs : 0;
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
            if (m.complete === true && typeof m.at === "number") coveredUntilTs = m.at;
          } catch { /* 旧标记损坏则从零开始，去重守卫兜底 */ }
        }
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
      let newWatermark = coveredUntilTs;
      const writeProgress = (complete: boolean) => {
        fs.writeFileSync(marker, JSON.stringify({ complete, coveredUntilTs: newWatermark, at: Date.now() }));
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
              turns.push({ userInput: pendingUser.text, assistantReply: m.content, ts });
              pendingUser = null;
            }
          }
        }
        if (pendingUser) turns.push({ userInput: pendingUser.text, assistantReply: "", ts: pendingUser.ts });

        // 只重放水位线之后的增量轮次；边界重叠由 0.9 余弦判重兜底。
        const due = turns.filter((t) => t.ts > coveredUntilTs);
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
            if (await isDuplicateL2(candidate.content, provider)) {
              skippedDup += 1;
              continue;
            }
            candidate.createdAt = batchTs;
            try {
              await memoryManager.writeMemory([candidate]);
              written += 1;
            } catch (e) {
              console.warn(LOG_PREFIX, "L2 回填单条写入失败（跳过）:", e);
            }
          }
          newWatermark = Math.max(newWatermark, batchTs);
        }
        if (sessionFailed) break; // 本轮不再继续后续会话，下次启动从水位线续跑
      }
      if (failedBatches > 0) {
        writeProgress(false);
        console.log(LOG_PREFIX, `L2 回填提取未完成：分析 ${batches} 批，写入 ${written} 条，跳过重复 ${skippedDup} 条，${failedBatches} 批失败（下次启动续跑）`);
        return { complete: false, reason: "batch_failed" };
      }
      writeProgress(true);
      if (batches === 0 && previouslyComplete) {
        return { complete: true, reason: "already_complete" };
      }
      console.log(LOG_PREFIX, `L2 回填提取完成：分析 ${batches} 批，写入 ${written} 条，跳过重复 ${skippedDup} 条`);
      return { complete: true };
    } catch (e) {
      console.warn(LOG_PREFIX, "L2 回填失败:", e);
      return { complete: false, reason: "error" };
    }
  })();
}
