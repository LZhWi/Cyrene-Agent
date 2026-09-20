import type { CyrenePlugin } from "@playa0v0/cyrene-plugin-sdk";
import { CHAT_ID, MEMORY_ID, createPeer } from "../../shared/protocol";
import { createWindow, registerUi, strictStorage } from "../../shared/runtime";
import { createMemory } from "./memory";
import { createRetrieval } from "./retrieval";
import { createLegacyImportPlan, defaultLegacyMemoryPath, previewLegacyMemoryFile } from "./legacy-import";
import { createEmbeddingService } from "./embedding";
import { createVectorIndex, defaultLegacyVectorPath, previewLegacyVectorFile } from "./vector-index";
import { createNativeIntegration } from "./native-integration";
import { createNativeHistory } from "./native-history";
import { createSemanticIndexer } from "./semantic-indexer";
import { createReranker } from "./reranker";
import { createDmae } from "./dmae";
import { createLifecycle } from "./lifecycle";
import { createDream } from "./dream";
import { createMaintenanceInbox } from "./maintenance-inbox";
import { runMaintenanceReviewBatch } from "./maintenance-batch";
import { createAutoMaintenance } from "./auto-maintenance";
import { createAutoReview } from "./auto-review";
import { createAutoCompression } from "./auto-compression";
import { createAutoReflection } from "./auto-reflection";
import { createAutoLifecycle } from "./auto-lifecycle";
import { createAutoDream } from "./auto-dream";
import { findCompressionClusters } from "./compression-clusters";
import { createSocialContext } from "./social-context";

