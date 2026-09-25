import { createHash, randomUUID } from "node:crypto";
import type { PluginContext } from "@playa0v0/cyrene-plugin-sdk";
import type { Entry } from "./entries";
import { isRecallable } from "./entries";

const SETTINGS_KEY = "semantic-index-settings";
const BASELINE_KEY = "semantic-index-baseline";
const MAX_BATCH = 50;
const BACKFILL_PREVIEW_LIMIT = 200;
const BACKFILL_APPLY_LIMIT = 100;

interface Settings { enabled: boolean }
interface Baseline { version: 1; hashes: Record<string, string> }
interface MemoryView { revision: number; entries: Entry[] }
interface MemorySource { view(): MemoryView }
interface Embedder { readonly config: { enabled: boolean; dimensions: number }; embed(text: string, signal: AbortSignal): Promise<number[]> }
interface VectorTarget {
  view(): { dimensions?: number; generatedEntries?: number };
  generatedHash(l2Id: string): string | undefined;
  hasRecord(l2Id: string): boolean;
  upsertGenerated(records: Array<{ l2Id: string; embedding: number[]; contentHash: string }>, dimensions: number): unknown;
}

const hashContent = (content: string) => createHash("sha256").update(content, "utf8").digest("hex");
function snapshot(entries: Entry[]): Baseline {
  return { version: 1, hashes: Object.fromEntries(entries.map((entry) => [entry.id, hashContent(entry.content)])) };
}
function validateBaseline(value: unknown): Baseline {
  if (!value || typeof value !== "object" || (value as Baseline).version !== 1 || !(value as Baseline).hashes || typeof (value as Baseline).hashes !== "object" || Array.isArray((value as Baseline).hashes)) throw new Error("语义索引基线损坏");
  for (const [id, hash] of Object.entries((value as Baseline).hashes)) if (!id || !/^[a-f0-9]{64}$/.test(hash)) throw new Error("语义索引基线损坏");
  return structuredClone(value as Baseline);
}

