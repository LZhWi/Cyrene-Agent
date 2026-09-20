import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createMemory, type Entry } from "../plugins/companion-memory/src/memory";
import { emptyProfiles } from "../plugins/companion-memory/src/profiles";
import { isRecallable } from "../plugins/companion-memory/src/entries";
import { linkedEvidence, type Evidence } from "../plugins/companion-memory/src/evidence";

// 显式开启才读真实数据。只映射到内存；不导入原程序，不复制原文件，不调用模型。
it.runIf(process.env.CYRENE_READONLY_MEMORY_TEST === "1")("真实 L2 只读隔离：来源不变、检索无写入、仅输出汇总", () => {
  const file = path.join(homedir(), "AppData/Roaming/live2d-cyrene/memory.json");
  const stat = lstatSync(file);
  expect(stat.isFile() && !stat.isSymbolicLink() && stat.size < 32 * 1024 * 1024).toBe(true);
  expect(path.normalize(realpathSync(file)).toLowerCase() === path.normalize(file).toLowerCase()).toBe(true);
  const buffer = readFileSync(file);
  const hash = (value: Buffer) => createHash("sha256").update(value).digest("hex");
  const before = hash(buffer);
  const network = vi.spyOn(globalThis, "fetch").mockImplementation(async () => { throw new Error("隔离测试禁止网络"); });
  try {
    let source: any;
    try { source = JSON.parse(buffer.toString("utf8")); } catch { throw new Error("真实记忆 JSON 解析失败（内容不输出）"); }
    expect(Array.isArray(source.l2)).toBe(true);
    const now = Date.now(), counts: Record<string, number> = {};
    let invalid = 0, missingQuote = 0, missingSourceTime = 0, expired = 0, missingQuoteWithEvidence = 0, missingQuoteWithoutEvidence = 0;
    const entries: Entry[] = [];
    for (const item of source.l2) {
      // 只输出已知状态分类，禁止把任意源字段值用作报告键。
      const category = ["active", "aging", "archived", "superseded", "merged"].includes(item?.status) ? item.status : "unknown";
      counts[category] = (counts[category] ?? 0) + 1;
      if (!item || typeof item.id !== "string" || !item.id || typeof item.content !== "string" || !item.content || !Number.isFinite(item.sourceAt ?? item.createdAt)) { invalid++; continue; }
      if (!Number.isFinite(item.sourceAt)) missingSourceTime++;
      if (typeof item.sourceQuote !== "string" || !item.sourceQuote.trim()) {
        missingQuote++;
        const linked = Array.isArray(source.evidence) && source.evidence.some((e: any) => e?.memoryId === item.id &&
          ["active", "archived"].includes(e.sourceStatus) && typeof e.quoteSnippet === "string" && e.quoteSnippet.trim());
        if (linked) missingQuoteWithEvidence++; else missingQuoteWithoutEvidence++;
      }
      const outsideValidity = (Number.isFinite(item.validTo) && item.validTo <= now) || (Number.isFinite(item.validFrom) && item.validFrom > now);
      if (outsideValidity) expired++;
      // 不伪造 triggerText 为逐字用户证据；不导入 DMAE、向量或原历史。
      entries.push({ id: item.id, content: item.content, quote: typeof item.sourceQuote === "string" ? item.sourceQuote : "", sourceAt: item.sourceAt ?? item.createdAt,
        turnId: "readonly-unmapped", sessionId: "readonly-unmapped", pinned: item.isPinned === true,
        status: category as Entry["status"],
        ...(item.validFrom === undefined ? {} : { validFrom: item.validFrom }), ...(item.validTo === undefined ? {} : { validTo: item.validTo }),
        ...(item.supersededBy === undefined ? {} : { supersededBy: item.supersededBy }), ...(item.mergedInto === undefined ? {} : { mergedInto: item.mergedInto }) });
    }
    expect(invalid).toBe(0);
    expect(new Set(entries.map((e) => e.id)).size === entries.length).toBe(true);
    expect(Array.isArray(source.evidence)).toBe(true);
    const evidence: Evidence[] = source.evidence.map((e: any) => ({ id: e.id, memoryId: e.memoryId, quoteSnippet: e.quoteSnippet, sourceStatus: e.sourceStatus, createdAt: e.createdAt,
      ...(e.conversationId === undefined ? {} : { conversationId: e.conversationId }), ...(e.messageIds === undefined ? {} : { messageIds: e.messageIds }),
      ...(e.contextBeforeSnippet === undefined ? {} : { contextBeforeSnippet: e.contextBeforeSnippet }), ...(e.contextAfterSnippet === undefined ? {} : { contextAfterSnippet: e.contextAfterSnippet }) }));
    const snapshot = { version: 2, revision: 0, turns: [], processed: [], entries, evidence, profiles: emptyProfiles(), profileChanges: [], entryReviews: [] };
    const serialized = JSON.stringify(snapshot);
    const write = vi.fn(() => { throw new Error("隔离测试禁止存储写入"); });
    const storage: PluginStorage = { get: (key) => key === "memory-state" ? structuredClone(snapshot) as any : undefined, set: write, rootDir: () => { throw new Error("隔离测试无磁盘存储"); } };
    const memory = createMemory(storage);
    const active = entries.filter((e) => isRecallable(e, now)), inactive = entries.filter((e) => !isRecallable(e, now));
    let exactSelfHits = 0, excerptSelfHits = 0, inactiveLeaks = 0, oversizedOutputs = 0, evidenceQueries = 0, evidenceSelfHits = 0;
    for (const entry of active) {
      const linked = linkedEvidence(evidence, entry.id);
      if (!entry.quote.trim() && linked.length) {
        evidenceQueries++;
        if (memory.search(linked[0].quoteSnippet.slice(0, 16)).includes(`[记忆 ${entry.id}；`)) evidenceSelfHits++;
      }
    }
    for (const entry of entries) {
      const full = memory.search(entry.content);
      const excerpt = memory.search(entry.content.slice(0, 16));
      if (isRecallable(entry, now)) {
        if (full.includes(`[记忆 ${entry.id}；`)) exactSelfHits++;
        if (excerpt.includes(`[记忆 ${entry.id}；`)) excerptSelfHits++;
      }
      if (inactive.some((e) => full.includes(`[记忆 ${e.id}；`) || excerpt.includes(`[记忆 ${e.id}；`))) inactiveLeaks++;
      if (full.length > 24000 || excerpt.length > 24000) oversizedOutputs++;
    }
    expect(inactiveLeaks).toBe(0); expect(oversizedOutputs).toBe(0);
    expect(write.mock.calls.length).toBe(0); expect(network.mock.calls.length).toBe(0);
    expect(JSON.stringify(snapshot) === serialized).toBe(true);
    expect(memory.view().revision).toBe(0);
    console.log("READONLY_MEMORY_SUMMARY " + JSON.stringify({ total: entries.length, statuses: counts, activeEligible: active.length, pinnedEligible: active.filter((e) => e.pinned).length, missingQuote, missingQuoteWithEvidence, missingQuoteWithoutEvidence, missingSourceTime, expired, exactSelfHits, excerptSelfHits, evidenceRecords: evidence.length, orphanEvidence: evidence.filter((e) => !entries.some((entry) => entry.id === e.memoryId)).length, evidenceQueries, evidenceSelfHits, inactiveLeaks, oversizedOutputs, storageWrites: 0, modelRequests: 0 }));
  } finally {
    network.mockRestore();
    // 原程序可能仍在运行；不一致只报告源已变化，不尝试回写或锁定原文件。
    expect(hash(readFileSync(file)) === before, "源文件前后哈希应一致；若原程序同时写入，请重新选择稳定时段测试").toBe(true);
  }
});
