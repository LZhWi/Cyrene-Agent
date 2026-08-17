// 记忆梦境蒸馏（梦境 = 空闲期记忆整理，思想源自睡眠记忆重放/蒸馏）
//
// 触发：空闲 ≥ 15 分钟且距上次做梦 ≥ 24 小时；用户回来立即中止（记录水位线）。
// 全部 LLM 调用走 llm-queue 串行，不与主聊天抢配额。
//
// 三段管线：
//   ① 体检瘦身（纯本地，0 token）：硬容量上限（active 300 / 总 800），
//      按 weight × 时近度 从低到高降级，只降级不删除，pinned 豁免。
//   ② 遗忘前沉淀（1 次 LLM）：把本轮被降级的条目蒸馏成第一人称叙事补丁，
//      存入 memory.json dreamNarratives——永不衰减的长期陪伴叙事。
//   ③ 蒸馏合并（≤5 次 LLM）：aging 层向量聚类（余弦 ≥ 0.82，≥3 条一组），
//      每组合并成一条总结；旧条目 merged + mergedInto，active/pinned 永不进候选。
//
// 开关：model-settings.json 的 memoryDreamEnabled（默认关）。
// 模型：model-settings.json 可选 "dream" 段（provider/baseUrl/model/apiKey/explicitTransport）
// 指定专用模型；不写则跟随主模型。做梦任务关思考：归纳总结不依赖思考链，
// 成本可再降一半以上，且避免长思考拖破空闲窗口。

import * as fs from "fs";
import * as path from "path";
import { getUserDataDir } from "../runtime/runtime-paths";
import { memoryStore } from "./memory-store";
import { appendMemoryTrace } from "./memory-trace";
import { isL2Expired, type L2Memory, type L2MemoryStatus } from "./memory-types";
import { addL2MemoryVector, deleteUserMemoryVectors, getEntriesBySource, isUserMemoryVectorStoreReady } from "../rag/index";
import { cosineSimilarity } from "../rag/vectorstore";
import { getAdapterForConfig } from "../orchestrator/vendors";
import { recordUsage } from "../token-usage-store";
import { enqueueLLMTask } from "../llm-queue";
import { commitMemoryCompression } from "./memory-compression-transaction";

const LOG_PREFIX = "[MemoryDream]";

export const DREAM_PARAMS = {
  /** active 层容量上限，超出按评分从低到高降为 aging */
  activeCap: 300,
  /** 全库容量上限（含 archived），超出把最低分 aging 归档 */
  totalCap: 800,
  /** 评分时近度半衰期：与 L2 active→aging 的自然衰减节奏对齐 */
  recencyHalfLifeMs: 30 * 24 * 60 * 60 * 1000,
  /** 沉淀单次最多喂给 LLM 的条目数（防 prompt 膨胀） */
  sedimentMaxEntries: 20,
  /** ③ 聚类余弦阈值：比压缩器的 0.85 略松——aging 层允许更激进的归纳 */
  mergeSimilarity: 0.82,
  mergeMinGroup: 3,
  /** 单次做梦最多合并几组（LLM 预算封顶） */
  mergeMaxCalls: 5,
  /** 叙事补丁保留上限；注入时只取最新 NARRATIVE_INJECT_MAX 条 */
  narrativeMax: 8,
};

export type DreamParams = typeof DREAM_PARAMS;

function resolveParams(overrides?: Partial<DreamParams>): DreamParams {
  return overrides ? { ...DREAM_PARAMS, ...overrides } : DREAM_PARAMS;
}

/** always-on 上下文最多注入几条叙事补丁（每条 ≤400 字，3 条约 600 token） */
export const NARRATIVE_INJECT_MAX = 3;

export interface DreamResult {
  status: "completed" | "aborted" | "skipped" | "error";
  reason?: string;
  durationMs: number;
  demotedToAging: number;
  demotedToArchived: number;
  narrativeWritten: boolean;
  mergedGroups: number;
  mergedEntries: number;
}

export interface DreamLogEntry {
  id: string;
  startedAt: number;
  finishedAt: number;
  status: DreamResult["status"];
  reason?: string;
  demotedToAging: number;
  demotedToArchived: number;
  narrativeWritten: boolean;
  mergedGroups: number;
  mergedEntries: number;
}

interface DreamStateFile {
  lastDreamAt?: number;
  logs: DreamLogEntry[];
}

function dreamStatePath(): string {
  return path.join(getUserDataDir(), "memory-dream.json");
}

