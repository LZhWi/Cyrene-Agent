import type { ConflictLog, L2Memory } from "./memory-types"
import type { LongTermShadowEvidence } from "./long-term-reflection-shadow"

export interface ShadowSourceMessage {
  key: string
  conversationId: string
  role: string
  content: string
  at: number
}

export function normalizeShadowQuote(text: string): string {
  return text.replace(/\[sticker:[^\]]*\]/gi, "")
    .replace(/[（(]用户发送表情包[：:][^）)]*[）)]/g, "")
    .toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, "")
}

// Role labels and sticker wrappers are transport text, not user evidence.
function userFragments(quote: string): string[] {
  const parts = quote.split(/(用户|AI|助手|assistant|user)\s*[：:]/gi)
  const userParts = [parts[0]]
  for (let i = 1; i < parts.length; i += 2) {
    if (/^(用户|user)$/i.test(parts[i])) userParts.push(parts[i + 1] ?? "")
  }
  return userParts.flatMap((part) => part
    .replace(/\[sticker:[^\]]*\]/gi, "")
    .replace(/[（(]用户发送表情包[：:][^）)]*[）)]/g, "")
    .split(/…+|\.{3,}|\n| \/ /))
    .map((part) => part.trim())
    .filter((part) => normalizeShadowQuote(part).length >= 8)
}

export function groundShadowMemory(
  memory: Pick<L2Memory, "sourceQuote" | "triggerText" | "sourceAt" | "sourceEndAt" | "sourceConversationId">,
  messages: ReadonlyArray<ShadowSourceMessage>,
): { fragments: string[]; matches: ShadowSourceMessage[]; reason?: string } {
  const start = memory.sourceAt
  const end = memory.sourceEndAt ?? start
  if (!Number.isFinite(start) || !Number.isFinite(end) || end! < start!) {
    return { fragments: [], matches: [], reason: "invalid source range" }
  }
  const fragments = userFragments(memory.sourceQuote || memory.triggerText || "")
  if (!fragments.length) return { fragments, matches: [], reason: "no substantial user quote" }
  const candidates = messages.filter((m) => m.role === "user"
    && (!memory.sourceConversationId || m.conversationId === memory.sourceConversationId)
    && m.at >= start! - 300000 && m.at <= end! + 300000)
  const matched = new Map<string, ShadowSourceMessage>()
  for (const fragment of fragments) {
    const normalized = normalizeShadowQuote(fragment)
    const hits = candidates.filter((m) => normalizeShadowQuote(m.content).includes(normalized))
    if (hits.length !== 1) return { fragments, matches: [], reason: hits.length ? "ambiguous quote" : "quote not found in source range" }
    matched.set(hits[0].key, hits[0])
  }
  return { fragments, matches: [...matched.values()].sort((a, b) => a.at - b.at) }
}

function settled(log: ConflictLog): boolean {
  return !log.clarificationNeeded && !log.shouldAskUser && (log.status === "dismissed"
    || (log.status === "resolved" && log.resolutionType !== "uncertain"))
}

export function prepareShadowEvidence(
  memories: ReadonlyArray<L2Memory>,
  messages: ReadonlyArray<ShadowSourceMessage>,
  logs: ReadonlyArray<ConflictLog>,
  now: number,
): { evidence: LongTermShadowEvidence[]; excluded: Array<{ id: string; reason: string }> } {
  const evidence: LongTermShadowEvidence[] = []
  const excluded: Array<{ id: string; reason: string }> = []
  const occupied = new Set<string>()
  for (const memory of [...memories].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id))) {
    let reason = ""
    if (!["active", "aging"].includes(memory.status) || memory.mergedInto || memory.supersededBy) reason = "inactive or replaced"
    else if (memory.isSummary) reason = "summary is not independent evidence"
    else if ((memory.validTo != null && memory.validTo <= now) || (memory.validFrom != null && memory.validFrom > now)) reason = "outside validity window"
    else if (!Number.isFinite(memory.createdAt) || !memory.content?.trim()) reason = "invalid memory"
    const related = logs.filter((log) => log.sourceL2Id === memory.id || log.targetL2Id === memory.id)
    const latestByPair = new Map<string, ConflictLog>()
    for (const log of [...related].sort((a, b) => a.createdAt - b.createdAt)) {
      latestByPair.set([log.sourceL2Id, log.targetL2Id].sort().join("|"), log)
    }
    if (!reason && [...latestByPair.values()].some((log) => !settled(log))) reason = "unresolved conflict or relationship"
    if (!reason && memory.conflictWith?.some((ragId) => {
      const peer = memories.find((m) => m.ragId === ragId)
      const log = peer && latestByPair.get([memory.id, peer.id].sort().join("|"))
      return !log || !settled(log)
    })) reason = "unverified conflict flag"
    const grounded = reason ? undefined : groundShadowMemory(memory, messages)
    if (!reason && grounded?.reason) reason = grounded.reason
    if (!reason && grounded?.matches.some((m) => occupied.has(m.key))) reason = "overlapping source messages"
    if (reason || !grounded?.matches.length) {
      excluded.push({ id: memory.id, reason: reason || "missing source" })
      continue
    }
    for (const message of grounded.matches) occupied.add(message.key)
    evidence.push({
      id: memory.id, content: memory.content.trim(), sourceQuote: grounded.fragments.join(" / "),
      sourceAt: grounded.matches[0].at, sourceEndAt: grounded.matches.at(-1)!.at,
      createdAt: memory.createdAt, sourceKeys: grounded.matches.map((m) => m.key),
      primaryKind: memory.facets?.primaryKind ?? "unknown", grounding: "normalized",
    })
  }
  return { evidence: evidence.sort((a, b) => a.sourceAt - b.sourceAt), excluded }
}
