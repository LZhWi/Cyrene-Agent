import type { Turn } from "../../companion-chat/src/chat";
import { isRecallable, type Entry } from "./entries";
import type { ExtractedMemoryCandidate } from "./memory-extraction";

export function relatedMemories(entries: Entry[], prior: Turn[]): Entry[] {
  return entries.filter(entry => !entry.pinned && !entry.isSummary && entry.editedAt === undefined
    && entry.provenance === "verified" && isRecallable(entry, Date.now())
    && prior.some(turn => turn.sessionId === entry.sessionId && (
      entry.sourceEvidence?.some(e => e.turnId === turn.id && turn.user.includes(e.quote))
      || (entry.turnId === turn.id && Boolean(entry.quote) && turn.user.includes(entry.quote))
    )));
}

export function bindExtractionEvidence(candidate: ExtractedMemoryCandidate, turns: Turn[], writable: Turn[]) {
  const evidence = candidate.evidenceQuotes.map(quote => {
    const matches = turns.filter(turn => turn.user.includes(quote));
    if (matches.length !== 1) throw new Error("用户证据无法唯一逐字匹配");
    return { turnId: matches[0].id, quote };
  });
  const sources = turns.filter(turn => evidence.some(e => e.turnId === turn.id));
  if (!sources.some(turn => writable.some(item => item.id === turn.id))) throw new Error("新事实缺少可写轮次证据");
  if (candidate.evidenceTurnRefs.some(ref => {
    const turn = turns[Number(ref.slice(1)) - 1];
    return !turn || !sources.some(source => source.id === turn.id);
  })) throw new Error("轮次引用与逐字证据不符");
  return { evidence, sources };
}

export function patchMemory(entry: Entry, candidate: ExtractedMemoryCandidate): string {
  if (candidate.memoryAction === "supplement") {
    if (entry.content.includes(candidate.content)) throw new Error("补充内容已被旧记忆覆盖");
    const content = `${entry.content}\n补充：${candidate.content}`;
    if (content.length > 1500) throw new Error("补充后记忆过长");
    return content;
  }
  const fragment = candidate.replaceText;
  if (candidate.memoryAction !== "correct" || !fragment || !entry.content.includes(fragment)
    || entry.content.indexOf(fragment) !== entry.content.lastIndexOf(fragment)
    || candidate.certainty !== "explicit" || candidate.attribution !== "user_explicit"
    || !candidate.evidenceQuotes.some(quote => /纠正|更正|改成|改为|改到|说错|记错|不对|不是/u.test(quote))) {
    throw new Error("纠正必须有明确用户证据和唯一替换片段");
  }
  const content = entry.content.replace(fragment, () => candidate.content);
  if (content.length > 1500) throw new Error("纠正后记忆过长");
  return content;
}
