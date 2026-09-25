import type { CyrenePlugin, PluginConversationChangedEvent, PluginTurnFinishedEvent } from "@playa0v0/cyrene-plugin-sdk";
import { CHAT_ID, MEMORY_ID, createPeer } from "../../shared/protocol";
import { resolveToolTopK } from "../../shared/tool-top-k";
import { createWindow, registerUi, strictStorage } from "../../shared/runtime";
import { createMemory, PROFILE_REFLECTION_MIN_CONFIDENCE } from "./memory";
import type { ExtractionPromptMessage } from "./memory-extraction";
import { createRetrieval, rankLocalMemoryCandidates } from "./retrieval";
import { createLegacyImportPlan, defaultLegacyMemoryPath, previewLegacyMemoryFile } from "./legacy-import";
import { createEmbeddingService } from "./embedding";
import { createVectorIndex, defaultLegacyVectorPath, previewLegacyVectorFile } from "./vector-index";
import { createNativeIntegration } from "./native-integration";
import { createNativeHistory } from "./native-history";
import { createSemanticIndexer } from "./semantic-indexer";
import { createReranker } from "./reranker";
import { resolveRetrievalPlan } from "./facets";
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
import { createHistoryRetrieval } from "./history-retrieval";
import { createHostHistorySource } from "./host-history-source";
import { findPossibleConflictCandidate, hasCorrectionIntent, impactScope, isExplicitGoalCompletion, scoreMemoryConflict } from "./conflict";
import { createRecentInjections } from "./recent-injections";
import { createEntityGraph } from "./entity-graph";
import { createQueryRouter } from "./query-router";
import { createRelationshipLog } from "./relationship-context";

