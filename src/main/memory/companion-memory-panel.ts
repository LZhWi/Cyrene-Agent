import type { ImportedDocItem, MemoryPanelItem } from "./panel";

const L0_KEYS = ["preferredName", "occupation", "longTermInterests", "language", "permanentNote"] as const;
const L1_KEYS = ["recentGoals", "recentPreferences", "currentProject"] as const;
type ProfileKey = typeof L0_KEYS[number] | typeof L1_KEYS[number];

interface ProfileFact { content?: unknown }
interface CompanionEntry {
  id?: unknown;
  content?: unknown;
  quote?: unknown;
  triggerText?: unknown;
  sourceQuote?: unknown;
  status?: unknown;
  sourceAt?: unknown;
  sourceEndAt?: unknown;
  confidence?: unknown;
  importance?: unknown;
  pinned?: unknown;
}
interface CompanionState {
  revision?: unknown;
  profiles?: { l0?: Record<string, ProfileFact>; l1?: Record<string, ProfileFact> };
  entries?: CompanionEntry[];
  profileChanges?: Array<Record<string, unknown>>;
  entryReviews?: Array<Record<string, unknown>>;
  compressionReviews?: Array<Record<string, unknown>>;
}

export type CompanionMemoryInvoke = (action: string, data?: unknown) => Promise<unknown>;

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("companion-memory 返回了无效数据");
  return value as Record<string, unknown>;
}

function unwrapUiResult(value: unknown): CompanionState {
  const result = asRecord(value);
  if (result.ok !== true) throw new Error(typeof result.error === "string" ? result.error : "companion-memory 操作失败");
  return asRecord(result.data) as CompanionState;
}

function text(value: unknown): string { return typeof value === "string" ? value : ""; }
function timestamp(value: unknown): number { return typeof value === "number" && Number.isFinite(value) ? value : 0; }

function profileValues(keys: readonly ProfileKey[], layer: Record<string, ProfileFact> | undefined): Record<ProfileKey, string> {
  return Object.fromEntries(keys.map((key) => [key, text(layer?.[key]?.content)])) as Record<ProfileKey, string>;
}

function entryWeight(entry: CompanionEntry): number {
  if (typeof entry.confidence === "number" && Number.isFinite(entry.confidence)) return entry.confidence;
  if (entry.importance === "high") return 1;
  if (entry.importance === "medium") return 0.7;
  if (entry.importance === "low") return 0.4;
  return entry.pinned === true ? 1 : 0.5;
}

function reflectionItems(state: CompanionState): MemoryPanelItem[] {
  const items: Array<MemoryPanelItem & { at: number }> = [];
  for (const change of state.profileChanges ?? []) {
    const after = asRecord(change.after ?? {});
    const at = timestamp(after.sourceAt);
    items.push({
      id: text(change.id) || `profile-${items.length}`,
      title: `${change.layer === "L0" ? "画像" : "近况"}变更 · ${text(change.status) || "unknown"}`,
      body: text((after as Record<string, unknown>).content),
      meta: at ? new Date(at).toLocaleString() : "",
      at,
    });
  }
  for (const review of state.entryReviews ?? []) {
    const left = asRecord(review.left ?? {}), right = asRecord(review.right ?? {});
    const at = Math.max(timestamp(left.sourceAt), timestamp(right.sourceAt));
    items.push({
      id: text(review.id) || `entry-review-${items.length}`,
      title: `记忆复核 · ${text(review.status) || "unknown"}`,
      body: [text(review.reason), text(left.content), text(right.content)].filter(Boolean).join("\n"),
      meta: at ? new Date(at).toLocaleString() : "",
      at,
    });
  }
  for (const review of state.compressionReviews ?? []) {
    const at = timestamp(review.createdAt);
    items.push({
      id: text(review.id) || `compression-${items.length}`,
      title: `片段压缩 · ${text(review.status) || "unknown"}`,
      body: [text(review.summary), text(review.reason)].filter(Boolean).join("\n"),
      meta: at ? new Date(at).toLocaleString() : "",
      at,
    });
  }
  return items.sort((a, b) => b.at - a.at).map(({ at: _at, ...item }) => item);
}

