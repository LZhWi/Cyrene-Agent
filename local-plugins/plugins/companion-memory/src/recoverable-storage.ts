import { copyFileSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type { PluginContext, PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { assertPluginStorageFile, resolvePluginStorageRoot } from "../../shared/boundary";
import { strictStorage } from "../../shared/runtime";
import { createMemory } from "./memory";
import { createDmae } from "./dmae";
import { createLifecycle } from "./lifecycle";
import { createVectorIndex } from "./vector-index";
import { createHistoryRetrieval } from "./history-retrieval";
import { createSourceInvalidationQueue } from "./source-reconciliation";
import { createDream } from "./dream";
import { createEntityGraph } from "./entity-graph";
import { createRelationshipLog } from "./relationship-context";
import { createSocialContext } from "./social-context";
import { LEGACY_CONTEXT_KEY, legacyContextState } from "./legacy-context-state";
import { validateEvidence } from "./evidence";

// Reuse each owner's schema validation without registering consumers or executing models.
const validators: Record<string, (storage: PluginStorage) => unknown> = {
  [LEGACY_CONTEXT_KEY]: storage => {
    createEntityGraph(storage); createRelationshipLog(storage);
    createSocialContext(storage, async () => { throw new Error("恢复校验不能调用模型"); });
    validateEvidence(storage.get<any>(LEGACY_CONTEXT_KEY)?.sourceEvidence);
    const dream = legacyContextState<any>(storage, "auto-dream-state");
    if (!dream || dream.version !== 1 || (dream.lastCompletedAt !== undefined && (!Number.isFinite(dream.lastCompletedAt) || dream.lastCompletedAt < 0))) throw new Error("旧 Dream 快照损坏");
  },
  "memory-state": createMemory,
  "dmae-state": createDmae,
  "lifecycle-state": createLifecycle,
  "vector-index": createVectorIndex,
  "history-retrieval-vector-index": storage => createHistoryRetrieval({ storage, turns: () => [] }),
  "history-retrieval-recall-state": storage => createHistoryRetrieval({ storage, turns: () => [] }),
  "pending-source-invalidations": createSourceInvalidationQueue,
  "dream-state": createDream,
  "entity-graph": createEntityGraph,
  "relationship-log": createRelationshipLog,
  "social-context-state": storage => createSocialContext(storage, async () => { throw new Error("恢复校验不能调用模型"); }),
};

/** Only companion-memory state files get last-good recovery; other plugin storage is unchanged. */
export function createRecoverableMemoryStorage(ctx: PluginContext): PluginStorage {
  const fallback = strictStorage(ctx), root = resolvePluginStorageRoot(fallback.rootDir());
  const check = (file: string) => assertPluginStorageFile(root, file);
  function validate(key: string, value: unknown): void {
    if (value === null || typeof value !== "object") throw new Error("记忆状态结构无效");
    if (key === "memory-state" && ![1, 2].includes((value as { version?: number }).version ?? 0)) throw new Error("记忆状态版本无效");
    const probe: PluginStorage = { rootDir: () => root,
      get: <T>(requested: string) => requested === key ? structuredClone(value) as T : undefined,
      set: () => { throw new Error("恢复校验必须只读"); } };
    validators[key](probe);
  }
  function read(key: string, file: string): { json: string; value: unknown } | undefined {
    check(file);
    if (!existsSync(file)) return undefined;
    const json = readFileSync(file, "utf8"); // I/O errors must not be mistaken for corrupt data.
    try { const value: unknown = JSON.parse(json); validate(key, value); return { json, value }; }
    catch { return undefined; }
  }
  function atomic(file: string, json: string): void {
    if (ctx.signal.aborted) throw new Error("插件已停止，拒绝恢复或写入");
    check(file);
    const temporary = `${file}.tmp-${randomUUID()}`;
    check(temporary);
    try { writeFileSync(temporary, json, { encoding: "utf8", flag: "wx" }); renameSync(temporary, file); }
    finally { if (existsSync(temporary)) unlinkSync(temporary); }
  }
  function preserve(file: string): void {
    check(file);
    if (!existsSync(file)) return;
    const saved = `${file}.recovery-${randomUUID()}`;
    check(saved); copyFileSync(file, saved);
  }
  function files(key: string) {
    return { primary: path.join(root, `${key}.json`), backup: path.join(root, `${key}.last-good.json`), temporary: path.join(root, `${key}.json.tmp`) };
  }
  return {
    ...((ctx.storage as any).isolationAggregate === true ? { isolationAggregate: true } : {}),
    ...((ctx.storage as any).isolationQueue ? { isolationQueue: (ctx.storage as any).isolationQueue } : {}),
    ...((ctx.storage as any).isolationTransaction ? { isolationTransaction: (ctx.storage as any).isolationTransaction } : {}),
    ...((ctx.storage as any).isolationSources ? { isolationSources: (ctx.storage as any).isolationSources } : {}),
    rootDir: fallback.rootDir,
    get<T>(key: string): T | undefined {
      if (!Object.hasOwn(validators, key)) return fallback.get<T>(key);
      if (ctx.signal.aborted) throw new Error("插件已停止，拒绝恢复或写入");
      if ((ctx.storage as any).isolationAggregate === true) {
        const value = fallback.get<T>(key);
        if (value !== undefined) validate(key, value);
        return value;
      }
      const { primary, backup, temporary } = files(key);
      const current = read(key, primary), lastGood = read(key, backup);
      if (current) {
        if (current.json !== lastGood?.json) {
          if (!lastGood && existsSync(backup)) preserve(backup);
          atomic(backup, current.json);
        }
        return current.value as T;
      }
      check(temporary);
      if (!lastGood) {
        if ([primary, backup, temporary].some(existsSync)) throw new Error(`记忆状态 ${key} 及有效副本不可用；已停止加载，原文件保持不变`);
        return undefined;
      }
      preserve(primary); preserve(temporary);
      atomic(primary, lastGood.json);
      ctx.log(`[companion-memory] ${key} 已从经过结构校验的 last-good 副本恢复；原文件已保留`);
      return lastGood.value as T;
    },
    set<T>(key: string, value: T): void {
      if (!Object.hasOwn(validators, key)) return fallback.set(key, value);
      if (ctx.signal.aborted) throw new Error("插件已停止，拒绝迟到写入");
      const json = JSON.stringify(value, null, 2);
      validate(key, JSON.parse(json));
      if ((ctx.storage as any).isolationAggregate === true) return fallback.set(key, value);
      const { primary, backup, temporary } = files(key);
      check(temporary);
      const current = read(key, primary), lastGood = read(key, backup);
      if (!current && [primary, backup, temporary].some(existsSync)) throw new Error(`记忆状态 ${key} 需要重新加载恢复，拒绝用内存旧状态覆盖`);
      if (current && !lastGood) { if (existsSync(backup)) preserve(backup); atomic(backup, current.json); }
      atomic(primary, json);
      // Primary is committed. A backup failure must not make callers retain stale in-memory state.
      try { atomic(backup, json); }
      catch { ctx.log(`[companion-memory] ${key} 已保存，但 last-good 更新失败；保留原有效副本`); }
    },
  };
}
