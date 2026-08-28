import { getAdapterForConfig } from "../orchestrator/vendors"
import type { ChatMessage, VendorConfig } from "../orchestrator/vendors"
import { recordUsage } from "../token-usage-store"
import { addL2MemoryVector } from "../rag/index"
import { appendMemoryTrace } from "./memory-trace"
import { memoryStore } from "./memory-store"
import type { ConflictLog, L2Memory, MemoryEvidence } from "./memory-types"
import * as fs from "fs"
import * as path from "path"
import { getUserDataDir } from "../runtime/runtime-paths"

export type MemoryConflictResolutionType =
  | "unrelated"
  | "context_difference"
  | "preference_evolution"
  | "direct_conflict"
  | "uncertain"

export interface MemoryConflictResolution {
  resolutionType: MemoryConflictResolutionType
  resolvedSummary?: string
  currentSummary?: string
  historicalSummary?: string
  reason: string
  confidence: number
  actions: {
    createResolvedMemory: boolean
    oldMemoryStatus?: "active" | "aging" | "archived" | "superseded" | "merged"
    newMemoryStatus?: "active" | "aging" | "archived" | "superseded" | "merged"
    shouldUpdateCoreMemory?: boolean
    shouldAskUser?: boolean
    clarificationNeeded?: boolean
  }
}

export interface ResolverPayload {
  conflictLog: ConflictLog
  newMemory: L2Memory
  oldMemory: L2Memory
  newEvidence: MemoryEvidence[]
  oldEvidence: MemoryEvidence[]
  conflictScore: number
  scoringSignals: ConflictLog["scoringSignals"]
}

export interface ResolverModelSettings {
  provider: string
  baseUrl: string
  model: string
  apiKey: string
  explicitTransport?: "openai" | "anthropic" | "auto"
}

export interface ResolverDeps {
  callLLM: (messages: Array<{ role: "system" | "user"; content: string }>, maxTokens: number) => Promise<string>
}

export interface ResolverRunResult {
  status: "skip" | "resolved" | "failed" | "rate_limited"
  conflictLogId?: string
  error?: string
}

export interface ResolverRunOptions {
  now?: number
  minIntervalMs?: number
}

const DEFAULT_MODEL_SETTINGS: ResolverModelSettings = {
  provider: "DeepSeek（深度求索）",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-pro",
  apiKey: "",
}

const DEFAULT_RESOLVER_MIN_INTERVAL_MS = 60_000
let lastResolverRunAt: number | null = null

function loadResolverModelSettings(): ResolverModelSettings {
  try {
    const filePath = path.join(getUserDataDir(), "model-settings.json")
    if (!fs.existsSync(filePath)) return DEFAULT_MODEL_SETTINGS
    const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<ResolverModelSettings>
    return {
      provider: typeof parsed.provider === "string" && parsed.provider.trim() ? parsed.provider.trim() : DEFAULT_MODEL_SETTINGS.provider,
      baseUrl: typeof parsed.baseUrl === "string" && parsed.baseUrl.trim() ? parsed.baseUrl.trim() : DEFAULT_MODEL_SETTINGS.baseUrl,
      model: typeof parsed.model === "string" && parsed.model.trim() ? parsed.model.trim() : DEFAULT_MODEL_SETTINGS.model,
      apiKey: typeof parsed.apiKey === "string" ? parsed.apiKey.trim() : "",
      explicitTransport: parsed.explicitTransport === "openai" || parsed.explicitTransport === "anthropic" || parsed.explicitTransport === "auto" ? parsed.explicitTransport : undefined,
    }
  } catch (err) {
    // 与 compressor 同理：静默降级要留日志，否则 "missing api key" 对不上因果。
    console.error("[MemoryResolver] 读取 model-settings.json 失败，退回默认设置:", err)
    return DEFAULT_MODEL_SETTINGS
  }
}

function stripThinkBlocks(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, "")
    .replace(/<think>[\s\S]*$/gi, "")
    .trim()
}

function extractJsonObject(raw: string): Record<string, unknown> | null {
  const text = stripThinkBlocks(raw)
    .replace(/```json\s*/gi, "")
    .replace(/```\s*/gi, "")
    .trim()
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start === -1 || end <= start) return null
  try {
    const parsed = JSON.parse(text.slice(start, end + 1))
    return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null
  } catch {
    return null
  }
}