export async function loadCompanionMemoryPanelData(
  invoke: CompanionMemoryInvoke,
  importedDocs: ImportedDocItem[],
) {
  const state = unwrapUiResult(await invoke("state"));
  const l0 = profileValues(L0_KEYS, state.profiles?.l0);
  const l1 = profileValues(L1_KEYS, state.profiles?.l1);
  const l2 = (state.entries ?? []).map((entry, index) => ({
    id: text(entry.id) || `entry-${index}`,
    content: text(entry.content),
    triggerText: text(entry.sourceQuote) || text(entry.triggerText) || text(entry.quote),
    status: text(entry.status) || "active",
    weight: entryWeight(entry),
    createdAt: timestamp(entry.sourceAt),
    sourceAt: timestamp(entry.sourceAt),
    ...(timestamp(entry.sourceEndAt) ? { sourceEndAt: timestamp(entry.sourceEndAt) } : {}),
  })).sort((a, b) => b.createdAt - a.createdAt);
  return { l0, l1, l2, importedDocs, reflections: reflectionItems(state) };
}

function requireRevision(state: CompanionState): number {
  const revision = state.revision;
  if (!Number.isSafeInteger(revision) || (revision as number) < 0) throw new Error("companion-memory revision 无效");
  return revision as number;
}

function findEntry(state: CompanionState, id: string): CompanionEntry {
  const entry = (state.entries ?? []).find((candidate) => text(candidate.id) === id);
  if (!entry) throw new Error("记忆不存在或已被删除");
  return entry;
}

export async function editCompanionMemoryEntry(
  invoke: CompanionMemoryInvoke,
  rawId: unknown,
  rawContent: unknown,
): Promise<{ ok: true; indexed: true }> {
  const id = text(rawId).trim();
  const content = text(rawContent).trim();
  if (!id) throw new Error("记忆 ID 不能为空");
  if (!content) throw new Error("记忆内容不能为空");
  if (content.length > 2000) throw new Error("记忆内容不能超过 2000 个字符");

  const state = unwrapUiResult(await invoke("state"));
  const entry = findEntry(state, id);
  unwrapUiResult(await invoke("edit-entry", {
    id,
    content,
    pinned: entry.pinned === true,
    status: text(entry.status) || "active",
    revision: requireRevision(state),
  }));
  return { ok: true, indexed: true };
}

export async function deleteCompanionMemoryEntry(
  invoke: CompanionMemoryInvoke,
  rawId: unknown,
): Promise<{ ok: true; deleted: true; deletedVectors: 0 }> {
  const id = text(rawId).trim();
  if (!id) throw new Error("记忆 ID 不能为空");

  const state = unwrapUiResult(await invoke("state"));
  findEntry(state, id);
  unwrapUiResult(await invoke("delete-entry", { id, revision: requireRevision(state) }));
  return { ok: true, deleted: true, deletedVectors: 0 };
}

export async function saveCompanionProfile(
  invoke: CompanionMemoryInvoke,
  layer: "L0" | "L1",
  raw: Record<string, unknown>,
): Promise<void> {
  let state = unwrapUiResult(await invoke("state"));
  const keys = layer === "L0" ? L0_KEYS : L1_KEYS;
  const facts = layer === "L0" ? state.profiles?.l0 : state.profiles?.l1;
  for (const key of keys) {
    if (typeof raw[key] !== "string") continue;
    const content = raw[key].trim();
    if (content === text(facts?.[key]?.content)) continue;
    state = unwrapUiResult(await invoke("edit-profile", { layer, field: key, content, revision: requireRevision(state) }));
  }
}
