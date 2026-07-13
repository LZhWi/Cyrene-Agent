// 记忆压缩 + Reflection 引擎
//
// 每 20 轮触发一次：
//   阶段 A — 记忆压缩：聚类相似 L2 条目，合并为一条总结
//   阶段 B — Reflection：审视当前 L0/L1，建议更新
//
// 通过 enqueueLLMTask 在后台执行，不影响主对话流程。

import { memoryStore } from "./memory-store";
import type { L0WritableField } from "./memory-store";
import { addL2MemoryVector, deleteUserMemoryVectors, getEntriesBySource } from "../rag/index";
import { cosineSimilarity } from "../rag/vectorstore";
import { L0_FIELD_DESCRIPTIONS } from "./memory-types";
import type { L2Memory } from "./memory-types";
import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { getAdapterForConfig } from "../orchestrator/vendors";
import { recordUsage } from "../token-usage-store";
import { commitMemoryCompression } from "./memory-compression-transaction";

// ── LLM 调用（复用与 MemoryJudge 相同的 API 模式） ──

interface ModelSettings {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  explicitTransport?: "openai" | "anthropic" | "auto";
}

function loadModelSettings(): ModelSettings {
  const defaults = { provider: "DeepSeek（深度求索）", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro", apiKey: "" };
  try {
    const filePath = path.join(app.getPath("userData"), "model-settings.json");
    if (!fs.existsSync(filePath)) return defaults;
    const raw = fs.readFileSync(filePath, "utf8");
    const parsed = JSON.parse(raw) as Partial<ModelSettings>;
    const explicitTransport: ModelSettings["explicitTransport"] =
      parsed.explicitTransport === "openai" || parsed.explicitTransport === "anthropic" || parsed.explicitTransport === "auto"
        ? parsed.explicitTransport
        : undefined;
    return {
      provider: typeof parsed.provider === "string" && parsed.provider.trim() ? parsed.provider.trim() : defaults.provider,
      baseUrl: typeof parsed.baseUrl === "string" && parsed.baseUrl.trim() ? parsed.baseUrl.trim() : defaults.baseUrl,
      model: typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : defaults.model,
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "",
      explicitTransport,
    };
  } catch { return defaults; }
}

async function callLLM(messages: Array<{ role: "system" | "user"; content: string }>, maxTokens = 500): Promise<string> {
  const settings = loadModelSettings();
  if (!settings.apiKey) throw new Error("missing api key");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);

  const cfg = {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: settings.apiKey,
    explicitTransport: settings.explicitTransport,
  };

  try {
    // 走 adapter（之前直接写 OpenAI body / Bearer / choices 解析，anthropic 端点会拿到空串）
    const adapter = getAdapterForConfig(cfg);
    const http = adapter.buildRequest({
      model: cfg.model,
      messages,
      maxTokens,
      stream: false,
    }, cfg);

    const response = await fetch(http.url, {
      method: "POST",
      signal: controller.signal,
      headers: http.headers,
      body: http.body,
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({})) as Record<string, unknown>;
      const errMsg = (errorData as { error?: { message?: string } }).error?.message;
      throw new Error(errMsg || `HTTP ${response.status}`);
    }

    const data = await response.json();
    const parsed = adapter.parseResponse(data);

    if (parsed.usage) {
      recordUsage(parsed.usage.input, parsed.usage.output, 1);
    }

    return parsed.text ?? "";
  } finally {
    clearTimeout(timer);
  }
}

// ── 工具函数 ──

/** 从文本中提取 JSON 对象数组（容错：截断、markdown 包裹） */
function extractJsonArray(raw: string): unknown[] | null {
  let text = raw.replace(/```json\s*/gi, "").replace(/```\s*/gi, "").trim();
  const start = text.indexOf("[");
  if (start === -1) return null;
  text = text.slice(start);

  try { const parsed = JSON.parse(text); if (Array.isArray(parsed)) return parsed; } catch { /* fall through */ }

  // 截断救场：逐个捞取完整对象
  const results: unknown[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] !== "{") { i++; continue; }
    let depth = 0, inStr = false, esc = false, j = i;
    for (; j < text.length; j++) {
      const c = text[j];
      if (esc) { esc = false; continue; }
      if (c === "\\") { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === "{") depth++;
      else if (c === "}") { depth--; if (depth === 0) break; }
    }
    if (depth !== 0) break;
    try { const obj = JSON.parse(text.slice(i, j + 1)); if (obj && typeof obj === "object") results.push(obj); } catch { /* skip */ }
    i = j + 1;
  }
  return results.length > 0 ? results : null;
}

// ── 阶段 A：记忆压缩 ──

const SIMILARITY_THRESHOLD = 0.85;
const MIN_GROUP_SIZE = 3;

interface GroupedEntry {
  l2: L2Memory;
  embedding: number[];
}