function normalizeResolution(input: Record<string, unknown>): MemoryConflictResolution | null {
  const resolutionType = input.resolutionType
  const reason = input.reason
  const confidence = input.confidence
  const actions = input.actions
  if (
    resolutionType !== "unrelated" &&
    resolutionType !== "context_difference" &&
    resolutionType !== "preference_evolution" &&
    resolutionType !== "direct_conflict" &&
    resolutionType !== "uncertain"
  ) return null
  if (typeof reason !== "string" || !reason.trim()) return null
  if (typeof confidence !== "number" || !Number.isFinite(confidence)) return null
  if (!actions || typeof actions !== "object") return null
  const actionRecord = actions as Record<string, unknown>
  return {
    resolutionType,
    resolvedSummary: typeof input.resolvedSummary === "string" ? input.resolvedSummary.trim() : undefined,
    currentSummary: typeof input.currentSummary === "string" ? input.currentSummary.trim() : undefined,
    historicalSummary: typeof input.historicalSummary === "string" ? input.historicalSummary.trim() : undefined,
    reason: reason.trim(),
    confidence,
    actions: {
      createResolvedMemory: actionRecord.createResolvedMemory === true,
      oldMemoryStatus: normalizeMemoryStatus(actionRecord.oldMemoryStatus),
      newMemoryStatus: normalizeMemoryStatus(actionRecord.newMemoryStatus),
      shouldUpdateCoreMemory: actionRecord.shouldUpdateCoreMemory === true,
      shouldAskUser: actionRecord.shouldAskUser === true,
      clarificationNeeded: actionRecord.clarificationNeeded === true,
    },
  }
}

function normalizeMemoryStatus(value: unknown): MemoryConflictResolution["actions"]["oldMemoryStatus"] {
  if (value === "active" || value === "aging" || value === "archived" || value === "superseded" || value === "merged") {
    return value
  }
  return undefined
}

export async function buildResolverPayload(conflictLogId: string): Promise<ResolverPayload> {
  const store = await memoryStore.load()
  const conflictLog = (store.conflictLogs ?? []).find((log) => log.id === conflictLogId)
  if (!conflictLog) throw new Error(`conflict log not found: ${conflictLogId}`)

  const newMemory = store.l2.find((memory) => memory.id === conflictLog.sourceL2Id)
  const oldMemory = store.l2.find((memory) => memory.id === conflictLog.targetL2Id)
  if (!newMemory) throw new Error(`source memory not found: ${conflictLog.sourceL2Id}`)
  if (!oldMemory) throw new Error(`target memory not found: ${conflictLog.targetL2Id}`)

  return {
    conflictLog,
    newMemory,
    oldMemory,
    newEvidence: await memoryStore.getEvidenceByMemoryId(newMemory.id),
    oldEvidence: await memoryStore.getEvidenceByMemoryId(oldMemory.id),
    conflictScore: conflictLog.conflictScore ?? 0,
    scoringSignals: conflictLog.scoringSignals,
  }
}

export function buildResolverMessages(payload: ResolverPayload): Array<{ role: "system" | "user"; content: string }> {
  const formatSourceTimestamp = (value: number) => {
    const date = new Date(value)
    return `${date.toLocaleString("zh-CN", { hour12: false })}（${date.toISOString()}）`
  }
  const evidenceLines = (items: MemoryEvidence[]) => items.map((item) => (
    `- quote: ${item.quoteSnippet}\n  conversationId: ${item.conversationId ?? "unknown"}\n  sourceStatus: ${item.sourceStatus}`
  )).join("\n")
  const userPrompt = [
    "请判断以下两条用户记忆的关系，并只输出 JSON。",
    `候选类型：${payload.conflictLog.candidateType ?? "conflict"}`,
    payload.conflictLog.candidateType === "near_duplicate"
      ? "注意：高向量相似度不等于重复。时间变化、数量变化、列表新增项和条件变化都属于有效增量，必须保留；只有事实完全等价时才可合并。若生成合并摘要，必须覆盖两条记忆的全部有效细节。"
      : "",
    payload.conflictLog.candidateType === "state_transition"
      ? "注意：这可能是同一事件从计划/承诺推进到已发生/已完成。必须结合来源时间、类型和原文判断；同主题不等于同一事件。若确认已兑现，旧计划应退出 active，且不得在合并摘要中继续写成未来待办；无法确认时保持两条并标 uncertain。"
      : "",
    "通用时间规则：旧记忆正文或证据中的相对时间（今天、明天、昨天、刚才、最近等）必须以旧记忆的 sourceTime 为基准；新记忆中的相对时间必须以新记忆的 sourceTime 为基准。不得锚定到 Resolver 当前运行时间，也不得用新记忆的 sourceTime 重新解释旧记忆。若 sourceTime 是范围且不足以唯一判断相对时间指向，必须保留两条并标 uncertain，不要猜测或强行合并。",
    "",
    "旧记忆：",
    `summary: ${payload.oldMemory.content}`,
    `kind: ${payload.oldMemory.facets?.primaryKind ?? "unknown"}`,
    `sourceTime: ${formatSourceTimestamp(payload.oldMemory.sourceAt ?? payload.oldMemory.createdAt)}${payload.oldMemory.sourceEndAt ? ` .. ${formatSourceTimestamp(payload.oldMemory.sourceEndAt)}` : ""}`,
    "evidence:",
    evidenceLines(payload.oldEvidence) || "- none",
    "",
    "新记忆：",
    `summary: ${payload.newMemory.content}`,
    `kind: ${payload.newMemory.facets?.primaryKind ?? "unknown"}`,
    `sourceTime: ${formatSourceTimestamp(payload.newMemory.sourceAt ?? payload.newMemory.createdAt)}${payload.newMemory.sourceEndAt ? ` .. ${formatSourceTimestamp(payload.newMemory.sourceEndAt)}` : ""}`,
    "evidence:",
    evidenceLines(payload.newEvidence) || "- none",
    "",
    `conflictScore: ${payload.conflictScore}`,
    `scoringSignals: ${JSON.stringify(payload.scoringSignals ?? {})}`,
    "",
    "JSON 格式：",
    '{"resolutionType":"unrelated|context_difference|preference_evolution|direct_conflict|uncertain","resolvedSummary":"可选","currentSummary":"可选","historicalSummary":"可选","reason":"原因","confidence":0.0,"actions":{"createResolvedMemory":false,"oldMemoryStatus":"active|aging|archived|superseded|merged","newMemoryStatus":"active|aging|archived|superseded|merged","shouldUpdateCoreMemory":false,"shouldAskUser":false,"clarificationNeeded":false}}',
  ].join("\n")

  return [
    { role: "system", content: "你是谨慎的用户记忆关系 Resolver。你只根据 summary 和 evidence 判断冲突、演进、补充或重复，不要编造事实，只输出 JSON。" },
    { role: "user", content: userPrompt },
  ]
}