export function loadDreamState(): DreamStateFile {
  try {
    if (!fs.existsSync(dreamStatePath())) return { logs: [] };
    const parsed = JSON.parse(fs.readFileSync(dreamStatePath(), "utf8")) as Partial<DreamStateFile>;
    return {
      lastDreamAt: typeof parsed.lastDreamAt === "number" ? parsed.lastDreamAt : undefined,
      logs: Array.isArray(parsed.logs) ? parsed.logs.slice(-30) : [],
    };
  } catch {
    return { logs: [] };
  }
}

function saveDreamState(state: DreamStateFile): void {
  try {
    const dir = path.dirname(dreamStatePath());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dreamStatePath(), JSON.stringify({ ...state, logs: state.logs.slice(-30) }, null, 2), "utf8");
  } catch (err) {
    console.warn(LOG_PREFIX, "梦境状态写入失败（不影响记忆本体）:", err);
  }
}

// ── 开关与模型解析 ──

/** 梦境总开关：model-settings.json 的 memoryDreamEnabled 字段，默认关。 */
export function isMemoryDreamEnabled(): boolean {
  try {
    const raw = fs.readFileSync(path.join(getUserDataDir(), "model-settings.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed.memoryDreamEnabled === true;
  } catch {
    return false;
  }
}

export interface DreamModelConfig {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  explicitTransport?: "openai" | "anthropic" | "auto";
}

/**
 * 做梦专用模型解析：model-settings.json 可选 "dream" 段覆盖主配置三件套。
 * dream 段必须四要素齐全才算有效（缺 apiKey 的半截配置不如不配），否则整体跟随主模型。
 */
export function resolveDreamModel(): DreamModelConfig {
  const defaults = { provider: "DeepSeek（深度求索）", baseUrl: "https://api.deepseek.com", model: "deepseek-v4-pro", apiKey: "" };
  try {
    const raw = fs.readFileSync(path.join(getUserDataDir(), "model-settings.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const main: DreamModelConfig = {
      provider: typeof parsed.provider === "string" && parsed.provider.trim() ? parsed.provider.trim() : defaults.provider,
      baseUrl: typeof parsed.baseUrl === "string" && parsed.baseUrl.trim() ? parsed.baseUrl.trim() : defaults.baseUrl,
      model: typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : defaults.model,
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "",
      explicitTransport:
        parsed.explicitTransport === "openai" || parsed.explicitTransport === "anthropic" || parsed.explicitTransport === "auto"
          ? parsed.explicitTransport
          : undefined,
    };
    const dream = parsed.dream as Partial<DreamModelConfig> | undefined;
    if (
      dream &&
      typeof dream.provider === "string" && dream.provider.trim() &&
      typeof dream.baseUrl === "string" && dream.baseUrl.trim() &&
      typeof dream.model === "string" && dream.model.trim() &&
      typeof dream.apiKey === "string" && dream.apiKey.trim()
    ) {
      return {
        provider: dream.provider.trim(),
        baseUrl: dream.baseUrl.trim(),
        model: dream.model.trim(),
        apiKey: dream.apiKey.trim(),
        explicitTransport:
          dream.explicitTransport === "openai" || dream.explicitTransport === "anthropic" || dream.explicitTransport === "auto"
            ? dream.explicitTransport
            : main.explicitTransport,
      };
    }
    return main;
  } catch (err) {
    console.error(LOG_PREFIX, "读取 model-settings.json 失败，退回默认设置:", err);
    return defaults;
  }
}

// 导出仅供测试复用（与 compressor 的 callLLM 同例）。
export async function callDreamLLM(
  messages: Array<{ role: "system" | "user"; content: string }>,
  opts: { maxTokens?: number; signal?: AbortSignal } = {},
): Promise<string> {
  const settings = resolveDreamModel();
  if (!settings.apiKey) throw new Error("missing api key");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 300000);
  const onOuterAbort = () => controller.abort();
  if (opts.signal) {
    if (opts.signal.aborted) controller.abort();
    else opts.signal.addEventListener("abort", onOuterAbort);
  }

  const cfg = {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: settings.apiKey,
    explicitTransport: settings.explicitTransport,
    // 做梦是归纳总结任务，不依赖思考链；关思考省时省 token（judge 需要开思考做跨轮提取，此处不同）。
    reasoning: { mode: "off" } as const,
  };

  try {
    const adapter = getAdapterForConfig(cfg);
    const http = adapter.buildRequest({
      model: cfg.model,
      messages,
      maxTokens: opts.maxTokens ?? 2048,
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
    if (opts.signal) opts.signal.removeEventListener("abort", onOuterAbort);
  }
}

// ── 阶段 ①：体检瘦身（纯本地）──

/** 瘦身评分：weight × 时近度（半衰期 30 天）。低分先降级；常用且新鲜的记忆不受影响。 */
export function dreamSlimScore(memory: L2Memory, now: number, params: DreamParams = DREAM_PARAMS): number {
  const age = Math.max(0, now - Math.max(memory.lastAccessedAt || 0, memory.createdAt || 0));
  const recency = Math.pow(0.5, age / params.recencyHalfLifeMs);
  return memory.weight * recency;
}

export interface SlimPlan {
  /** active → aging 的条目 id */
  toAging: string[];
  /** aging → archived 的条目 id */
  toArchive: string[];
}

/**
 * 容量体检规划（纯函数）：
 * - active 超上限：非 pinned 的 active 按评分从低到高降为 aging；
 * - 全库仍超上限：非 pinned 的 aging（含本轮新降的）按评分从低到高归档。
 * 只降级不删除；pinned 永不参与。
 */
export function planSlimDown(all: L2Memory[], now: number, params: DreamParams = DREAM_PARAMS): SlimPlan {
  const toAging: string[] = [];
  const toArchive: string[] = [];

  const activeCount = all.filter((m) => m.status === "active").length;
  const activeOverflow = activeCount - params.activeCap;
  if (activeOverflow > 0) {
    const demoteCandidates = all
      .filter((m) => m.status === "active" && !m.isPinned)
      .sort((a, b) => dreamSlimScore(a, now, params) - dreamSlimScore(b, now, params))
      .slice(0, activeOverflow);
    for (const m of demoteCandidates) toAging.push(m.id);
  }

  const totalOverflow = all.length - params.totalCap;
  if (totalOverflow > 0) {
    const demotedSet = new Set(toAging);
    const agingPool = all
      .filter((m) => (m.status === "aging" || demotedSet.has(m.id)) && !m.isPinned)
      .sort((a, b) => dreamSlimScore(a, now, params) - dreamSlimScore(b, now, params))
      .slice(0, totalOverflow);
    for (const m of agingPool) {
      if (!demotedSet.has(m.id)) toArchive.push(m.id);
    }
  }
  return { toAging, toArchive };
}

// ── 阶段 ②：遗忘前沉淀 ──

function buildSedimentPrompt(entries: L2Memory[], params: DreamParams): string {
  const lines = entries.slice(0, params.sedimentMaxEntries).map((m) => {
    const quote = (m.sourceQuote ?? "").trim();
    return `- ${m.content.slice(0, 120)}${quote && quote !== m.content ? `（当时的原话：${quote.slice(0, 200)}）` : ""}`;
  });
  return [
    "以下是几段即将从活跃记忆里淡出的印象。请以你（陪伴者）的第一人称，",
    "把它们沉淀成一段 150~300 字的长期陪伴叙事：记录这些印象对你的意义、你从中看到的关系脉络。",
    "要求：",
    "- 只基于给出的条目，不虚构新事实；专有名词与数字保持原样",
    "- 语气温柔克制，像写进日记的段落，不要列表、不要标题",
    "- 直接输出叙事文本，不要任何解释",
    "",
    "印象条目：",
    ...lines,
  ].join("\n");
}

function sanitizeNarrative(raw: string): string | null {
  const text = raw.replace(/^["「『]|["」』]$/g, "").trim();
  if (text.length < 20 || text.length > 600) return null;
  return text;
}

// ── 阶段 ③：蒸馏合并 ──

interface MergeCandidate {
  l2: L2Memory;
  embedding: number[];
}

/** 贪心聚类（与压缩器同款算法，阈值按 params）：种子条目吸收所有相似邻居。 */
export function clusterDreamGroups(candidates: MergeCandidate[], params: DreamParams = DREAM_PARAMS): MergeCandidate[][] {
  const used = new Set<string>();
  const groups: MergeCandidate[][] = [];
  for (let i = 0; i < candidates.length; i++) {
    if (used.has(candidates[i].l2.id)) continue;
    const group: MergeCandidate[] = [candidates[i]];
    used.add(candidates[i].l2.id);
    for (let j = i + 1; j < candidates.length; j++) {
      if (used.has(candidates[j].l2.id)) continue;
      if (cosineSimilarity(candidates[i].embedding, candidates[j].embedding) >= params.mergeSimilarity) {
        group.push(candidates[j]);
        used.add(candidates[j].l2.id);
      }
    }
    if (group.length >= params.mergeMinGroup) groups.push(group);
  }
  return groups;
}

function buildMergePrompt(group: MergeCandidate[]): string {
  const texts = group.map((g) => `- ${g.l2.content}`);
  return [
    "以下是一组语义相近的久远印象条目，请合并成一条简洁总结。",
    "要求：",
    "- 保留所有关键信息（专有名词、数字、时间），去重",
    "- 用中文自然语言，控制在 100 字以内",
    "- 直接输出总结文本，不要额外解释",
    "",
    "印象条目：",
    ...texts,
  ].join("\n");
}

/** 梦境合并候选：仅 aging 层，排除 pinned/已过期/冲突挂起/总结条目，且必须有向量。 */
function collectMergeCandidates(allL2: L2Memory[], now: number): MergeCandidate[] {
  const embeddingByRagId = new Map<string, number[]>();
  for (const entry of getEntriesBySource("user_memory")) {
    embeddingByRagId.set(entry.id, entry.embedding);
  }
  const candidates: MergeCandidate[] = [];
  for (const l2 of allL2) {
    if (l2.status !== "aging" || l2.isPinned || l2.isSummary) continue;
    if (l2.conflictWith && l2.conflictWith.length > 0) continue;
    if (isL2Expired(l2, now)) continue;
    if (!l2.ragId) continue;
    const embedding = embeddingByRagId.get(l2.ragId);
    if (embedding) candidates.push({ l2, embedding });
  }
  return candidates;
}

/**
 * 提交一组合并。复用压缩事务的回滚语义：摘要向量未就位前不动源条目，
 * 任何一步失败整体回滚，不会出现"源条目没了、总结也没进索引"的记忆丢失。
 * merged 语义经 archiveSources 槽位注入：源条目标 merged + mergedInto（而非 archived）。
 */
async function commitDreamMerge(group: MergeCandidate[], summaryText: string): Promise<void> {
  let summaryId = "";
  await commitMemoryCompression({
    content: summaryText,
    triggerText: group[0].l2.triggerText,
    sourceConversationId: group[0].l2.sourceConversationId,
    sources: group.map((entry) => ({
      id: entry.l2.id,
      ragId: entry.l2.ragId,
      status: entry.l2.status,
    })),
  }, {
    createSummary: async (input) => {
      const memory = await memoryStore.addL2Memory(input);
      summaryId = memory.id;
      return memory;
    },
    addSummaryVector: (text, l2Id, metadata) => addL2MemoryVector(text, l2Id, metadata),
    markSummarySynced: (l2Id, ragId) => memoryStore.markL2SyncStatus(l2Id, "synced", ragId),
    archiveSources: (ids) => memoryStore.mergeL2Batch(ids, summaryId),
    // 候选全部来自 aging 层，回滚即恢复 aging
    restoreSources: (sources) => memoryStore.updateL2Status(sources.map((s) => s.id), "aging"),
    deactivateSummary: (id) => memoryStore.updateL2Status([id], "archived"),
    deleteSummary: (id) => memoryStore.deleteL2(id),
    deleteVectors: (ids) => deleteUserMemoryVectors(ids),
    warn: (message, error) => console.warn(`${LOG_PREFIX} ${message}:`, error),
  });
}

// ── 主流程 ──

function isAborted(signal?: AbortSignal): boolean {
  return signal?.aborted === true;
}

/**
 * 执行一次完整的梦。任何阶段前检测到中止信号都会尽快收尾并返回 aborted。
 * 写盘动作（降级/叙事/合并）各自独立提交：中止只影响尚未开始的阶段，不做跨阶段回滚。
 */
export async function runDreamCycle(opts: { signal?: AbortSignal; params?: Partial<DreamParams> } = {}): Promise<DreamResult> {
  const params = resolveParams(opts.params);
  const startedAt = Date.now();
  const result: DreamResult = {
    status: "completed",
    durationMs: 0,
    demotedToAging: 0,
    demotedToArchived: 0,
    narrativeWritten: false,
    mergedGroups: 0,
    mergedEntries: 0,
  };
  const finish = (status: DreamResult["status"], reason?: string): DreamResult => {
    result.status = status;
    result.reason = reason;
    result.durationMs = Date.now() - startedAt;
    return result;
  };

  if (isAborted(opts.signal)) return finish("aborted", "aborted_before_start");
  if (!isUserMemoryVectorStoreReady()) return finish("skipped", "rag_unavailable");

  const now = Date.now();
  const allL2 = await memoryStore.getAllL2();
  console.log(LOG_PREFIX, `开始做梦：L2 共 ${allL2.length} 条（active ${allL2.filter((m) => m.status === "active").length}）`);

  // ── 阶段 ①：体检瘦身 ──
  const plan = planSlimDown(allL2, now, params);
  const statusChanges = new Map<L2MemoryStatus, string[]>();
  for (const id of plan.toAging) statusChanges.set("aging", [...(statusChanges.get("aging") ?? []), id]);
  for (const id of plan.toArchive) statusChanges.set("archived", [...(statusChanges.get("archived") ?? []), id]);
  for (const [status, ids] of statusChanges) {
    await memoryStore.updateL2Status(ids, status);
  }
  result.demotedToAging = plan.toAging.length;
  result.demotedToArchived = plan.toArchive.length;
  appendMemoryTrace({
    op: "dream.slim",
    layer: "L2",
    status: plan.toAging.length + plan.toArchive.length > 0 ? "ok" : "skip",
    details: { toAging: plan.toAging.length, toArchive: plan.toArchive.length },
  });

  // ── 阶段 ②：遗忘前沉淀（仅当本轮确有降级条目）──
  if (isAborted(opts.signal)) return finish("aborted", "aborted_before_sediment");
  const byId = new Map(allL2.map((m) => [m.id, m]));
  const demotedEntries = [...plan.toAging, ...plan.toArchive]
    .map((id) => byId.get(id))
    .filter((m): m is L2Memory => Boolean(m));
  if (demotedEntries.length > 0) {
    try {
      const raw = await callDreamLLM([
        { role: "system", content: "你是昔涟的记忆整理内心独白。只输出叙事文本。" },
        { role: "user", content: buildSedimentPrompt(demotedEntries, params) },
      ], { maxTokens: 2048, signal: opts.signal });
      const narrative = sanitizeNarrative(raw);
      if (narrative) {
        await memoryStore.appendDreamNarrative(narrative);
        result.narrativeWritten = true;
        console.log(LOG_PREFIX, `沉淀叙事已写入（${narrative.length} 字）: "${narrative.slice(0, 40)}…"`);
      } else if (!isAborted(opts.signal)) {
        console.warn(LOG_PREFIX, "沉淀输出为空或超长，跳过叙事写入");
      }
    } catch (err) {
      if (isAborted(opts.signal)) return finish("aborted", "aborted_in_sediment");
      console.warn(LOG_PREFIX, "沉淀失败（不影响其余阶段）:", err);
    }
  }

  // ── 阶段 ③：蒸馏合并（aging 层聚类）──
  if (isAborted(opts.signal)) return finish("aborted", "aborted_before_merge");
  try {
    const latestL2 = await memoryStore.getAllL2();
    const candidates = collectMergeCandidates(latestL2, now);
    const groups = clusterDreamGroups(candidates, params)
      .sort((a, b) => b.length - a.length)
      .slice(0, params.mergeMaxCalls);
    if (groups.length > 0) console.log(LOG_PREFIX, `发现 ${groups.length} 个可合并组（aging 候选 ${candidates.length} 条）`);

    for (const group of groups) {
      if (isAborted(opts.signal)) return finish("aborted", "aborted_in_merge");
      try {
        const raw = await callDreamLLM([
          { role: "system", content: "你是简洁的记忆总结助手。只输出总结文本。" },
          { role: "user", content: buildMergePrompt(group) },
        ], { maxTokens: 2048, signal: opts.signal });
        const summary = raw.replace(/^["「『]|["」』]$/g, "").trim();
        if (summary.length < 5) continue;
        await commitDreamMerge(group, summary);
        result.mergedGroups += 1;
        result.mergedEntries += group.length;
        console.log(LOG_PREFIX, `合并 ${group.length} 条 → "${summary.slice(0, 40)}"`);
      } catch (err) {
        if (isAborted(opts.signal)) return finish("aborted", "aborted_in_merge");
        console.warn(LOG_PREFIX, "组合并失败（跳过该组）:", err);
      }
    }
  } catch (err) {
    console.warn(LOG_PREFIX, "蒸馏合并阶段失败:", err);
  }

  appendMemoryTrace({
    op: "dream.cycle",
    layer: "L2",
    status: "ok",
    details: {
      durationMs: Date.now() - startedAt,
      demotedToAging: result.demotedToAging,
      demotedToArchived: result.demotedToArchived,
      narrativeWritten: result.narrativeWritten,
      mergedGroups: result.mergedGroups,
      mergedEntries: result.mergedEntries,
    },
  });
  console.log(LOG_PREFIX, `做梦完成：降级 ${result.demotedToAging}+${result.demotedToArchived} 条，叙事 ${result.narrativeWritten ? "1" : "0"} 段，合并 ${result.mergedGroups} 组/${result.mergedEntries} 条`);
  return finish("completed");
}

// ── 调度器：空闲窗口触发 + 用户回归中止 ──

const DREAM_CHECK_INTERVAL_MS = 10 * 60 * 1000;
export const DREAM_IDLE_MS = 15 * 60 * 1000;
export const DREAM_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
const DREAM_LOG_MAX = 30;

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let lastUserActivityAt = 0;
let dreamRunning = false;
let dreamAbort: AbortController | null = null;

/**
 * 用户活动信号：聊天消息到达时调用。做梦进行中则立即中止——
 * 水位线照常推进，避免用户回来后梦境反复重试抢配额。
 */
export function notifyDreamUserActivity(): void {
  lastUserActivityAt = Date.now();
  if (dreamRunning && dreamAbort && !dreamAbort.signal.aborted) {
    console.log(LOG_PREFIX, "用户回来了，中止本次做梦");
    dreamAbort.abort();
  }
}

async function tryStartDream(): Promise<void> {
  if (dreamRunning) return;
  dreamRunning = true;
  dreamAbort = new AbortController();
  const startedAt = Date.now();
  console.log(LOG_PREFIX, "空闲窗口命中，开始做梦（走 LLM 后台队列）");
  let result: DreamResult | null = null;
  try {
    result = await enqueueLLMTask("MemoryDream", () => runDreamCycle({ signal: dreamAbort!.signal }));
  } catch (err) {
    console.warn(LOG_PREFIX, "梦境执行异常:", err);
  } finally {
    dreamRunning = false;
    dreamAbort = null;
  }

  const state = loadDreamState();
  const entry: DreamLogEntry = {
    id: `dream_${startedAt}_${Math.random().toString(36).slice(2, 8)}`,
    startedAt,
    finishedAt: Date.now(),
    status: result?.status ?? "error",
    reason: result?.reason ?? (result ? undefined : "unhandled_exception"),
    demotedToAging: result?.demotedToAging ?? 0,
    demotedToArchived: result?.demotedToArchived ?? 0,
    narrativeWritten: result?.narrativeWritten ?? false,
    mergedGroups: result?.mergedGroups ?? 0,
    mergedEntries: result?.mergedEntries ?? 0,
  };
  state.logs = [...state.logs, entry].slice(-DREAM_LOG_MAX);
  // 完成/中止都记水位线（中止是用户回归所致，不是失败）；
  // skipped/error 不记——RAG 未就绪或调用失败应在条件恢复后尽快重试。
  if (entry.status === "completed" || entry.status === "aborted") {
    state.lastDreamAt = startedAt;
  }
  saveDreamState(state);
}

function checkDreamWindow(): void {
  try {
    if (!isMemoryDreamEnabled() || dreamRunning) return;
    const now = Date.now();
    if (now - lastUserActivityAt < DREAM_IDLE_MS) return;
    const state = loadDreamState();
    if (now - (state.lastDreamAt ?? 0) < DREAM_MIN_INTERVAL_MS) return;
    void tryStartDream();
  } catch (err) {
    console.warn(LOG_PREFIX, "梦境调度检查失败:", err);
  }
}

/** 启动梦境调度：每 10 分钟检查一次空闲窗口。重复调用幂等。 */
export function startDreamScheduler(): void {
  if (schedulerTimer) return;
  // 启动时刻视为一次用户活动：刚打开应用的人多半就在屏幕前，
  // 首个梦最早也要 15 分钟无互动之后。
  lastUserActivityAt = Date.now();
  schedulerTimer = setInterval(checkDreamWindow, DREAM_CHECK_INTERVAL_MS);
  console.log(LOG_PREFIX, "梦境调度已启动（默认关闭，model-settings.json memoryDreamEnabled=true 启用）");
}

export function stopDreamScheduler(): void {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
  if (dreamAbort) dreamAbort.abort();
}

/** 测试辅助：重置调度器内部状态 */
export function resetDreamSchedulerForTest(): void {
  stopDreamScheduler();
  dreamRunning = false;
  dreamAbort = null;
  lastUserActivityAt = 0;
}