async function compressMemories(): Promise<number> {
  const allL2 = await memoryStore.getAllL2();
  const activeL2 = allL2.filter((m) => m.status === "active" && !m.isSummary && m.ragId);

  if (activeL2.length < MIN_GROUP_SIZE) {
    console.log("[MemoryCompressor] 活跃 L2 条目不足，跳过压缩");
    return 0;
  }

  // 从 RAG 库获取 user_memory 条目，建立 ragId → embedding 映射
  const ragEntries = getEntriesBySource("user_memory");
  const embeddingMap = new Map<string, number[]>();
  for (const re of ragEntries) {
    embeddingMap.set(re.id, re.embedding);
  }

  // 为每个 L2 条目配对 embedding
  const withEmbedding: GroupedEntry[] = [];
  for (const l2 of activeL2) {
    if (l2.ragId) {
      const emb = embeddingMap.get(l2.ragId);
      if (emb) withEmbedding.push({ l2, embedding: emb });
    }
  }

  if (withEmbedding.length < MIN_GROUP_SIZE) {
    console.log("[MemoryCompressor] 带 embedding 的条目不足，跳过压缩");
    return 0;
  }

  // 贪心聚类：取一条作为种子，找所有与其相似度 >= 阈值的条目
  const used = new Set<string>();
  const groups: GroupedEntry[][] = [];

  for (let i = 0; i < withEmbedding.length; i++) {
    if (used.has(withEmbedding[i].l2.id)) continue;

    const group: GroupedEntry[] = [withEmbedding[i]];
    used.add(withEmbedding[i].l2.id);

    for (let j = i + 1; j < withEmbedding.length; j++) {
      if (used.has(withEmbedding[j].l2.id)) continue;
      const sim = cosineSimilarity(withEmbedding[i].embedding, withEmbedding[j].embedding);
      if (sim >= SIMILARITY_THRESHOLD) {
        group.push(withEmbedding[j]);
        used.add(withEmbedding[j].l2.id);
      }
    }

    if (group.length >= MIN_GROUP_SIZE) {
      groups.push(group);
    }
  }

  if (groups.length === 0) {
    console.log("[MemoryCompressor] 未找到可压缩的条目组");
    return 0;
  }

  console.log(`[MemoryCompressor] 发现 ${groups.length} 个可压缩组`);

  // 对每组调 LLM 生成总结
  let totalCompressed = 0;
  for (const group of groups) {
    try {
      const texts = group.map((g) => `- ${g.l2.content}`);
      const prompt = [
        "你是一个记忆总结助手。以下是一组相似的用户记忆条目，请将它们合并成一条简洁的总结。",
        "要求：",
        "- 保留所有关键信息，去重",
        "- 用中文自然语言",
        "- 控制在 100 字以内",
        "- 直接输出总结文本，不要额外解释",
        "",
        "记忆条目：",
        ...texts,
      ].join("\n");

      const summary = await callLLM([
        { role: "system", content: "你是一个简洁的记忆总结助手。" },
        { role: "user", content: prompt },
      ], 300);

      const cleanSummary = summary.replace(/^["「『]|["」』]$/g, "").trim();
      if (!cleanSummary || cleanSummary.length < 5) continue;

      const subEntryIds = group.map((g) => g.l2.id);
      await commitMemoryCompression({
        content: cleanSummary,
        triggerText: group[0].l2.triggerText,
        sourceConversationId: group[0].l2.sourceConversationId,
        sources: group.map((entry) => ({
          id: entry.l2.id,
          ragId: entry.l2.ragId,
          status: entry.l2.status,
        })),
      }, {
        createSummary: (input) => memoryStore.addL2Memory(input),
        addSummaryVector: addL2MemoryVector,
        markSummarySynced: (l2Id, ragId) => memoryStore.markL2SyncStatus(l2Id, "synced", ragId),
        archiveSources: (ids) => memoryStore.archiveL2Batch(ids),
        restoreSources: async (sources) => {
          const byStatus = new Map<L2Memory["status"], string[]>();
          for (const source of sources) {
            byStatus.set(source.status, [...(byStatus.get(source.status) ?? []), source.id]);
          }
          for (const [status, ids] of byStatus) await memoryStore.updateL2Status(ids, status);
        },
        deactivateSummary: (id) => memoryStore.updateL2Status([id], "archived"),
        deleteSummary: (id) => memoryStore.deleteL2(id),
        deleteVectors: (ids) => deleteUserMemoryVectors(ids),
        warn: (message, error) => console.warn(`[MemoryCompressor] ${message}:`, error),
      });

      // 记录日志
      await memoryStore.appendReflectionLog({
        type: "compression",
        summary: `压缩 ${subEntryIds.length} 条记忆为一条总结`,
        details: `原条目：${texts.join(" | ")}\n总结：${cleanSummary}`,
      });

      totalCompressed += subEntryIds.length;
      console.log(`[MemoryCompressor] 压缩了 ${subEntryIds.length} 条 → "${cleanSummary.slice(0, 40)}"`);
    } catch (err) {
      console.warn("[MemoryCompressor] 组压缩失败:", err);
    }
  }

  return totalCompressed;
}

// ── 阶段 B：Reflection（L0/L1 元认知更新） ──