export async function callResolverLLM(
  settings: ResolverModelSettings,
  messages: Array<{ role: "system" | "user"; content: string }>,
  // 开思考后思考链计入同一预算，700 会被挤爆/截断（历史 "invalid resolver json" 根因）；
  // 与 judge 对齐给 8192。
  maxTokens = 8192,
): Promise<string> {
  if (!settings.apiKey) throw new Error("missing api key")
  const cfg: VendorConfig = {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: settings.apiKey,
    explicitTransport: settings.explicitTransport,
    // 与 judge/compressor 同理：kimi-k2.6 关思考时结构化判断直出空/无效结果，
    // 显式开思考保证冲突裁决质量（后台任务，可接受 40~72s 时延）。
    reasoning: { mode: "on" },
  }
  const adapter = getAdapterForConfig(cfg)
  const http = adapter.buildRequest({
    model: cfg.model,
    messages: messages as ChatMessage[],
    maxTokens,
    stream: false,
  }, cfg)
  // judge/compressor 都有超时保护，resolver 此前裸 fetch：请求挂起会永远阻塞
  // 串行队列里的后续任务。开思考 40~72s 量级，与 judge 对齐给 300s。
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 300000)
  try {
    const response = await fetch(http.url, {
      method: "POST",
      headers: http.headers,
      body: http.body,
      signal: controller.signal,
    })
    if (!response.ok) throw new Error(`resolver request failed: HTTP ${response.status}`)
    const data = await response.json()
    const parsed = adapter.parseResponse(data)
    if (parsed.usage) recordUsage(parsed.usage.input, parsed.usage.output, 1)
    return parsed.text ?? ""
  } finally {
    clearTimeout(timer)
  }
}

export async function resolvePayload(
  payload: ResolverPayload,
  deps: ResolverDeps,
): Promise<MemoryConflictResolution> {
  // 不显式传 maxTokens：思考链计入同一预算，历史硬编码 700 会把输出挤爆/截断，
  // 造成 "invalid resolver json"；走 callResolverLLM 的默认 8192。
  const raw = await deps.callLLM(buildResolverMessages(payload), 8192)
  const parsed = extractJsonObject(raw)
  const resolution = parsed ? normalizeResolution(parsed) : null
  if (!resolution) throw new Error("invalid resolver json")
  return resolution
}

async function markResolverProcessing(conflictLogId: string): Promise<void> {
  const store = await memoryStore.load()
  const log = (store.conflictLogs ?? []).find((entry) => entry.id === conflictLogId)
  if (!log) return
  log.resolverStatus = "processing"
  log.resolverStartedAt = Date.now()
  log.resolverAttemptCount = (log.resolverAttemptCount ?? 0) + 1
  await memoryStore.save(store)
  appendMemoryTrace({
    op: "resolver.queue.processing",
    layer: "L2",
    status: "ok",
    l2Id: log.sourceL2Id,
    ragId: log.sourceRagId,
    details: { conflictLogId: log.id, resolverAttemptCount: log.resolverAttemptCount },
  })
}