let openWindow: (() => Promise<void>) | undefined;
let stop: (() => void) | undefined;
const plugin: CyrenePlugin = {
  register(ctx) {
    if (ctx.id !== MEMORY_ID) throw new Error("插件 ID 不匹配");
    const storage = strictStorage(ctx);
    let reviewController: AbortController | undefined;
    const generate = async (prompt: string | ExtractionPromptMessage[], signal: AbortSignal, extraction = false): Promise<string> => {
      if (!ctx.deps.llm) throw new Error("当前宿主模型服务不可用");
      try {
        return await ctx.deps.llm.generateText(typeof prompt === "string" ? [{ role: "user", content: prompt }] : prompt, {
          signal,
          maxTokens: extraction ? 32768 : 4096,
          timeoutMs: extraction ? 300000 : 120000,
          purpose: extraction ? "memory-extraction" : "companion-memory",
          ...(extraction ? { reasoning: "on" as const } : {}),
        });
      } catch {
        throw new Error(signal.aborted ? "请求已取消" : "宿主模型请求失败，请检查主程序模型设置");
      }
    };
    const entityGraph = createEntityGraph(storage);
    const memory = createMemory(storage, (turn) => {
      entityGraph.ingest([turn.user]);
      entityGraph.ingest([turn.assistant]);
    });
    const relationship = createRelationshipLog(storage);
    relationship.reconcile(memory.view().turns);
    const queryRouter = createQueryRouter(ctx);
    const embeddings = createEmbeddingService(ctx);
    const social = createSocialContext(storage, generate, async (text, signal) => {
      if (!embeddings.config.enabled) throw new Error("Embedding 尚未启用");
      return embeddings.embed(text, signal);
    });
    const vectors = createVectorIndex(storage);
    const reranker = createReranker(storage, generate);
    const dmae = createDmae(storage);
    const lifecycle = createLifecycle(storage);
    const knownEntryIds = memory.entryIds();
    vectors.reconcile(knownEntryIds);
    dmae.reconcile(knownEntryIds);
    lifecycle.reconcile(knownEntryIds);
    const semantic = createSemanticIndexer(ctx, memory, embeddings, vectors);
    const dream = createDream(storage);
    const inbox = createMaintenanceInbox(storage);
    const recentInjections = createRecentInjections();
    const processNewConflicts = async (previousIds: Set<string>, signal: AbortSignal) => {
      await semantic.whenIdle();
      if (signal.aborted) throw new Error("提取已取消");
      const snapshot = memory.view(), freshEntries = snapshot.entries.filter((entry) => !previousIds.has(entry.id) && entry.status === "active");
      if (!freshEntries.length) return 0;
      const records = vectors.records(snapshot.entries.map((entry) => entry.id)), byVector = new Map(records.map((record) => [record.id, record.embedding]));
      const cosine = (left: number[], right: number[]) => {
        if (!left.length || left.length !== right.length) return -1;
        let dot = 0, leftSquare = 0, rightSquare = 0;
        for (let i = 0; i < left.length; i++) { dot += left[i] * right[i]; leftSquare += left[i] * left[i]; rightSquare += right[i] * right[i]; }
        return leftSquare && rightSquare ? dot / Math.sqrt(leftSquare * rightSquare) : -1;
      };
      let changed = 0;
      for (const fresh of freshEntries) {
        const freshVector = byVector.get(fresh.id);
        if (!freshVector) continue;
        const candidates = snapshot.entries.filter((entry) => previousIds.has(entry.id) && (entry.status === "active" || entry.status === "aging") && byVector.has(entry.id))
          .map((entry) => ({ entry, score: cosine(freshVector, byVector.get(entry.id)!) }))
          .sort((a, b) => b.score - a.score).slice(0, 5);
        if (isExplicitGoalCompletion(fresh.content, fresh.triggerText ?? fresh.quote, fresh.facets?.primaryKind)) {
          const completedGoal = candidates.find(({ entry, score }) => score >= 0.55 && entry.facets?.source === "model"
            && entry.facets.primaryKind === "goal" && entry.facets.retrievalKinds.length === 1);
          if (completedGoal) {
            memory.applyDetectedConflict({ sourceId: fresh.id, targetId: completedGoal.entry.id, action: "fast-supersede", revision: memory.view().revision });
            changed += 1;
            continue;
          }
        }
        if (fresh.facets?.source === "model" && ["experience", "fact"].includes(fresh.facets.primaryKind)) {
          const transition = candidates.find(({ entry, score }) => score >= 0.55 && entry.facets?.source === "model"
            && ["goal", "commitment"].includes(entry.facets.primaryKind)
            && fresh.sourceAt >= (entry.sourceEndAt ?? entry.sourceAt));
          if (transition) {
            memory.applyDetectedConflict({ sourceId: fresh.id, targetId: transition.entry.id, action: "mark-candidate", revision: memory.view().revision });
            inbox.addDetected({
              leftId: fresh.id, rightId: transition.entry.id, score: transition.score,
              reason: `possible temporal state transition: ${transition.entry.facets!.primaryKind} -> ${fresh.facets.primaryKind}`,
              conflictScore: Math.max(60, Math.min(90, Math.round(transition.score * 100))),
              resolverPriority: "normal", scoringSignals: {
                correctionIntent: false, ragCandidate: true, recentInjection: false,
                evidenceAvailable: memory.conflictEvidenceLevel(fresh.id, transition.entry.id) !== "none",
                localContradiction: false, impactScope: impactScope(transition.entry),
                penalties: ["temporal_transition_requires_resolver"],
              },
            }, memory.view().entries);
            changed += 1;
            continue;
          }
        }
        for (const { entry: existing, score } of candidates) {
          const current = memory.view().entries.find((entry) => entry.id === existing.id);
          if (!current || !["active", "aging"].includes(current.status) || current.supersededBy || current.mergedInto) continue;
          const candidate = findPossibleConflictCandidate(fresh.content, existing.content);
          if (!candidate.isCandidate) continue;
          const correctionIntent = hasCorrectionIntent(fresh.quote || fresh.triggerText || fresh.content), recentInjection = recentInjections.has(existing.id);
          if (correctionIntent && (recentInjection || score >= 0.75)) {
            memory.applyDetectedConflict({ sourceId: fresh.id, targetId: existing.id, action: "fast-supersede", revision: memory.view().revision });
            changed += 1;
            continue;
          }
          const evidence = memory.conflictEvidenceLevel(fresh.id, existing.id);
          const scored = scoreMemoryConflict({ ragScore: score, correctionIntent, recentInjection, localContradiction: true, evidence, activeTarget: existing.status !== "archived", impactScope: impactScope(existing) });
          memory.applyDetectedConflict({ sourceId: fresh.id, targetId: existing.id, action: "mark-candidate", revision: memory.view().revision });
          inbox.addDetected({ leftId: fresh.id, rightId: existing.id, score, reason: candidate.reason ?? "possible local lexical contradiction", ...scored }, memory.view().entries);
          changed += 1;
        }
      }
      return changed;
    };
    const maintainMemory = async (_runGenerate: Parameters<typeof memory.maintain>[0], signal: AbortSignal, validateSources?: Parameters<typeof memory.maintain>[2]) => {
      const previousIds = new Set(memory.entryIds());
      const result = await memory.maintain((prompt) => generate(prompt, signal, true), signal, validateSources);
      semantic.memoryChanged();
      const conflicts = await processNewConflicts(previousIds, signal);
      return { ...result, conflicts };
    };
    const autoMaintenance = createAutoMaintenance(storage, ctx.events, () => inbox.addAutomatically(memory.view().entries, vectors.relatedPairs(memory.recallableEntryIds()).pairs));
    const autoReview = createAutoReview(storage, ctx.events, () => {
      const snapshot = memory.view();
      const reviewedPairs = new Set(snapshot.entryReviews.map((review) => [review.left.id, review.right.id].sort().join("\u0000")));
      return inbox.view(snapshot.entries).items.filter((item) => item.resolverPriority !== "none" && !reviewedPairs.has([item.leftId, item.rightId].sort().join("\u0000")));
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
    const compressionCandidates = (kind: "regular" | "dream" = "regular") => {
      const snapshot = memory.view();
      const reviewedGroups = new Set(snapshot.compressionReviews.filter((review) => review.status !== "stale").map((review) => review.entries.map((entry) => entry.id).sort().join("\u0000")));
      const minimumScore = kind === "regular" ? 0.85 : 0.82;
      const related = vectors.relatedPairs(memory.recallableEntryIds(), minimumScore, 200);
      return findCompressionClusters(snapshot.entries, related.pairs, { status: kind === "regular" ? "active" : "aging", minimumScore })
        .map((group) => ({ id: [...group.entryIds].sort().join("\u0000"), entryIds: group.entryIds, kind }))
        .filter((group) => !reviewedGroups.has(group.id));
    };
    const reviewCompressionCandidate = async (candidate: { id: string; entryIds: string[]; kind?: "regular" | "dream" }, autoSignal: AbortSignal) => {
      if (reviewController) throw new Error("已有记忆复核正在进行");
      const controller = new AbortController(); reviewController = controller;
      const signal = AbortSignal.any([controller.signal, autoSignal, ctx.signal]);
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          const snapshot = memory.view(), expectedStatus = candidate.kind === "regular" ? "active" : candidate.kind === "dream" ? "aging" : undefined;
          const entryIds = candidate.entryIds.filter((id) => snapshot.entries.some((entry) => entry.id === id && (entry.status === "active" || entry.status === "aging") && (!expectedStatus || (entry.status === expectedStatus && !entry.pinned && !entry.isSummary && !entry.supersededBy && !entry.mergedInto)) && (entry.validFrom === undefined || entry.validFrom <= Date.now()) && (entry.validTo === undefined || entry.validTo > Date.now())));
          const minimum = candidate.kind === "regular" || candidate.kind === "dream" ? 3 : 2;
          if (entryIds.length < minimum) throw new Error("有效来源不足，压缩计划已失效");
          try { return await memory.reviewCompression({ entryIds, kind: candidate.kind, revision: snapshot.revision }, (prompt) => generate(prompt, signal), signal); }
          catch (error) {
            if (attempt === 0 && error instanceof Error && error.message.includes("记忆已发生变化")) continue;
            throw error;
          }
        }
        throw new Error("压缩计划重新排队失败");
      } finally { reviewController = undefined; }
    };
    const retryStaleCompression = async (result: any, autoApply: boolean) => {
      if (!result?.stale || !Array.isArray(result.retryEntryIds)) return result;
      const minimum = result.kind === "regular" || result.kind === "dream" ? 3 : 2;
      if (result.retryEntryIds.length < minimum) return { ...result, retryQueued: false, retryReason: "insufficient-valid-sources" };
      try {
        const replacement = await reviewCompressionCandidate({ id: result.retryEntryIds.slice().sort().join("\u0000"), entryIds: result.retryEntryIds, kind: result.kind }, ctx.signal);
        if (!autoApply) return { ...result, retryQueued: true, replacementReviewId: (replacement as any).id };
        const applied = memory.autoApplyCompressionReview({ id: (replacement as any).id, revision: memory.view().revision });
        if (applied.memoryChanged) semantic.memoryChanged();
        return { ...result, applied: applied.applied, reviewId: applied.reviewId ?? result.reviewId, retryQueued: true, replacementReviewId: (replacement as any).id, replacementResult: applied };
      } catch (error) {
        return { ...result, retryQueued: false, retryReason: error instanceof Error ? error.message : "重新复核失败" };
      }
    };
    const applyCompressionReview = async (review: unknown) => {
      const id = (review as { id?: unknown })?.id;
      if (typeof id !== "string" || !id) throw new Error("压缩复核结果缺少标识");
      const result = memory.autoApplyCompressionReview({ id, revision: memory.view().revision });
      if (result.memoryChanged) semantic.memoryChanged();
      return retryStaleCompression(result, true);
    };
    const autoCompression = createAutoCompression(storage, ctx.events, () => compressionCandidates("regular"), reviewCompressionCandidate, Date.now,
      applyCompressionReview);
    const autoReflection = createAutoReflection(storage, ctx.events, async (autoSignal) => {
      if (reviewController) throw new Error("已有记忆复核正在进行");
      const controller = new AbortController(); reviewController = controller;
      const signal = AbortSignal.any([controller.signal, autoSignal, ctx.signal]);
      try {
        const before = new Set(memory.view().profileChanges.map((change) => change.id));
        const result = await memory.reviewProfiles((prompt) => generate(prompt, signal), signal);
        let applied = 0;
        // 画像反思候选与自动采用共用同一置信度门槛，并继续通过
        // profileChanges 事务层落盘，因此可追溯、可撤销。
        for (const change of memory.view().profileChanges) {
          if (before.has(change.id) || change.status !== "pending" || (change.reflection?.confidence ?? 0) < PROFILE_REFLECTION_MIN_CONFIDENCE) continue;
          memory.resolveProfileChange({ id: change.id, action: "accept", revision: memory.view().revision });
          applied += 1;
        }
        return { ...result, applied };
      }
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
      // 本地 Dream 的 aging 蒸馏合并是 Dream 周期自己的第三阶段，不能
      // 依赖普通 active Compressor 是否开启。自动采用同样跟随 Dream 的
      // 自动采用开关；普通 Compressor 的开关只管理每 20 轮的 active 压缩。
      const autoApplyDream = storage.get<boolean>("auto-dream-apply-enabled") === true;
      const preservePendingDreamSources = !autoApplyDream;
      const candidates = compressionCandidates("dream").filter((candidate) => !preservePendingDreamSources || candidate.entryIds.every((id) => !cycleDreamEntryIds.has(id))).slice(0, 5);
      for (const candidate of candidates) {
        if (autoSignal.aborted || ctx.signal.aborted) throw new Error("梦境周期已取消");
        try {
          const review = await reviewCompressionCandidate(candidate, autoSignal);
          compressionReviewed += 1;
          if (autoApplyDream && (await applyCompressionReview(review)).applied) compressionApplied += 1;
        } catch {
          if (autoSignal.aborted || ctx.signal.aborted) throw new Error("梦境周期已取消");
        }
      }
      return { ...cycleCapacity, compressionReviewed, compressionApplied };
    });
    const retrieval = createRetrieval(storage, (query, expansions, semanticIds, rerankedIds, selectedIds, maxChars, includeExpired, purpose, plan, semanticScores) => memory.searchWithBudget(query, expansions, semanticIds, rerankedIds, selectedIds, maxChars, includeExpired, purpose, plan, semanticScores),
      generate, async (query, signal, includeExpired, plan) => {
        if (!ctx.deps.memoryRetrieval || vectors.view().entries === 0) return [];
        const retrievalCandidates = memory.retrievalCandidates(includeExpired);
        const textById = new Map(retrievalCandidates.map((candidate) => [candidate.id, candidate.text]));
        const candidates = vectors.records(retrievalCandidates.map((candidate) => candidate.id)).flatMap((record) => {
          const text = textById.get(record.id);
          return text ? [{ ...record, text }] : [];
        });
        if (!candidates.length) return [];
        const resolved = plan ?? resolveRetrievalPlan(query);
        const queryKinds = resolved.queryKinds ?? [];
        const kindCandidateIds = queryKinds.length ? memory.view().entries
          .filter((entry) => entry.facets?.source === "model" && queryKinds.some((kind) => entry.facets?.retrievalKinds.includes(kind)))
          .map((entry) => entry.id) : [];
        const result = await rankLocalMemoryCandidates(ctx.deps.memoryRetrieval, query, candidates, resolved.candidateDepth, kindCandidateIds, signal);
        // 本地自动注入传 recordRecall:false；只有最终真实召回才更新 L2 状态。
        return {
          ids: result.ids,
          scores: result.scores,
        };
      }, undefined, undefined,
      (query, expansions, semanticIds, rerankedIds, plan, semanticScores) => memory.injectionCandidateIds(query, expansions, semanticIds, rerankedIds, plan, semanticScores),
      (baseIds) => dmae.preview(baseIds, memory.view().entries, new Set(memory.dmaeExcludedEntryIds())).selectedIds,
      (includedIds, recalledIds) => {
        recentInjections.record(recalledIds);
        const entries = memory.view().entries;
        dmae.commit(recalledIds, includedIds, entries);
        const recall = lifecycle.record(recalledIds, entries);
        if (recall.reactivateIds.length > 0) {
          memory.reactivateLifecycleEntries({ entryIds: recall.reactivateIds, revision: memory.view().revision });
          semantic.memoryChanged();
        }
      }, (query) => entityGraph.search(query), queryRouter.route, (ids) => {
        const entries = memory.view().entries;
        const liveIds = new Set(entries.filter((entry) => entry.status === "active" || entry.status === "aging").map((entry) => entry.id));
        const recall = lifecycle.record(ids.filter((id) => liveIds.has(id)), entries, true);
        if (recall.reactivateIds.length > 0) {
          memory.reactivateLifecycleEntries({ entryIds: recall.reactivateIds, revision: memory.view().revision });
          semantic.memoryChanged();
        }
      });
    const history = createHistoryRetrieval({
      turns: () => memory.view().turns,
      hostMessages: createHostHistorySource(ctx.deps.conversations).snapshot,
      service: ctx.deps.memoryRetrieval,
      storage,
      routeQuery: queryRouter.route,
    });
    const toolMemoryIds = async (query: string, topK: number, signal: AbortSignal): Promise<string[]> => {
      const service = ctx.deps.memoryRetrieval;
      if (!service || vectors.view().entries === 0) return [];
      const texts = new Map(memory.retrievalCandidates(true).map((item) => [item.id, item.text]));
      const candidates = vectors.records([...texts.keys()]).flatMap((record) => {
        const text = texts.get(record.id);
        return text ? [{ ...record, text }] : [];
      });
      if (!candidates.length) return [];
      const hybrid = await service.rank({ query, candidates, topK: 20, mode: "hybrid", rawScore: true, rerank: false, signal });
      vectors.recordSearchHits(hybrid.vectorHitIds);
      const lexical = await service.rank({ query, candidates, topK: 5, mode: "lexical", rerank: false, signal });
      const lexicalIds = (lexical.ranked ?? []).filter((item) => item.score > 0).map((item) => item.id);
      const positiveHybridIds = (hybrid.ranked ?? []).filter((item) => item.score > 0).map((item) => item.id);
      const ids = hybrid.ranked ? positiveHybridIds : [...hybrid.rankedIds];
      for (const id of lexicalIds) {
        if (ids.includes(id)) continue;
        if (ids.length >= 20) ids.pop();
        ids.push(id);
      }
      const byId = new Map(candidates.map((item) => [item.id, item.text]));
      let reranked = false;
      if (service.rerankDocuments && ids.length) {
        try {
          const ranked = await service.rerankDocuments({ query, documents: ids.map((id) => byId.get(id)!), signal });
          if (ranked) {
            const byText = new Map<string, string[]>();
            for (const id of ids) {
              const text = byId.get(id)!;
              byText.set(text, [...(byText.get(text) ?? []), id]);
            }
            const ordered = ranked.filter((item) => item.score >= -6)
              .flatMap((item) => byText.get(item.text)?.splice(0, 1) ?? []);
            ids.splice(0, ids.length, ...ordered);
            reranked = true;
          }
        } catch (error) {
          if (signal.aborted) throw error;
          console.warn("[companion-memory] 工具记忆重排失败，使用混合排序:", error);
        }
      }
      if (!reranked && lexicalIds[0] && ids.indexOf(lexicalIds[0]) > 0) {
        ids.unshift(...ids.splice(ids.indexOf(lexicalIds[0]), 1));
      }
      return ids.slice(0, topK);
    };
    const proactiveReceipts = new Map<string, { includedMemoryIds: string[]; recalledMemoryIds: string[] }>();
    const peer = createPeer(ctx, CHAT_ID, async (method, data, signal) => {
      if (ctx.signal.aborted) throw new Error("插件已停止");
      switch (method) {
        case "search": return retrieval.search(data, signal);
        case "search-for-chat": return retrieval.searchForChat(data, signal);
        case "search-for-proactive": return retrieval.searchForProactive(data, signal);
        case "preview-for-proactive": {
          const value = data as { runId?: unknown; query?: unknown };
          if (typeof value?.runId !== "string" || !value.runId) throw new Error("主动消息轮次无效");
          const receipt = await retrieval.previewForProactive(value.query, signal);
          proactiveReceipts.set(value.runId, receipt);
          return receipt.text;
        }
        case "commit-proactive-receipt": {
          const runId = data as string;
          const receipt = proactiveReceipts.get(runId);
          proactiveReceipts.delete(runId);
          if (receipt) retrieval.commitPromptReceipt(receipt);
          return Boolean(receipt);
        }
        case "discard-proactive-receipt": proactiveReceipts.delete(data as string); return true;
        case "entity-for-proactive": return typeof data === "string" ? entityGraph.search(data) : "";
        case "profile-for-proactive": return [memory.profileContext(), dream.context()].filter(Boolean).join("\n\n");
        case "search-for-tool": {
          const query = typeof data === "string" ? data : (data as { query?: unknown })?.query;
          if (typeof query !== "string" || !query.trim() || query.length > 20_000) throw new Error("查询无效");
          const topK = resolveToolTopK(typeof data === "object" && data !== null ? (data as { topK?: unknown }).topK : undefined);
          return retrieval.searchForTool(data, signal, await toolMemoryIds(query, topK, signal));
        }
        case "search-history-for-tool": {
          const value = data as { query?: unknown; userQuery?: unknown; days?: unknown; topK?: unknown };
          const days = value?.days === undefined ? 90 : Number(value.days);
          if (!Number.isFinite(days) || days <= 0 || days > 36_500) throw new Error("历史查询天数无效");
          return history.searchForTool(value?.query, signal, days, value?.userQuery, value?.topK);
        }
        case "search-images-for-tool": {
          const value = data as { query?: unknown; imageId?: unknown };
          return history.searchImagesForTool(value?.query, signal, value?.imageId);
        }
        case "search-history-for-auto": return history.searchForAuto(data, signal);
        case "ingest": return memory.ingest(data);
        case "view": return memory.view();
        case "maintain": {
          return maintainMemory((prompt) => generate(prompt, signal), signal);
        }
        default: throw new Error("未知请求");
      }
    });
    const native = createNativeIntegration(ctx, {
      ingest: (turn) => memory.ingest(turn),
      maintain: (generate, signal, validateSources) => maintainMemory(generate, signal, validateSources),
      previewArchivedRecall: (raw) => memory.previewArchivedRecall(raw),
      restoreArchivedFromPrompt: (candidate) => {
        const result = memory.restoreArchivedFromPrompt(candidate);
        semantic.memoryChanged();
        return result;
      },
      undoColdActivation: (id) => {
        memory.undoLifecycleTransition({ id, revision: memory.view().revision });
        semantic.memoryChanged();
      },
    }, retrieval, social, history, queryRouter.route, () => {
      relationship.reconcile(memory.view().turns);
      return [memory.profileContext(), dream.context(), relationship.context()].filter(Boolean).join("\n\n");
    });
    const offChatPreferences = ctx.events.on<{
      chatBackend?: "native" | "companion";
      chatSocialContextEnabled?: boolean;
    }>("host:chat-preferences:changed", (preferences) => {
      const current = native.view().settings;
      const enabled = preferences.chatBackend === "companion"
        && preferences.chatSocialContextEnabled === true;
      native.configure({
        ...current,
        captureEnabled: enabled,
        autoExtractEnabled: enabled,
        promptInjectionEnabled: enabled,
        socialContextEnabled: enabled,
      });
    });
    const nativeHistory = createNativeHistory(ctx, memory);
    const offHistoryTurnFinished = ctx.events.on<PluginTurnFinishedEvent>("host:turn:finished", (event) => {
      if (event.source !== "desktop" || event.mode !== "chat" || event.status !== "success"
        || !event.finalMessageId || !ctx.deps.conversations || ctx.signal.aborted) return;
      void (async () => {
        const messages = [];
        let cursor: string | undefined;
        do {
          const page = await ctx.deps.conversations!.getMessages(cursor
            ? { conversationId: event.conversationId, cursor, limit: 100, historyProjection: true }
            : { conversationId: event.conversationId, fromMessageId: event.inputMessageId,
              throughMessageId: event.finalMessageId, limit: 100, historyProjection: true });
          if (page.range.fromMessageId !== event.inputMessageId || page.range.throughMessageId !== event.finalMessageId) {
            throw new Error("历史索引轮次边界与宿主事件不一致");
          }
          messages.push(...page.items.filter((item) => item.id === event.inputMessageId || item.id === event.finalMessageId));
          cursor = page.nextCursor;
        } while (cursor);
        if (messages.length !== 2 || messages[0].role !== "user" || messages[1].role !== "assistant") {
          throw new Error("历史索引轮次消息不完整");
        }
        await history.indexPersistedHostMessages(messages.map((message) => ({
          id: message.id, sessionId: event.conversationId, role: message.role,
          text: message.text, at: Date.parse(message.at),
        })), ctx.signal);
      })().catch((error) => ctx.log(`[companion-memory] 历史消息索引初始化失败: ${String(error)}`));
    });
    const offConversationChanged = ctx.events.on<PluginConversationChangedEvent>("host:conversation:changed", (event) => {
      const result = memory.invalidateHostSources(event);
      native.invalidateColdRecall(event.conversationId, event.allMessages, event.invalidatedMessageIds);
      history.invalidateHostMessages(event.conversationId, event.allMessages, event.invalidatedMessageIds);
      for (const id of result.invalidatedEntryIds) {
        vectors.removeGenerated(id);
        dmae.remove(id);
        lifecycle.remove(id);
      }
      if (result.changed) {
        semantic.memoryChanged();
        history.clearCache();
        nativeHistory.clear();
      }
    });
    const window = createWindow(ctx, __dirname, "独立记忆档案");
    openWindow = window.open;
    stop = () => { offChatPreferences(); offHistoryTurnFinished(); offConversationChanged(); reviewController?.abort(); autoDream.stop(); autoLifecycle.stop(); autoReflection.stop(); autoCompression.stop(); autoReview.stop(); autoMaintenance.stop(); semantic.stop(); recentInjections.clear(); history.clearCache(); nativeHistory.clear(); native.stop(); peer.stop(); window.close(); openWindow = undefined; };
    ctx.onDispose(stop);
    registerUi(ctx, async (action, data) => {
      if (action === "state") return { ...memory.view(), relationshipLog: relationship.view(), entityGraph: entityGraph.view(), queryRouter: await queryRouter.view(), queryExpansion: retrieval.view(), reranker: reranker.view(), dmae: dmae.view(), lifecycle: lifecycle.view(), autoLifecycle: autoLifecycle.view(), dream: dream.view(), autoDream: autoDream.view(), maintenanceInbox: inbox.view(memory.view().entries), autoMaintenance: autoMaintenance.view(), autoReview: autoReview.view(), autoCompression: autoCompression.view(), autoReflection: autoReflection.view(), embedding: await embeddings.view(), vectorIndex: vectors.view(), semanticIndex: semantic.view(), social: social.view(), native: native.view(), defaultLegacyMemoryPath: defaultLegacyMemoryPath(), defaultLegacyVectorPath: defaultLegacyVectorPath() };
      if (action === "get-query-router") return queryRouter.view();
      if (action === "save-query-router") return queryRouter.save(data);
      if (action === "test-query-router") return queryRouter.test(ctx.signal);
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
      if (action === "undo-detected-conflict") { const result = memory.undoDetectedConflict(data); semantic.memoryChanged(); return result; }
      if (action === "preview-archived-recall") return memory.previewArchivedRecall(data);
      if (action === "cold-recall-for-conversation") return native.coldRecallForConversation(data?.conversationId);
      if (action === "resolve-cold-recall") return native.resolveColdRecall(data);
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
        if (result.contentChanged) dmae.remove(result.entryId);
        semantic.memoryChanged();
        return result;
      }
      if (action === "delete-entry") {
        const result = memory.deleteEntry(data);
        vectors.removeGenerated(result.deletedId);
        dmae.remove(result.deletedId);
        lifecycle.remove(result.deletedId);
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
        if (result.compressionChange.createdId || result.compressionChange.removedId) semantic.memoryChanged();
        if ("stale" in result.compressionChange && result.compressionChange.stale) return { ...result, compressionRetry: await retryStaleCompression(result.compressionChange, false) };
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