export function createSemanticIndexer(ctx: PluginContext, memory: MemorySource, embedder: Embedder, vectors: VectorTarget) {
  const storedSettings = ctx.storage.get<unknown>(SETTINGS_KEY);
  let settings: Settings = storedSettings === undefined ? { enabled: false } : storedSettings as Settings;
  if (!settings || typeof settings.enabled !== "boolean") throw new Error("语义索引设置损坏");
  const storedBaseline = ctx.storage.get<unknown>(BASELINE_KEY);
  let baseline = storedBaseline === undefined ? undefined : validateBaseline(storedBaseline);
  if (settings.enabled && !baseline) throw new Error("语义索引缺少授权基线，拒绝自动发送记忆正文");
  let controller = new AbortController();
  let running: Promise<void> | undefined;
  let rerun = false;
  let lastError: { at: number; kind: "configuration" | "request" | "stale" } | undefined;
  let backfillPreview: { id: string; revision: number; dimensions: number; hashes: Record<string, string> } | undefined;

  function candidates(view = memory.view()) {
    if (!baseline) return [];
    // 与本地 memory/RAG 启动修复一致：已启用语义索引后，自动补齐缺失向量；
    // 已导入且正文未变化的旧向量继续复用，正文变化时再生成当前版本。
    return view.entries.filter((entry) => {
      if (!isRecallable(entry, Date.now())) return false;
      const contentHash = hashContent(entry.content);
      const generatedHash = vectors.generatedHash(entry.id);
      return !vectors.hasRecord(entry.id)
        || (generatedHash !== undefined && generatedHash !== contentHash)
        || baseline!.hashes[entry.id] !== contentHash;
    });
  }

  async function run(signal: AbortSignal) {
    if (!settings.enabled || signal.aborted) return;
    if (!embedder.config.enabled) { lastError = { at: Date.now(), kind: "configuration" }; return; }
    const dimensions = embedder.config.dimensions;
    const existingDimensions = vectors.view().dimensions;
    if (existingDimensions !== undefined && existingDimensions !== dimensions) { lastError = { at: Date.now(), kind: "configuration" }; return; }
    const view = memory.view();
    const pending = candidates(view).slice(0, MAX_BATCH);
    if (!pending.length) { lastError = undefined; return; }
    const records: Array<{ l2Id: string; embedding: number[]; contentHash: string }> = [];
    try {
      for (const entry of pending) {
        if (signal.aborted || !settings.enabled) return;
        const contentHash = hashContent(entry.content);
        const existingHash = vectors.generatedHash(entry.id);
        records.push({ l2Id: entry.id, contentHash, embedding: existingHash === contentHash ? [] : await embedder.embed(entry.content, signal) });
      }
      if (signal.aborted || !settings.enabled) return;
      if (memory.view().revision !== view.revision) { lastError = { at: Date.now(), kind: "stale" }; return; }
      const generated = records.filter((record) => record.embedding.length > 0);
      if (generated.length) vectors.upsertGenerated(generated, dimensions);
      const next = { ...baseline!.hashes };
      for (const record of records) next[record.l2Id] = record.contentHash;
      const committed: Baseline = { version: 1, hashes: next };
      ctx.storage.set(BASELINE_KEY, committed); baseline = committed;
      lastError = undefined;
      if (candidates().length > 0) rerun = true;
    } catch {
      if (!signal.aborted && settings.enabled) lastError = { at: Date.now(), kind: "request" };
    }
  }

  function kick() {
    if (!settings.enabled || ctx.signal.aborted) return;
    if (running) { rerun = true; return; }
    const signal = AbortSignal.any([ctx.signal, controller.signal]);
    running = run(signal).finally(() => {
      running = undefined;
      const shouldRerun = rerun;
      rerun = false;
      if (shouldRerun && settings.enabled && !ctx.signal.aborted) kick();
    });
  }

  if (settings.enabled) kick();
  return {
    view() {
      return {
        enabled: settings.enabled,
        pending: settings.enabled ? candidates().length : 0,
        processing: Boolean(running),
        generatedEntries: vectors.view().generatedEntries ?? 0,
        lastError,
      };
    },
    configure(value: unknown) {
      if (!value || typeof value !== "object" || typeof (value as Settings).enabled !== "boolean") throw new Error("语义索引设置无效");
      const enabled = (value as Settings).enabled;
      if (enabled && !settings.enabled) {
        if (!embedder.config.enabled) throw new Error("请先配置并启用 Embedding Provider");
        const dimensions = vectors.view().dimensions;
        if (dimensions !== undefined && dimensions !== embedder.config.dimensions) throw new Error("Embedding 配置维度与现有索引不一致");
        const initial = snapshot(memory.view().entries);
        ctx.storage.set(BASELINE_KEY, initial); baseline = initial;
      }
      if (!enabled && settings.enabled) {
        controller.abort(); controller = new AbortController(); rerun = false; backfillPreview = undefined;
      }
      const next = { enabled };
      ctx.storage.set(SETTINGS_KEY, next); settings = next;
      if (enabled) kick();
      return this.view();
    },
    memoryChanged() { kick(); },
    previewBackfill() {
      if (!settings.enabled) throw new Error("请先启用新记忆语义索引");
      if (!embedder.config.enabled) throw new Error("请先配置并启用 Embedding Provider");
      if (running) throw new Error("语义索引正在处理，请完成后再预检补建范围");
      const vectorDimensions = vectors.view().dimensions;
      if (vectorDimensions !== undefined && vectorDimensions !== embedder.config.dimensions) throw new Error("Embedding 配置维度与现有索引不一致");
      const view = memory.view();
      const eligible = view.entries.filter((entry) => isRecallable(entry, Date.now()));
      const missing = eligible.filter((entry) => {
        const generatedHash = vectors.generatedHash(entry.id);
        return !vectors.hasRecord(entry.id) || (generatedHash !== undefined && generatedHash !== hashContent(entry.content));
      });
      const visible = missing.slice(0, BACKFILL_PREVIEW_LIMIT);
      backfillPreview = { id: randomUUID(), revision: view.revision, dimensions: embedder.config.dimensions, hashes: Object.fromEntries(visible.map((entry) => [entry.id, hashContent(entry.content)])) };
      return {
        id: backfillPreview.id,
        revision: view.revision,
        eligible: eligible.length,
        alreadyCurrent: eligible.length - missing.length,
        missing: missing.length,
        truncated: missing.length > visible.length,
        entries: visible.map((entry) => ({ id: entry.id, content: entry.content })),
        maxSelection: BACKFILL_APPLY_LIMIT,
      };
    },
    applyBackfill(value: unknown) {
      if (!settings.enabled || !embedder.config.enabled) throw new Error("语义索引或 Embedding Provider 未启用");
      if (running) throw new Error("语义索引正在处理，请完成后重试");
      if (!value || typeof value !== "object" || typeof (value as any).previewId !== "string" || !Array.isArray((value as any).entryIds)) throw new Error("补建请求无效");
      const ids = (value as any).entryIds;
      if (!ids.length || ids.length > BACKFILL_APPLY_LIMIT || ids.some((id: unknown) => typeof id !== "string" || !id) || new Set(ids).size !== ids.length) throw new Error("补建范围无效");
      if (!backfillPreview || backfillPreview.id !== (value as any).previewId) throw new Error("补建预检已失效，请重新预检");
      if (backfillPreview.dimensions !== embedder.config.dimensions) throw new Error("Embedding 配置自预检后已变化，请重新预检");
      const view = memory.view();
      if (view.revision !== backfillPreview.revision) throw new Error("记忆自预检后已变化，请重新预检");
      const entries = new Map(view.entries.map((entry) => [entry.id, entry]));
      for (const id of ids) {
        const entry = entries.get(id);
        if (!entry || !isRecallable(entry, Date.now()) || backfillPreview.hashes[id] !== hashContent(entry.content)) throw new Error("补建范围自预检后已变化，请重新预检");
      }
      const next = { ...baseline!.hashes };
      for (const id of ids) delete next[id];
      const committed: Baseline = { version: 1, hashes: next };
      ctx.storage.set(BASELINE_KEY, committed); baseline = committed; backfillPreview = undefined;
      kick();
      return { queued: ids.length, ...this.view() };
    },
    retry() { if (!settings.enabled) throw new Error("请先启用新记忆语义索引"); lastError = undefined; kick(); return this.view(); },
    async whenIdle() { while (running) await running; },
    stop() { controller.abort(); },
  };
}
