import * as fs from "fs";
import * as path from "path";
import { getUserDataDir } from "../runtime/runtime-paths";
import { getEntriesBySource, isUserMemoryVectorStoreReady } from "../rag";
import { cosineSimilarity } from "../rag/vectorstore";
import { getEmbeddingProvider, type EmbeddingProvider } from "../rag/embedding";
import { memoryJudge } from "./memory-judge";
import { memoryManager } from "./memory-manager";
import type { MemoryCandidate, MemoryJudgeTurn } from "./memory-types";

const LOG_PREFIX = "[Memory]";
/** 与正常提取的上下文窗口对齐（memory-scheduler MEMORY_JUDGE_CONTEXT_TURNS） */
const BATCH_SIZE = 8;
/** 与现有 user_memory 向量纯余弦 ≥ 该值视为重复，跳过写入。
 * 取 0.85（与压缩器聚类阈值一致）：回填存在整会话重跑场景，Judge 措辞不可复现，
 * 重跑产出的改写表述与已有条目余弦常在 0.85~0.9 之间，0.9 会漏拦。 */
const DEDUP_COSINE = 0.85;

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
// 修复后一次性读取会话日志、按 8 轮分批重跑修好的 Judge，补写 L2。
// - 幂等：标记文件防重跑；完成前标记存断点（doneSessions + 批次级 doneBatches），单批失败从该批续跑，已成功批不重跑。
// - 去重：写入前与现有 user_memory 比纯余弦（writeL2 本身无去重，只有冲突检测）。
// - 时效：createdAt 用该批轮次的原始时间（批内最晚一条），面板形成时间反映真实发生时间；
//   weight 从 0 起、衰减/召回语义与正常创建完全一致。
// - 只写 L2：L0/L1 是"当前状态"层，重放旧提取会覆盖现在的字段。
// - 后台执行不阻塞启动；单批失败会中断该会话并从该批续跑（批次级断点，避免重跑产出改写近重复）；RAG 未初始化则中止且不写标记（下次启动重试）。
export function backfillL2FromChatLogs(): Promise<void> {
  return (async () => {
    try {
      const dataDir = getUserDataDir();
      const marker = path.join(dataDir, ".l2-backfill-v3");
      // v3 断点批次级：doneBatches 记录每个会话已连续成功的批数，续跑直接跳到失败批。
      // v2 会话级断点会让单批失败的会话整体重跑，而 Judge 措辞不可复现，
      // 重跑产出的改写近重复会溜过 0.9 判重。v2 的 doneSessions 干净（仅整会话成功才写），迁移继承。
      let doneSessions: string[] = [];
      let doneBatches: Record<string, number> = {};
      if (fs.existsSync(marker)) {
        try {
          const m = JSON.parse(fs.readFileSync(marker, "utf8")) as { complete?: boolean; doneSessions?: string[]; doneBatches?: Record<string, number> };
          if (m.complete === true) return;
          doneSessions = Array.isArray(m.doneSessions) ? m.doneSessions : [];
          doneBatches = m.doneBatches && typeof m.doneBatches === "object" ? m.doneBatches : {};
        } catch {
          // 标记损坏视为从头开始（去重守卫保证不写重复）
        }
      } else {
        const v2 = path.join(dataDir, ".l2-backfill-v2");
        if (fs.existsSync(v2)) {
          try {
            const m = JSON.parse(fs.readFileSync(v2, "utf8")) as { complete?: boolean; doneSessions?: string[] };
            // v2 的 doneSessions 只在整会话全部批次成功后才写入，是干净的，全部继承。
            // 未完成的会话无批次级状态，v3 下从第 0 批续跑（仅此一次），去重守卫兜底。
            doneSessions = Array.isArray(m.doneSessions) ? m.doneSessions : [];
          } catch { /* 旧标记损坏则忽略 */ }
        }
      }
      const done = new Set(doneSessions);
      const indexFile = path.join(dataDir, "cyrene-chats", "index.json");
      if (!fs.existsSync(indexFile)) return;
      if (!isUserMemoryVectorStoreReady()) {
        console.warn(LOG_PREFIX, "L2 回填中止：RAG 未初始化");
        return; // 不写标记，下次启动重试
      }
      const provider = getEmbeddingProvider();
      if (!provider) {
        console.warn(LOG_PREFIX, "L2 回填中止：嵌入 provider 不可用");
        return;
      }

      const sessions = JSON.parse(fs.readFileSync(indexFile, "utf8")) as Array<{ id?: string }>;
      let batches = 0;
      let written = 0;
      let skippedDup = 0;
      let failedBatches = 0;
      const writeProgress = () => {
        fs.writeFileSync(marker, JSON.stringify({ complete: false, doneSessions: [...done], doneBatches, at: Date.now() }));
      };
      for (const session of sessions) {
        if (!session?.id || done.has(session.id)) continue;
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

        let sessionFailed = false;
        const sid = session.id;
        const totalBatches = Math.ceil(turns.length / BATCH_SIZE);
        for (let k = doneBatches[sid] ?? 0; k < totalBatches; k++) {
          const batch = turns.slice(k * BATCH_SIZE, (k + 1) * BATCH_SIZE);
          const batchTs = Math.max(...batch.map((t) => t.ts));
          batches += 1;
          let candidates: MemoryCandidate[];
          try {
            candidates = await memoryJudge.judgeRecentTurns(
              batch.map(({ userInput, assistantReply }) => ({ userInput, assistantReply })),
              `backfill-${sid}`,
            );
          } catch (e) {
            console.warn(LOG_PREFIX, `L2 回填会话 ${sid} 第 ${k} 批提取失败（下次启动从该批续跑）:`, e);
            failedBatches += 1;
            sessionFailed = true;
            break; // 批次级断点：不往后推进，该批及之后留给下次启动
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
          doneBatches[sid] = k + 1;
          writeProgress();
        }
        if (!sessionFailed && (doneBatches[sid] ?? 0) >= totalBatches) {
          done.add(sid);
          delete doneBatches[sid];
          writeProgress();
        }
      }
      if (failedBatches > 0) {
        writeProgress();
        console.log(LOG_PREFIX, `L2 回填提取未完成：分析 ${batches} 批，写入 ${written} 条，跳过重复 ${skippedDup} 条，${failedBatches} 批失败（下次启动续跑）`);
        return;
      }
      fs.writeFileSync(marker, JSON.stringify({ complete: true, doneSessions: [...done], at: Date.now(), batches, written, skippedDup }));
      console.log(LOG_PREFIX, `L2 回填提取完成：分析 ${batches} 批，写入 ${written} 条，跳过重复 ${skippedDup} 条`);
    } catch (e) {
      console.warn(LOG_PREFIX, "L2 回填失败:", e);
    }
  })();
}