async function markResolverFailed(conflictLogId: string, error: unknown): Promise<void> {
  const store = await memoryStore.load()
  const log = (store.conflictLogs ?? []).find((entry) => entry.id === conflictLogId)
  if (!log) return
  log.resolverStatus = "failed"
  log.resolverFinishedAt = Date.now()
  await memoryStore.save(store)
  appendMemoryTrace({
    op: "resolver.queue.failed",
    layer: "L2",
    status: "error",
    l2Id: log.sourceL2Id,
    ragId: log.sourceRagId,
    details: { conflictLogId: log.id, resolverAttemptCount: log.resolverAttemptCount ?? 0 },
    error: error instanceof Error ? error.message : String(error),
  })
}

async function syncResolvedMemoryToRag(log: ConflictLog): Promise<void> {
  if (!log.resolutionMemoryId || !log.resolutionType) return
  const store = await memoryStore.load()
  const resolvedMemory = store.l2.find((memory) => memory.id === log.resolutionMemoryId)
  if (!resolvedMemory || resolvedMemory.syncStatus === "synced") return

  try {
    const ragId = await addL2MemoryVector(resolvedMemory.content, resolvedMemory.id, {
      source: "memory_resolver",
      conflictLogId: log.id,
      resolutionType: log.resolutionType,
      sourceL2Id: log.sourceL2Id,
      targetL2Id: log.targetL2Id,
    }, { createdAt: resolvedMemory.createdAt })
    await memoryStore.markL2SyncStatus(resolvedMemory.id, "synced", ragId)
  } catch (err) {
    await memoryStore.markL2SyncStatus(resolvedMemory.id, "sync_failed", undefined, err)
  }
}

export async function runResolverQueueOnce(deps?: ResolverDeps, options: ResolverRunOptions = {}): Promise<ResolverRunResult> {
  const [next] = await memoryStore.getResolverQueue(1)
  if (!next) return { status: "skip" }

  const now = options.now ?? Date.now()
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_RESOLVER_MIN_INTERVAL_MS
  if (lastResolverRunAt !== null && now - lastResolverRunAt < minIntervalMs) {
    appendMemoryTrace({
      op: "resolver.run.rate_limited",
      layer: "L2",
      status: "skip",
      l2Id: next.sourceL2Id,
      ragId: next.sourceRagId,
      details: {
        conflictLogId: next.id,
        elapsedMs: now - lastResolverRunAt,
        minIntervalMs,
      },
    })
    return { status: "rate_limited", conflictLogId: next.id }
  }
  lastResolverRunAt = now

  try {
    appendMemoryTrace({
      op: "resolver.run.start",
      layer: "L2",
      status: "ok",
      l2Id: next.sourceL2Id,
      ragId: next.sourceRagId,
      details: {
        conflictLogId: next.id,
        resolverPriority: next.resolverPriority,
        conflictScore: next.conflictScore,
        resolverAttemptCount: next.resolverAttemptCount ?? 0,
      },
    })
    await markResolverProcessing(next.id)
    const payload = await buildResolverPayload(next.id)
    const runner = deps ?? {
      callLLM: (messages: Array<{ role: "system" | "user"; content: string }>, maxTokens: number) => (
        callResolverLLM(loadResolverModelSettings(), messages, maxTokens)
      ),
    }
    const resolution = await resolvePayload(payload, runner)
    const appliedLog = await memoryStore.applyResolverResolution(next.id, resolution)
    if (appliedLog) await syncResolvedMemoryToRag(appliedLog)
    appendMemoryTrace({
      op: "resolver.run.success",
      layer: "L2",
      status: "ok",
      l2Id: next.sourceL2Id,
      ragId: next.sourceRagId,
      details: {
        conflictLogId: next.id,
        resolutionType: resolution.resolutionType,
        createdResolvedMemory: resolution.actions.createResolvedMemory === true,
      },
    })
    return { status: "resolved", conflictLogId: next.id }
  } catch (err) {
    await markResolverFailed(next.id, err)
    appendMemoryTrace({
      op: "resolver.run.failed",
      layer: "L2",
      status: "error",
      l2Id: next.sourceL2Id,
      ragId: next.sourceRagId,
      details: { conflictLogId: next.id },
      error: err instanceof Error ? err.message : String(err),
    })
    return {
      status: "failed",
      conflictLogId: next.id,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
