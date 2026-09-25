import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";

interface VectorRecord { l2Id: string; embedding: number[]; origin?: "legacy" | "generated"; contentHash?: string; weight?: number; lastRecalledAt?: number }
interface VectorState { version: 1; sourceHash: string; sourceBytes: number; dimensions: number; entries: VectorRecord[]; importedAt: number; legacy?: boolean }
interface VectorView { sourceHash?: string; importedAt?: number; imported: boolean; entries: number; legacyEntries: number; generatedEntries: number; dimensions?: number }
const RELATED_PAIR_ENTRY_LIMIT = 300;
export interface LegacyVectorPreview { sourceHash: string; sourceBytes: number; total: number; userMemory: number; usable: number; invalid: number; duplicateL2Ids: number; unmatchedL2Ids: number; dimensions: number[]; canImport: boolean }
export const defaultLegacyVectorPath = () => path.join(homedir(), "AppData", "Roaming", "live2d-cyrene", "rag-data", "memory-store.json");

function readVectorFile(file: unknown) {
  if (typeof file !== "string" || !path.isAbsolute(file) || path.basename(file).toLowerCase() !== "memory-store.json" || file.length > 2048) throw new Error("请选择名为 memory-store.json 的绝对路径");
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 128 * 1024 * 1024 || path.normalize(realpathSync(file)).toLowerCase() !== path.normalize(file).toLowerCase()) throw new Error("向量源文件类型、大小或路径校验失败");
  const buffer = readFileSync(file); let raw: any;
  try { raw = JSON.parse(buffer.toString("utf8")); } catch { throw new Error("向量源 JSON 无法解析（不输出原文）"); }
  if (!Array.isArray(raw)) throw new Error("向量源格式不兼容");
  return { raw, hash: createHash("sha256").update(buffer).digest("hex"), bytes: buffer.length };
}
function analyze(source: ReturnType<typeof readVectorFile>, allowedIds: Set<string>) {
  const candidates = source.raw.filter((item: any) => item?.source === "user_memory");
  const ids = new Set<string>(), duplicates = new Set<string>(), dimensions = new Set<number>();
  let invalid = 0, unmatchedL2Ids = 0; const entries: VectorRecord[] = [];
  for (const item of candidates) {
    const id = item?.metadata?.l2Id, vector = item?.embedding;
    if (typeof id !== "string" || !id || !Array.isArray(vector) || vector.length < 64 || vector.length > 8192 || vector.some((n: any) => !Number.isFinite(n))) { invalid++; continue; }
    dimensions.add(vector.length); if (ids.has(id)) duplicates.add(id); ids.add(id);
    if (!allowedIds.has(id)) { unmatchedL2Ids++; continue; }
    entries.push({ l2Id: id, embedding: vector, weight: Number.isFinite(item?.weight) ? Math.min(5, Math.max(0, item.weight)) : 1, lastRecalledAt: Number.isFinite(item?.lastRecalledAt) && item.lastRecalledAt >= 0 ? item.lastRecalledAt : Date.now() });
  }
  const canImport = invalid === 0 && duplicates.size === 0 && dimensions.size === 1 && entries.length > 0;
  const preview: LegacyVectorPreview = { sourceHash: source.hash, sourceBytes: source.bytes, total: source.raw.length, userMemory: candidates.length, usable: entries.length, invalid, duplicateL2Ids: duplicates.size, unmatchedL2Ids, dimensions: [...dimensions].sort((a,b) => a-b), canImport };
  return { preview, entries };
}
export function previewLegacyVectorFile(file: unknown, allowedIds: string[]): LegacyVectorPreview {
  return analyze(readVectorFile(file), new Set(allowedIds)).preview;
}
function validateState(value: any): asserts value is VectorState {
  if (!value || value.version !== 1 || !/^[a-f0-9]{64}$/.test(value.sourceHash) || !Number.isSafeInteger(value.sourceBytes) || !Number.isSafeInteger(value.dimensions) || !Array.isArray(value.entries) || !Number.isFinite(value.importedAt)) throw new Error("向量索引存储损坏");
  const ids = new Set<string>();
  for (const item of value.entries) {
    if (!item || typeof item.l2Id !== "string" || ids.has(item.l2Id) || !Array.isArray(item.embedding) || item.embedding.length !== value.dimensions || item.embedding.some((n: any) => !Number.isFinite(n))
      || (item.origin !== undefined && !["legacy", "generated"].includes(item.origin))
      || (item.contentHash !== undefined && !/^[a-f0-9]{64}$/.test(item.contentHash))
      || (item.weight !== undefined && (!Number.isFinite(item.weight) || item.weight < 0 || item.weight > 5))
      || (item.lastRecalledAt !== undefined && (!Number.isFinite(item.lastRecalledAt) || item.lastRecalledAt < 0))
      || (item.origin === "generated" && !item.contentHash)) throw new Error("向量索引存储损坏");
    ids.add(item.l2Id);
  }
}
export function createVectorIndex(storage: PluginStorage) {
  let state = storage.get<VectorState>("vector-index"); if (state) validateState(state);
  return {
    view(): VectorView { return state ? { imported: state.legacy !== false, entries: state.entries.length, legacyEntries: state.entries.filter((entry) => entry.origin !== "generated").length, generatedEntries: state.entries.filter((entry) => entry.origin === "generated").length, dimensions: state.dimensions, ...(state.legacy !== false ? { sourceHash: state.sourceHash, importedAt: state.importedAt } : {}) } : { imported: false, entries: 0, legacyEntries: 0, generatedEntries: 0 }; },
    importLegacy(file: unknown, expectedHash: unknown, allowedIds: string[]) {
      if ((state && state.legacy !== false) || storage.get("vector-index-pre-legacy-import-backup") !== undefined) throw new Error("旧向量索引已导入或已有导入备份，拒绝覆盖");
      if (typeof expectedHash !== "string" || !/^[a-f0-9]{64}$/.test(expectedHash)) throw new Error("向量预检快照标识无效");
      const source = readVectorFile(file); if (source.hash !== expectedHash) throw new Error("向量源文件自预检后已变化，请重新预检");
      const plan = analyze(source, new Set(allowedIds)); if (!plan.preview.canImport) throw new Error("向量源未通过导入门禁");
      const dimensions = plan.preview.dimensions[0];
      if (state && state.dimensions !== dimensions) throw new Error("旧向量维度与现有生成索引不一致");
      const generatedIds = new Set(state?.entries.filter((entry) => entry.origin === "generated").map((entry) => entry.l2Id) ?? []);
      const next: VectorState = { version: 1, sourceHash: source.hash, sourceBytes: source.bytes, dimensions, entries: [...(state?.entries ?? []), ...plan.entries.filter((entry) => !generatedIds.has(entry.l2Id)).map((entry) => ({ ...entry, origin: "legacy" as const }))], importedAt: Date.now(), legacy: true };
      validateState(next);
      storage.set("vector-index-pre-legacy-import-backup", state ? structuredClone(state) : { version: 1, entries: [] });
      storage.set("vector-index", next); state = next;
      return this.view();
    },
    generatedHash(l2Id: string) {
      const record = state?.entries.find((entry) => entry.l2Id === l2Id && entry.origin === "generated");
      return record?.contentHash;
    },
    hasRecord(l2Id: string) { return Boolean(state?.entries.some((entry) => entry.l2Id === l2Id)); },
    reconcile(allowedIds: string[]) {
      if (!state) return { removed: 0, ...this.view() };
      const allowed = new Set(allowedIds), entries = state.entries.filter((entry) => allowed.has(entry.l2Id));
      const removed = state.entries.length - entries.length;
      if (removed) { const next = { ...state, entries }; validateState(next); storage.set("vector-index", next); state = next; }
      return { removed, ...this.view() };
    },
    upsertGenerated(records: Array<{ l2Id: string; embedding: number[]; contentHash: string }>, dimensions: number) {
      if (!records.length || !Number.isSafeInteger(dimensions) || dimensions < 64 || dimensions > 8192) throw new Error("生成向量提交无效");
      if (state && state.dimensions !== dimensions) throw new Error("Embedding 配置维度与现有索引不一致");
      const ids = new Set<string>();
      for (const record of records) {
        if (!record || typeof record.l2Id !== "string" || !record.l2Id || ids.has(record.l2Id)
          || !/^[a-f0-9]{64}$/.test(record.contentHash) || !Array.isArray(record.embedding)
          || record.embedding.length !== dimensions || record.embedding.some((value) => !Number.isFinite(value))) throw new Error("生成向量提交无效");
        ids.add(record.l2Id);
      }
      const base: VectorState = state ?? { version: 1, sourceHash: "0".repeat(64), sourceBytes: 0, dimensions, entries: [], importedAt: Date.now(), legacy: false };
      const next: VectorState = {
        ...base,
        entries: [...base.entries.filter((entry) => !ids.has(entry.l2Id)), ...records.map((record) => ({ ...record, embedding: [...record.embedding], origin: "generated" as const, weight: 1, lastRecalledAt: Date.now() }))],
      };
      validateState(next);
      storage.set("vector-index", next); state = next;
      return this.view();
    },
    removeGenerated(l2Id: string) {
      if (!state || typeof l2Id !== "string" || !l2Id) return this.view();
      const entries = state.entries.filter((entry) => !(entry.l2Id === l2Id && entry.origin === "generated"));
      if (entries.length === state.entries.length) return this.view();
      const next = { ...state, entries }; validateState(next);
      storage.set("vector-index", next); state = next; return this.view();
    },
    search(vector: number[], allowedIds: string[], limit = 8): string[] {
      if (!state) return [];
      if (vector.length !== state.dimensions || vector.some((n) => !Number.isFinite(n))) throw new Error("查询向量维度与索引不匹配");
      const allowed = new Set(allowedIds), norm = Math.sqrt(vector.reduce((s,n) => s+n*n, 0)); if (!norm) return [];
      return state.entries.filter((e) => allowed.has(e.l2Id)).map((e) => {
        let dot=0, square=0; for (let i=0;i<vector.length;i++) { dot += vector[i]*e.embedding[i]; square += e.embedding[i]*e.embedding[i]; }
        return { id:e.l2Id, score: square ? dot/(norm*Math.sqrt(square)) : -1 };
      }).sort((a,b) => b.score-a.score).slice(0, limit).map((e) => e.id);
    },
    records(allowedIds: string[]) {
      if (!state) return [];
      const allowed = new Set(allowedIds);
      return state.entries.filter((entry) => allowed.has(entry.l2Id)).map((entry) => ({
        id: entry.l2Id,
        embedding: [...entry.embedding],
        weight: entry.weight ?? 1,
        lastRecalledAt: entry.lastRecalledAt ?? state!.importedAt,
      }));
    },
    recordSearchHits(ids: string[], now = Date.now()) {
      if (!state || !ids.length) return this.view();
      const selected = new Set(ids);
      let changed = false;
      const entries = state.entries.map((entry) => {
        if (!selected.has(entry.l2Id)) return entry;
        changed = true;
        return { ...entry, weight: Math.min((entry.weight ?? 1) + 0.05, 5), lastRecalledAt: now };
      });
      if (changed) {
        const next = { ...state, entries }; validateState(next);
        storage.set("vector-index", next); state = next;
      }
      return this.view();
    },
    relatedPairs(allowedIds: string[], minScore = 0.82, limit = 50) {
      if (!Number.isFinite(minScore) || minScore < -1 || minScore > 1 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error("相似候选参数无效");
      if (!state) return { indexed: 0, considered: 0, truncated: false, pairs: [] as Array<{ leftId: string; rightId: string; score: number }> };
      const allowed = new Set(allowedIds), all = state.entries.filter((entry) => allowed.has(entry.l2Id));
      const entries = all.slice(0, RELATED_PAIR_ENTRY_LIMIT), norms = entries.map((entry) => Math.sqrt(entry.embedding.reduce((sum, value) => sum + value * value, 0)));
      const pairs: Array<{ leftId: string; rightId: string; score: number }> = [];
      for (let left = 0; left < entries.length; left++) for (let right = left + 1; right < entries.length; right++) {
        if (!norms[left] || !norms[right]) continue;
        let dot = 0; for (let index = 0; index < state.dimensions; index++) dot += entries[left].embedding[index] * entries[right].embedding[index];
        const score = dot / (norms[left] * norms[right]);
        if (score >= minScore) pairs.push({ leftId: entries[left].l2Id, rightId: entries[right].l2Id, score: Number(score.toFixed(6)) });
      }
      pairs.sort((a, b) => b.score - a.score || a.leftId.localeCompare(b.leftId) || a.rightId.localeCompare(b.rightId));
      return { indexed: all.length, considered: entries.length, truncated: all.length > entries.length, pairs: pairs.slice(0, limit) };
    },
  };
}