let openWindow: (() => Promise<void>) | undefined;
let stop: (() => void) | undefined;
const plugin: CyrenePlugin = {
  register(ctx) {
    if (ctx.id !== MEMORY_ID) throw new Error("插件 ID 不匹配");
    const storage = strictStorage(ctx);
    let reviewController: AbortController | undefined;
    const generate = async (prompt: string, signal: AbortSignal): Promise<string> => {
      if (!ctx.deps.llm) throw new Error("当前宿主模型服务不可用");
      try {
        return await ctx.deps.llm.generateText([{ role: "user", content: prompt }], {
          signal, maxTokens: 4096, timeoutMs: 120000, purpose: "companion-memory",
        });
      } catch {
        throw new Error(signal.aborted ? "请求已取消" : "宿主模型请求失败，请检查主程序模型设置");
      }
    };
    const memory = createMemory(storage);
    const embeddings = createEmbeddingService(ctx);
    const social = createSocialContext(storage, generate, async (text, signal) => {
      if (!embeddings.config.enabled) throw new Error("Embedding 尚未启用");
      return embeddings.embed(text, signal);
    });
    const vectors = createVectorIndex(storage);
    const semantic = createSemanticIndexer(ctx, memory, embeddings, vectors);
    const reranker = createReranker(storage, generate);
    const dmae = createDmae(storage);
    const lifecycle = createLifecycle(storage);
    const dream = createDream(storage);
    const inbox = createMaintenanceInbox(storage);
    const autoMaintenance = createAutoMaintenance(storage, ctx.events, () => inbox.addAutomatically(memory.view().entries, vectors.relatedPairs(memory.recallableEntryIds()).pairs));
    const autoReview = createAutoReview(storage, ctx.events, () => {
      const snapshot = memory.view();
      const reviewedPairs = new Set(snapshot.entryReviews.map((review) => [review.left.id, review.right.id].sort().join("\u0000")));
      return inbox.view(snapshot.entries).items.filter((item) => !reviewedPairs.has([item.leftId, item.rightId].sort().join("\u0000")));
    }, async (item, autoSignal) => {
      if (reviewController) throw new Error("已有记忆复核正在进行");
      const controller = new AbortController(); reviewController = controller;
      const signal = AbortSignal.any([controller.signal, autoSignal, ctx.signal]);
      try {
        const revision = memory.view().revision;
        return await memory.reviewEntries({ leftId: item.leftId, rightId: item.rightId, revision }, (prompt) => generate(prompt, signal), signal);
      } finally { reviewController = undefined; }
    }, Date.now, (review) => {
      const id = (review as { id?: unknown })?.id;
      if (typeof id !== "string" || !id) throw new Error("Resolver 复核结果缺少标识");
      const result = memory.autoApplyResolverReview({ id, revision: memory.view().revision });
      if (result.memoryChanged) semantic.memoryChanged();
      return result;
    });
    const compressionCandidates = () => {
      const snapshot = memory.view();
      const reviewedGroups = new Set(snapshot.compressionReviews.map((review) => review.entries.map((entry) => entry.id).sort().join("\u0000")));
      const related = vectors.relatedPairs(memory.recallableEntryIds(), 0.82, 200);
      return findCompressionClusters(snapshot.entries, related.pairs)
        .map((group) => ({ id: [...group.entryIds].sort().join("\u0000"), entryIds: group.entryIds }))
        .filter((group) => !reviewedGroups.has(group.id));
    };
    const reviewCompressionCandidate = async (candidate: { id: string; entryIds: string[] }, autoSignal: AbortSignal) => {
      if (reviewController) throw new Error("已有记忆复核正在进行");
      const controller = new AbortController(); reviewController = controller;
      const signal = AbortSignal.any([controller.signal, autoSignal, ctx.signal]);
      try {
        const revision = memory.view().revision;
        return await memory.reviewCompression({ entryIds: candidate.entryIds, revision }, (prompt) => generate(prompt, signal), signal);
      } finally { reviewController = undefined; }
    };
    const applyCompressionReview = (review: unknown) => {
      const id = (review as { id?: unknown })?.id;
      if (typeof id !== "string" || !id) throw new Error("压缩复核结果缺少标识");
      const result = memory.autoApplyCompressionReview({ id, revision: memory.view().revision });
      if (result.memoryChanged) semantic.memoryChanged();
      return result;
    };
    const autoCompression = createAutoCompression(storage, ctx.events, compressionCandidates, reviewCompressionCandidate, Date.now,
      applyCompressionReview, () => storage.get<boolean>("auto-dream-enabled") === true);
    const autoReflection = createAutoReflection(storage, ctx.events, async (autoSignal) => {
      if (reviewController) throw new Error("已有记忆复核正在进行");
      const controller = new AbortController(); reviewController = controller;
      const signal = AbortSignal.any([controller.signal, autoSignal, ctx.signal]);
      try { return await memory.reviewProfiles((prompt) => generate(prompt, signal), signal); }
      finally { reviewController = undefined; }
    });
    const autoLifecycle = createAutoLifecycle(storage, ctx.events, () => {
      const entries = memory.view().entries;
      return {
        agingCandidates: lifecycle.preview(entries, { days: 30, target: "aging" }).candidates.length,
        archivedCandidates: lifecycle.preview(entries, { days: 90, target: "archived" }).candidates.length,
      };
    }, Date.now, () => {
      const snapshot = memory.view();
      const agingEntryIds = lifecycle.preview(snapshot.entries, { days: 30, target: "aging" }).candidates.slice(0, 100).map((entry) => entry.id);
      const archivedEntryIds = lifecycle.preview(snapshot.entries, { days: 90, target: "archived" }).candidates.slice(0, 100).map((entry) => entry.id);
      const applied = agingEntryIds.length || archivedEntryIds.length
        ? memory.transitionLifecyclePlan({ agingEntryIds, archivedEntryIds, revision: snapshot.revision })
        : { agingApplied: 0, archivedApplied: 0 };
      if (applied.agingApplied || applied.archivedApplied) semantic.memoryChanged();
      const weightDecayed = lifecycle.decayWeights(snapshot.entries).changed;
      const current = memory.view().entries;
      return {
        agingApplied: applied.agingApplied,
        archivedApplied: applied.archivedApplied,
        agingCandidates: lifecycle.preview(current, { days: 30, target: "aging" }).candidates.length,
        archivedCandidates: lifecycle.preview(current, { days: 90, target: "archived" }).candidates.length,
        weightDecayed,
      };
    });
    let cycleCapacity = { demotedToAging: 0, demotedToArchived: 0 }, cycleDreamEntryIds = new Set<string>();
    const autoDream = createAutoDream(storage, ctx.events, () => {
      if (dream.view().reviews.some((review) => review.status === "pending")) throw new Error("已有待确认梦境草稿，请先处理后再运行完整周期");
      const snapshot = memory.view(), preview = lifecycle.previewCapacity(snapshot.entries);
      const transition = lifecycle.validateCapacity(snapshot.entries, preview);
      cycleCapacity = { demotedToAging: transition.agingEntryIds.length, demotedToArchived: transition.archivedEntryIds.length };
      const demotedIds = [...new Set([...transition.agingEntryIds, ...transition.archivedEntryIds])];
      cycleDreamEntryIds = new Set(demotedIds.slice(0, 20));
      if (demotedIds.length) {
        memory.transitionCapacityPlan({ ...transition, revision: snapshot.revision });
        semantic.memoryChanged();
      }
      return demotedIds.slice(0, 20);
    }, async (entryIds, autoSignal) => {
      if (reviewController) throw new Error("已有记忆复核正在进行");
      const controller = new AbortController(); reviewController = controller;
      const signal = AbortSignal.any([controller.signal, autoSignal, ctx.signal]), snapshot = memory.view();
      try { return await dream.reviewCycle({ entryIds, revision: snapshot.revision }, snapshot.entries, snapshot.evidence, snapshot.revision, (prompt) => generate(prompt, signal), signal); }
      finally { reviewController = undefined; }
    }, Date.now, (review) => {
      const id = (review as { id?: unknown })?.id;
      if (typeof id !== "string" || !id) throw new Error("梦境复核结果缺少标识");
      dream.resolve({ id, action: "apply" }, memory.view().entries, memory.view().revision);
      return { applied: true, reviewId: id };
    }, async (autoSignal) => {
      let compressionReviewed = 0, compressionApplied = 0;
      if (autoCompression.view().enabled) {
        const preservePendingDreamSources = storage.get<boolean>("auto-dream-apply-enabled") !== true;
        const candidates = compressionCandidates().filter((candidate) => !preservePendingDreamSources || candidate.entryIds.every((id) => !cycleDreamEntryIds.has(id))).slice(0, 5);
        for (const candidate of candidates) {
          if (autoSignal.aborted || ctx.signal.aborted) throw new Error("梦境周期已取消");
          try {
            const review = await reviewCompressionCandidate(candidate, autoSignal);
            compressionReviewed += 1;
            if (autoCompression.view().applyEnabled && applyCompressionReview(review).applied) compressionApplied += 1;
          } catch {
            if (autoSignal.aborted || ctx.signal.aborted) throw new Error("梦境周期已取消");
          }
        }
      }
      return { ...cycleCapacity, compressionReviewed, compressionApplied };
    });
    const retrieval = createRetrieval(storage, (query, expansions, semanticIds, rerankedIds, selectedIds, maxChars) => memory.searchWithBudget(query, expansions, semanticIds, rerankedIds, selectedIds, maxChars),
      generate, async (query, signal) => {
        if (!embeddings.config.enabled || vectors.view().entries === 0) return [];
        if (vectors.view().dimensions !== embeddings.config.dimensions) throw new Error("Embedding 配置维度与已导入索引不一致");
        return vectors.search(await embeddings.embed(query, signal), memory.recallableEntryIds());
      }, (query, expansions, semanticIds) => memory.rerankCandidates(query, expansions, semanticIds), (query, candidates, signal) => reranker.rank(query, candidates, signal),
      (query, expansions, semanticIds, rerankedIds) => memory.injectionCandidateIds(query, expansions, semanticIds, rerankedIds),
      (baseIds) => dmae.preview(baseIds, memory.view().entries).selectedIds,
      (includedIds) => {
        const entries = memory.view().entries;
        dmae.commit(includedIds, entries);
        lifecycle.record(includedIds, entries);
      }, () => [memory.relationshipContext(), dream.context()].filter(Boolean).join("\n\n"));
    const peer = createPeer(ctx, CHAT_ID, async (method, data, signal) => {
      if (ctx.signal.aborted) throw new Error("插件已停止");
      switch (method) {
        case "search": return retrieval.search(data, signal);
        case "search-for-chat": return retrieval.searchForChat(data, signal);
        case "search-for-tool": return retrieval.searchForTool(data, signal);
        case "ingest": return memory.ingest(data);
        case "view": return memory.view();
        case "maintain": {
          const result = await memory.maintain((prompt) => generate(prompt, signal), signal);
          semantic.memoryChanged();
          return result;
        }
        default: throw new Error("未知请求");
      }
    });
    const native = createNativeIntegration(ctx, {
      ingest: (turn) => memory.ingest(turn),
      maintain: async (generate, signal) => {
        const result = await memory.maintain(generate, signal);
        semantic.memoryChanged();
        return result;
      },
    }, retrieval, social);
    const nativeHistory = createNativeHistory(ctx, memory);
    const window = createWindow(ctx, __dirname, "独立记忆档案");
    openWindow = window.open;
    stop = () => { reviewController?.abort(); autoDream.stop(); autoLifecycle.stop(); autoReflection.stop(); autoCompression.stop(); autoReview.stop(); autoMaintenance.stop(); semantic.stop(); nativeHistory.clear(); native.stop(); peer.stop(); window.close(); openWindow = undefined; };
    ctx.onDispose(stop);
    registerUi(ctx, async (action, data) => {
      if (action === "state") return { ...memory.view(), queryExpansion: retrieval.view(), reranker: reranker.view(), dmae: dmae.view(), lifecycle: lifecycle.view(), autoLifecycle: autoLifecycle.view(), dream: dream.view(), autoDream: autoDream.view(), maintenanceInbox: inbox.view(memory.view().entries), autoMaintenance: autoMaintenance.view(), autoReview: autoReview.view(), autoCompression: autoCompression.view(), autoReflection: autoReflection.view(), embedding: await embeddings.view(), vectorIndex: vectors.view(), semanticIndex: semantic.view(), social: social.view(), native: native.view(), defaultLegacyMemoryPath: defaultLegacyMemoryPath(), defaultLegacyVectorPath: defaultLegacyVectorPath() };
      if (action === "save-native-integration") return native.configure(data);
      if (action === "retry-native-integration") return native.retry();
      if (action === "list-native-conversations") return nativeHistory.list(ctx.signal);
      if (action === "preview-native-history") return nativeHistory.preview(data, ctx.signal);
      if (action === "apply-native-history-unique") return nativeHistory.applyUnique(data, ctx.signal);
      if (action === "apply-native-history-selection") return nativeHistory.applySelection(data, ctx.signal);
      if (action === "review-native-history-ambiguity") return nativeHistory.reviewAmbiguity(data, ctx.signal);
      if (action === "preview-legacy-import") return previewLegacyMemoryFile(data?.sourcePath);
      if (action === "import-legacy") {
        const result = memory.importLegacy(createLegacyImportPlan(data?.sourcePath, data?.sourceHash,
          data?.sourceAttested === true, data?.preserveRuntime === true), data);
        dmae.reload(); lifecycle.reload();
        return result;
      }
      if (action === "preview-legacy-vectors") return previewLegacyVectorFile(data?.sourcePath, memory.entryIds());
      if (action === "import-legacy-vectors") {
        if (!memory.view().legacyImport) throw new Error("请先完成旧记忆导入，再导入与其关联的向量");
        return vectors.importLegacy(data?.sourcePath, data?.sourceHash, memory.entryIds());
      }
      if (action === "save-embedding") return embeddings.save(data);
      if (action === "test-embedding") return embeddings.test(ctx.signal);
      if (action === "save-semantic-index") return semantic.configure(data);
      if (action === "retry-semantic-index") return semantic.retry();
      if (action === "preview-semantic-backfill") return semantic.previewBackfill();
      if (action === "apply-semantic-backfill") return semantic.applyBackfill(data);
      if (action === "preview-related-pairs") return { revision: memory.view().revision, ...vectors.relatedPairs(memory.recallableEntryIds()) };
      if (action === "preview-compression-clusters") {
        const snapshot = memory.view(), related = vectors.relatedPairs(memory.recallableEntryIds(), 0.82, 200);
        return { revision: snapshot.revision, considered: related.considered, truncated: related.truncated, groups: findCompressionClusters(snapshot.entries, related.pairs) };
      }
      if (action === "preview-maintenance-inbox") { const entries = memory.view().entries; return inbox.preview(entries, vectors.relatedPairs(memory.recallableEntryIds()).pairs); }
      if (action === "add-maintenance-inbox") { const entries = memory.view().entries; return inbox.add(data, entries, vectors.relatedPairs(memory.recallableEntryIds()).pairs); }
      if (action === "dismiss-maintenance-inbox") return inbox.dismiss(data, memory.view().entries);
      if (action === "auto-maintenance") return autoMaintenance.set(data);
      if (action === "auto-review") return autoReview.set(data);
      if (action === "auto-review-apply") return autoReview.setApply(data);
      if (action === "auto-compression") return autoCompression.set(data);
      if (action === "auto-compression-apply") return autoCompression.setApply(data);
      if (action === "auto-reflection") return autoReflection.set(data);
      if (action === "review-maintenance-batch") {
        if (reviewController) throw new Error("已有记忆复核正在进行");
        const controller = new AbortController(); reviewController = controller;
        const signal = AbortSignal.any([controller.signal, ctx.signal]);
        try {
          return await runMaintenanceReviewBatch(data, inbox.view(memory.view().entries).items, async (leftId, rightId) => {
            const revision = memory.view().revision;
            return memory.reviewEntries({ leftId, rightId, revision }, (prompt) => generate(prompt, signal), signal);
          }, signal);
        } finally { reviewController = undefined; }
      }
      if (action === "query-expansion") { retrieval.set(data); return true; }
      if (action === "reranker") return reranker.set(data);
      if (action === "dmae") return dmae.set(data);
      if (action === "lifecycle-tracking") return lifecycle.set(data);
      if (action === "auto-lifecycle") return autoLifecycle.set(data);
      if (action === "auto-lifecycle-apply") return autoLifecycle.setApply(data);
      if (action === "preview-lifecycle-aging") return { memoryRevision: memory.view().revision, ...lifecycle.preview(memory.view().entries, data) };
      if (action === "preview-capacity") {
        const snapshot = memory.view();
        return { memoryRevision: snapshot.revision, ...lifecycle.previewCapacity(snapshot.entries) };
      }
      if (action === "apply-capacity") {
        const snapshot = memory.view(), transition = lifecycle.validateCapacity(snapshot.entries, data);
        const result = memory.transitionCapacityPlan({ ...transition, revision: data?.memoryRevision });
        semantic.memoryChanged();
        return result;
      }
      if (action === "apply-lifecycle-aging") {
        const entries = memory.view().entries, transition = lifecycle.validateApply(entries, data);
        const result = memory.transitionLifecycleEntries({ ...transition, revision: data?.memoryRevision });
        semantic.memoryChanged();
        return result;
      }
      if (action === "undo-lifecycle-transition") { const result = memory.undoLifecycleTransition(data); semantic.memoryChanged(); return result; }
      if (action === "preview-archived-recall") return memory.previewArchivedRecall(data);
      if (action === "restore-archived-recall") {
        const result = memory.restoreArchivedRecall(data);
        semantic.memoryChanged();
        return result;
      }
      if (action === "dream-injection") return dream.setInjection(data);
      if (action === "auto-dream") return autoDream.set(data);
      if (action === "auto-dream-apply") return autoDream.setApply(data);
      if (action === "resolve-dream") return dream.resolve(data, memory.view().entries, memory.view().revision);
      if (action === "review-dream") {
        if (reviewController) throw new Error("已有记忆复核正在进行");
        const controller = new AbortController(); reviewController = controller;
        const signal = AbortSignal.any([controller.signal, ctx.signal]), snapshot = memory.view();
        try { return await dream.review(data, snapshot.entries, snapshot.evidence, snapshot.revision, (prompt) => generate(prompt, signal), signal); }
        finally { reviewController = undefined; }
      }
      if (action === "edit-profile") return memory.editProfile(data);
      if (action === "resolve-profile-change") return memory.resolveProfileChange(data);
      if (action === "lock-profile") return memory.lockProfile(data);
      if (action === "edit-entry") {
        const result = memory.editEntry(data);
        semantic.memoryChanged();
        return result;
      }
      if (action === "resolve-entry-review") {
        const result = memory.resolveEntryReview(data);
        if (["archive-left", "archive-right", "apply-plan", "undo-plan"].includes(data?.action)) semantic.memoryChanged();
        return result;
      }
      if (action === "resolve-compression") {
        const result = memory.resolveCompression(data);
        if (result.compressionChange.removedId) vectors.removeGenerated(result.compressionChange.removedId);
        semantic.memoryChanged();
        return result;
      }
      if (action === "cancel-review") { reviewController?.abort(); return true; }
      if (action === "review-entries") {
        if (reviewController) throw new Error("L2 复核正在进行");
        const controller = new AbortController(); reviewController = controller;
        const signal = AbortSignal.any([controller.signal, ctx.signal]);
        try { return await memory.reviewEntries(data, (prompt) => generate(prompt, signal), signal); }
        finally { reviewController = undefined; }
      }
      if (action === "review-compression") {
        if (reviewController) throw new Error("已有 L2 复核正在进行");
        const controller = new AbortController(); reviewController = controller;
        const signal = AbortSignal.any([controller.signal, ctx.signal]);
        try { return await memory.reviewCompression(data, (prompt) => generate(prompt, signal), signal); }
        finally { reviewController = undefined; }
      }
      if (action === "search") return retrieval.search(data, ctx.signal);
      throw new Error("未知操作");
    });
  },
  async open() { await openWindow?.(); },
  unregister() { stop?.(); stop = undefined; },
};
export = plugin;
