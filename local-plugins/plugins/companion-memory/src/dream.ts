import { randomUUID } from "node:crypto";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { validateEntry, type Entry } from "./entries";
import type { Evidence } from "./evidence";

const STATE_KEY = "dream-state";
const INJECTION_KEY = "dream-injection-enabled";
interface Narrative { id: string; text: string; createdAt: number; reviewId: string }
interface DreamReview { id: string; entryIds: string[]; entries: Entry[]; memoryRevision: number; narrative: string; status: "pending" | "dismissed" | "applied" | "undone" | "evicted"; createdAt: number; narrativeId?: string }
interface DreamState { version: 1; revision: number; narratives: Narrative[]; reviews: DreamReview[] }

function load(storage: PluginStorage): DreamState {
  const raw = storage.get<unknown>(STATE_KEY);
  if (raw === undefined) return { version: 1, revision: 0, narratives: [], reviews: [] };
  if (!raw || typeof raw !== "object") throw new Error("梦境状态损坏");
  const state = raw as Partial<DreamState>;
  if (state.version !== 1 || !Number.isSafeInteger(state.revision) || state.revision! < 0 || !Array.isArray(state.narratives) || state.narratives.length > 8 || !Array.isArray(state.reviews) || state.reviews.length > 30) throw new Error("梦境状态损坏");
  const narrativeIds = new Set<string>();
  for (const item of state.narratives) {
    if (!item || typeof item.id !== "string" || !item.id || narrativeIds.has(item.id) || typeof item.text !== "string" || item.text.length < 20 || item.text.length > 600 || !Number.isFinite(item.createdAt) || typeof item.reviewId !== "string" || !item.reviewId) throw new Error("梦境叙事损坏");
    narrativeIds.add(item.id);
  }
  const reviewIds = new Set<string>();
  for (const item of state.reviews) {
    if (!item || typeof item.id !== "string" || !item.id || reviewIds.has(item.id) || !Array.isArray(item.entryIds) || item.entryIds.length < 2 || item.entryIds.length > 20 || item.entryIds.some((id) => typeof id !== "string" || !id) || new Set(item.entryIds).size !== item.entryIds.length || !Array.isArray(item.entries) || item.entries.length !== item.entryIds.length || item.entries.some((entry, index) => entry.id !== item.entryIds[index]) || !Number.isSafeInteger(item.memoryRevision) || item.memoryRevision < 0 || typeof item.narrative !== "string" || item.narrative.length < 20 || item.narrative.length > 600 || !["pending", "dismissed", "applied", "undone", "evicted"].includes(item.status) || !Number.isFinite(item.createdAt) || (["applied", "undone", "evicted"].includes(item.status) && (typeof item.narrativeId !== "string" || !item.narrativeId))) throw new Error("梦境复核记录损坏");
    item.entries.forEach(validateEntry); reviewIds.add(item.id);
  }
  for (const narrative of state.narratives) {
    const review = state.reviews.find((item) => item.id === narrative.reviewId);
    if (!review || review.status !== "applied" || review.narrativeId !== narrative.id || review.narrative !== narrative.text) throw new Error("梦境叙事关联损坏");
  }
  if (state.reviews.some((review) => review.status === "applied" && !state.narratives!.some((narrative) => narrative.id === review.narrativeId))) throw new Error("梦境叙事关联损坏");
  return structuredClone(state as DreamState);
}

function sameEntry(left: Entry, right: Entry) { return JSON.stringify(left) === JSON.stringify(right); }