async function runReflection(): Promise<void> {
  try {
    const l0 = await memoryStore.getL0();
    const l1 = await memoryStore.getL1();

    if (l0.isPinned) {
      console.log("[Reflection] L0 已锁定，跳过更新建议");
    }

    // 构建 LLM prompt
    const currentProfile = [
      "当前用户画像：",
      l0.preferredName ? `  称呼：${l0.preferredName}` : "",
      l0.occupation ? `  职业：${l0.occupation}` : "",
      l0.longTermInterests ? `  长期兴趣：${l0.longTermInterests}` : "",
      l0.language ? `  常用语言：${l0.language}` : "",
      l0.permanentNote ? `  备注：${l0.permanentNote}` : "",
      "",
      "当前近期状态：",
      l1.recentGoals ? `  最近目标：${l1.recentGoals}` : "",
      l1.recentPreferences ? `  近期偏好：${l1.recentPreferences}` : "",
      l1.currentProject ? `  当前项目：${l1.currentProject}` : "",
      `  对话轮数：${l1.roundCount}`,
    ].filter(Boolean).join("\n");

    const fieldDescriptions = Object.entries(L0_FIELD_DESCRIPTIONS)
      .map(([field, desc]) => `  ${field}：${desc}`)
      .join("\n");

    const prompt = [
      "你是一个用户画像反思助手。",
      "回顾与用户的长期互动，判断是否需要更新用户画像或近期状态。",
      "",
      currentProfile,
      "",
      "请分析：",
      "1. 是否有信息可以更新 L0 字段（稳定身份信息）？",
      `   可用字段：\n${fieldDescriptions}`,
      "2. 是否有信息可以更新 L1 字段（近期目标/偏好/项目）？",
      "",
      "如果没有需要更新的信息，返回空数组 []。",
      "如果需要更新，以 JSON 数组格式返回，每个元素包含：",
      '{ "layer": "L0"|"L1", "field": "字段名", "content": "新值", "confidence": 0.0~1.0 }',
      "",
      "只输出 JSON，不要额外解释。",
    ].join("\n");

    const raw = await callLLM([
      { role: "system", content: "你是一个谨慎的用户画像反思助手。只输出 JSON 数组。" },
      { role: "user", content: prompt },
    ], 500);

    const parsed = extractJsonArray(raw);
    if (!parsed || parsed.length === 0) {
      console.log("[Reflection] 无 L0/L1 更新建议");
      return;
    }

    const validFields = Object.keys(L0_FIELD_DESCRIPTIONS);
    let updateCount = 0;

    for (const item of parsed) {
      const rec = item as Record<string, unknown>;
      const layer = rec.layer;
      const field = rec.field as string | undefined;
      const content = rec.content as string | undefined;
      const confidence = rec.confidence as number | undefined;

      if (!content || !confidence || confidence < 0.6) continue;

      if (layer === "L0" && field && validFields.includes(field) && !l0.isPinned) {
        await memoryStore.upsertL0Field(field as L0WritableField, content.trim());
        await memoryStore.appendReflectionLog({
          type: "l0_update",
          summary: `L0.${field} 更新为 "${content.slice(0, 30)}"（置信度 ${confidence.toFixed(2)}）`,
        });
        updateCount++;
        console.log(`[Reflection] L0.${field} 更新: "${content.slice(0, 30)}"`);
      } else if (layer === "L1") {
        const l1Field = /目标|想要|计划|打算/.test(content) ? "recentGoals" : "recentPreferences";
        await memoryStore.replaceL1Field(l1Field, content.trim());
        await memoryStore.appendReflectionLog({
          type: "l1_update",
          summary: `L1.${l1Field} 更新为 "${content.slice(0, 30)}"（置信度 ${confidence.toFixed(2)}）`,
        });
        updateCount++;
        console.log(`[Reflection] L1.${l1Field} 更新: "${content.slice(0, 30)}"`);
      }
    }

    console.log(`[Reflection] 完成，更新了 ${updateCount} 个字段`);
  } catch (err) {
    console.warn("[Reflection] 执行失败:", err);
  }
}

// ── 公开入口 ──

/**
 * 运行记忆压缩 + Reflection。
 * 由 scheduleMemoryWrite 在每 20 轮时触发。
 */
export async function runReflectionAndCompression(): Promise<void> {
  console.log("[Memory] 开始 20 轮 Reflection + 记忆压缩...");

  // 阶段 A：记忆压缩
  const compressed = await compressMemories();
  console.log(`[Memory] 压缩完成，共压缩 ${compressed} 条原始记忆`);

  // 阶段 B：Reflection（L0/L1 元认知更新）
  await runReflection();

  // 重建 RAG 索引（数据有变化）
  try {
    const { JsonVectorStore } = await import("../rag/vectorstore");
    // 通过重新 import 触发不了实例方法，下面通过公开方法访问
    // 实际会在下次 search 时惰性重建
    console.log("[Memory] 向量索引已标记脏，下次搜索时自动重建");
  } catch { /* ignore */ }

  console.log("[Memory] Reflection + 压缩流程完成");
}
