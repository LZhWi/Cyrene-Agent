import { createHash } from "crypto"
import type { L2Memory, MemoryCandidate, MemoryJudgeContext, MemoryJudgeTurn, MemoryReviewTarget } from "./memory-types"

export function assertNoTemporaryTurnRefs(text: string): void {
  if (/\bT[1-8]\b/u.test(text)) throw new Error("记忆正文不能包含临时轮次编号；请仅在 evidenceTurnRefs 中引用")
}

export function memoryContentVersion(memory: L2Memory): string {
  return createHash("sha256").update(JSON.stringify([
    memory.id, memory.contentRevision ?? 0, memory.content, memory.status, memory.isPinned,
    memory.sourceConversationId, memory.sourceMessageIds, memory.sourceEvidence,
    memory.sourceQuote, memory.validTo, memory.supersededBy, memory.mergedInto,
  ])).digest("hex")
}

export function relatedMemoryTargets(memories: L2Memory[], prior: MemoryJudgeTurn[], conversationId: string): MemoryReviewTarget[] {
  return memories.filter(memory => !memory.isPinned && (memory.status === "active" || memory.status === "aging")
    && memory.sourceConversationId === conversationId
    && prior.some(turn => memory.sourceMessageIds?.includes(turn.userMessageId ?? "")
      && memory.sourceEvidence?.some(e => e.conversationId === conversationId && e.messageId === turn.userMessageId
        && (turn.sourceUserText ?? turn.userInput).includes(e.quote))))
    .map(memory => ({ id: memory.id, content: memory.content, version: memoryContentVersion(memory),
      sourceMessageIds: [...(memory.sourceMessageIds ?? [])] }))
}

/** 逐条原文定位，不做标点删除、模糊匹配或省略号拼接。 */
export function bindCandidateEvidence(candidate: MemoryCandidate, turns: MemoryJudgeTurn[], conversationId: string): MemoryCandidate {
  assertNoTemporaryTurnRefs(candidate.content)
  if (!candidate.evidenceQuotes?.length) throw new Error("缺少用户原文证据")
  const matched = candidate.evidenceQuotes.map(quote => {
    const matches = turns.map((turn, index) => ({ turn, index }))
      .filter(({ turn }) => quote.trim() && (turn.sourceUserText ?? turn.userInput).includes(quote))
    if (matches.length !== 1) throw new Error("证据必须逐字且唯一匹配一条用户消息；多段原文请分别输出")
    const match = matches[0]
    if (!match.turn.userMessageId || match.turn.conversationId !== conversationId) throw new Error("证据缺少可靠消息 ID")
    return { ...match, quote }
  })
  const refs = [...new Set(matched.map(m => `T${m.index + 1}`))]
  if (candidate.evidenceTurnRefs?.some(ref => !refs.includes(ref))) throw new Error("临时引用与原文证据不一致")
  const times = matched.map(m => m.turn.userAt).filter((at): at is number => typeof at === "number" && Number.isFinite(at))
  return { ...candidate, triggerText: candidate.evidenceQuotes[0],
    sourceQuote: candidate.evidenceQuotes.join("\n"), evidenceTurnRefs: refs,
    sourceConversationId: conversationId, sourceMessageIds: [...new Set(matched.map(m => m.turn.userMessageId!))],
    sourceEvidence: matched.map(m => ({ conversationId, messageId: m.turn.userMessageId!, quote: m.quote })),
    ...(times.length ? { sourceAt: Math.min(...times), sourceEndAt: Math.max(...times) } : {}),
  }
}

export function applyMemoryContentPatch(existing: string, candidate: MemoryCandidate): string {
  assertNoTemporaryTurnRefs(candidate.content)
  if (!candidate.content.trim()) throw new Error("更新内容不能为空")
  if (candidate.memoryAction === "supplement") {
    if (existing.includes(candidate.content)) throw new Error("该补充已被原记忆覆盖，请改为 keep")
    return `${existing}\n补充：${candidate.content}`
  }
  if (candidate.memoryAction !== "correct" || !candidate.replaceText
    || !existing.includes(candidate.replaceText)
    || existing.indexOf(candidate.replaceText) !== existing.lastIndexOf(candidate.replaceText)) {
    throw new Error("纠正必须指定唯一匹配的旧内容片段")
  }
  if (candidate.certainty !== "explicit" || candidate.attribution !== "user_explicit"
    || !candidate.evidenceQuotes?.some(q => /纠正|更正|改成|改为|改到|说错|记错|不对|不是/u.test(q))) {
    throw new Error("替换旧内容需要用户明确纠正的原文证据")
  }
  return existing.replace(candidate.replaceText, () => candidate.content)
}

export function validateIncrementalCandidates(
  rows: unknown[], normalize: (row: unknown) => MemoryCandidate | null,
  turns: MemoryJudgeTurn[], conversationId: string, context: MemoryJudgeContext,
): MemoryCandidate[] {
  const reviewed = new Set<string>()
  const candidates: MemoryCandidate[] = []
  for (const value of rows) {
    if (!value || typeof value !== "object") throw new Error("候选必须为对象")
    const row = value as Record<string, unknown>
    const action = row.memoryAction ?? "add"
    if (!["keep", "add", "supplement", "correct"].includes(String(action))) throw new Error("无效记忆操作")
    const target = context.previousMemories.find(m => m.id === row.targetMemoryId)
    if (action !== "add") {
      if (!target || reviewed.has(target.id)) throw new Error("每个已提供的记忆 ID 必须且只能审阅一次")
      reviewed.add(target.id)
      if (action === "keep") continue
    } else if (row.targetMemoryId) throw new Error("新增不能指定旧记忆 ID")
    const normalized = normalize(value)
    if (!normalized) {
      if (action === "add" && row.shouldWrite === false) continue
      throw new Error("候选字段无效，请修正原格式；无值得记录的信息可省略新增候选")
    }
    const candidate = bindCandidateEvidence(normalized, turns, conversationId)
    candidate.memoryAction = action as MemoryCandidate["memoryAction"]
    if (target) {
      if (candidate.layer !== "L2") throw new Error("补充和纠正只适用于 L2")
      candidate.targetMemoryId = target.id
      candidate.targetVersion = target.version
      candidate.replaceText = typeof row.replaceText === "string" ? row.replaceText : undefined
      applyMemoryContentPatch(target.content, candidate)
    }
    candidates.push(candidate)
  }
  if (reviewed.size !== context.previousMemories.length) throw new Error("请逐条输出所有已提供记忆的保留、补充或纠正决定")
  return candidates
}