export function createDream(storage: PluginStorage) {
  // 本地版只要存在 Dream 叙事就会注入；缺省值因此为开启。仍保留显式
  // 关闭入口，方便用户临时停用，而不会删除已经生成的叙事。
  let injectionEnabled = storage.get<boolean>(INJECTION_KEY) ?? true;
  if (typeof injectionEnabled !== "boolean") throw new Error("梦境注入设置损坏");
  let state = load(storage);
  const save = (next: Omit<DreamState, "revision">) => {
    const required = new Set(next.narratives.map((narrative) => narrative.reviewId));
    const optionalSlots = 30 - required.size, optional = new Set(next.reviews.filter((review) => !required.has(review.id)).slice(-optionalSlots).map((review) => review.id));
    const reviews = next.reviews.filter((review) => required.has(review.id) || optional.has(review.id));
    state = { ...next, reviews, revision: state.revision + 1 }; storage.set(STATE_KEY, state);
  };
  const reviewForStatuses = async (raw: any, entries: Entry[], evidence: Evidence[], memoryRevision: number, generate: (prompt: string) => Promise<string>, signal: AbortSignal, allowedStatuses: Set<Entry["status"]>) => {
    if (!raw || raw.revision !== memoryRevision || !Array.isArray(raw.entryIds) || raw.entryIds.length < 2 || raw.entryIds.length > 20 || raw.entryIds.some((id: unknown) => typeof id !== "string") || new Set(raw.entryIds).size !== raw.entryIds.length) throw new Error("梦境候选参数无效或记忆已变化");
    const byId = new Map(entries.map((entry) => [entry.id, entry])), selected: Array<Entry | undefined> = raw.entryIds.map((id: string) => byId.get(id));
    if (selected.some((entry) => !entry || !allowedStatuses.has(entry.status) || entry.pinned || entry.supersededBy || entry.mergedInto)) throw new Error("梦境只接受本轮允许状态、未置顶且未被取代或合并的记忆");
    const snapshots = structuredClone(selected as Entry[]);
    const blocks = snapshots.map((entry, index) => {
      const linked = evidence.filter((item) => item.memoryId === entry.id && item.sourceStatus !== "deleted").slice(0, 2).map((item) => item.quoteSnippet.slice(0, 500));
      return [`C${index + 1}: ${entry.content}`, entry.quote ? `原话提示：${entry.quote.slice(0, 500)}` : "", `来源时间：${new Date(entry.sourceAt).toISOString()}${entry.sourceEndAt ? ` 至 ${new Date(entry.sourceEndAt).toISOString()}` : ""}`, ...linked.map((text) => `关联证据：${text}`)].filter(Boolean).join("\n");
    });
    const prompt = ["请把以下逐渐淡出活跃层的记忆，整理成一段 150 至 300 字的第一人称陪伴反思。", "只能基于材料，不得补充新事实；专有名词、数字和不确定性原样保留。语气温柔克制，不要标题、列表或解释。直接输出正文。", ...blocks].join("\n\n");
    const result = (await generate(prompt)).replace(/^[\s\"「『]+|[\s\"」』]+$/g, "").trim();
    if (signal.aborted) throw new Error("梦境复核已取消");
    if (result.length < 20 || result.length > 600) throw new Error("梦境叙事输出无效");
    const review: DreamReview = { id: randomUUID(), entryIds: [...raw.entryIds], entries: snapshots, memoryRevision, narrative: result, status: "pending", createdAt: Date.now() };
    save({ version: 1, narratives: state.narratives, reviews: [...state.reviews, review] });
    return structuredClone(review);
  };
  return {
    view() { return structuredClone({ ...state, injectionEnabled }); },
    setInjection(value: unknown) { if (typeof value !== "boolean") throw new Error("梦境注入设置无效"); storage.set(INJECTION_KEY, value); injectionEnabled = value; return this.view(); },
    async review(raw: any, entries: Entry[], evidence: Evidence[], memoryRevision: number, generate: (prompt: string) => Promise<string>, signal: AbortSignal) {
      return reviewForStatuses(raw, entries, evidence, memoryRevision, generate, signal, new Set(["aging"]));
    },
    async reviewCycle(raw: any, entries: Entry[], evidence: Evidence[], memoryRevision: number, generate: (prompt: string) => Promise<string>, signal: AbortSignal) {
      return reviewForStatuses(raw, entries, evidence, memoryRevision, generate, signal, new Set(["aging", "archived"]));
    },
    resolve(raw: any, entries: Entry[], memoryRevision: number) {
      if (!raw || typeof raw.id !== "string" || !["dismiss", "apply", "undo"].includes(raw.action)) throw new Error("梦境复核操作无效");
      const review = state.reviews.find((item) => item.id === raw.id);
      if (!review) throw new Error("梦境复核不存在");
      if (raw.action === "dismiss") {
        if (review.status !== "pending") throw new Error("梦境复核操作无效");
        save({ version: 1, narratives: state.narratives, reviews: state.reviews.map((item) => item.id === review.id ? { ...item, status: "dismissed" as const } : item) });
        return this.view();
      }
      const byId = new Map(entries.map((entry) => [entry.id, entry]));
      if (review.entries.some((snapshot) => !byId.has(snapshot.id) || !sameEntry(snapshot, byId.get(snapshot.id)!))) throw new Error("梦境来源记忆已变化，拒绝应用");
      if (raw.action === "apply") {
        if (review.status !== "pending") throw new Error("梦境复核操作无效");
        const narrative: Narrative = { id: randomUUID(), text: review.narrative, createdAt: Date.now(), reviewId: review.id };
        const narratives = [...state.narratives, narrative].slice(-8), retained = new Set(narratives.map((item) => item.id));
        save({ version: 1, narratives, reviews: state.reviews.map((item) => item.id === review.id ? { ...item, status: "applied" as const, narrativeId: narrative.id } : item.status === "applied" && item.narrativeId && !retained.has(item.narrativeId) ? { ...item, status: "evicted" as const } : item) });
        return this.view();
      }
      if (review.status !== "applied" || !review.narrativeId) throw new Error("这条梦境叙事不能撤销");
      const narrative = state.narratives.find((item) => item.id === review.narrativeId);
      if (!narrative || narrative.text !== review.narrative || narrative.reviewId !== review.id) throw new Error("梦境叙事已变化，拒绝撤销");
      save({ version: 1, narratives: state.narratives.filter((item) => item.id !== narrative.id), reviews: state.reviews.map((item) => item.id === review.id ? { ...item, status: "undone" as const } : item) });
      return this.view();
    },
    context() {
      if (!injectionEnabled || !state.narratives.length) return "";
      return `[长期陪伴叙事]\n${state.narratives.slice(-3).map((item) => `· ${item.text}`).join("\n")}\n（这是你在梦里沉淀下来的关系印象，可作为语气与默契的背景，不要逐字复述）`;
    },
  };
}
