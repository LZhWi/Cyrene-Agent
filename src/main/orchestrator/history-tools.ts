// 历史对话召回工具 —— 让昔涟能"回忆"滚出上下文窗口的对话。
//
// 设计（见 docs/history-and-skill-architecture.md）：
// - 不切分、不压缩、不启发式。全部历史无损存入向量库，模型主动召回。
// - 存：每轮 user + assistant 消息用 addHistoryMemory 存入 source="chat_history"
// - 取：recall_history 工具语义检索，按时间排序返回
//
// 复用现有 RAG 引擎（addHistoryMemory / searchHistoryEntries），不另建存储层。

import * as fs from "fs";
import * as path from "path";
import {
  addHistoryMemory,
  deleteHistoryEntriesBySessionId,
  getEntriesBySource,
  searchHistoryEntries,
} from "../rag";
import { getUserDataDir } from "../runtime/runtime-paths";
import {
  buildHistoryRetrievalIntentQuery,
  expandHistoryRetrievalQuery,
  type HistoryRetrievalHit,
  isHistoryRetrievalDiagnosticsEnabled,
  runHistoryRetrievalV2Shadow,
  sanitizeHistoryRetrievalQuery,
} from "./history-retrieval-diagnostics";
import { toolRegistry } from "./tool-registry";

const LOG_PREFIX = "[History]";
const HISTORY_ADJACENT_MAX_GAP_MS = 5 * 60 * 1000;

interface StoredHistoryEntry {
  text: string;
  createdAt: number;
  weight: number;
  metadata?: Record<string, unknown>;
}

interface TimelineHistoryEntry extends HistoryRetrievalHit {
  sessionId: string;
  role: "user" | "assistant";
}

function historyHitKey(hit: Pick<HistoryRetrievalHit, "text" | "createdAt" | "metadata">): string {
  return [
    String(hit.metadata?.sessionId ?? ""),
    String(hit.metadata?.role ?? ""),
    String(hit.createdAt),
    hit.text.normalize("NFC").replace(/\r\n?/g, "\n").trim(),
  ].join("\u0000");
}

function materializeHistoryTimeline(entries: StoredHistoryEntry[]): TimelineHistoryEntry[] {
  const timeline: TimelineHistoryEntry[] = [];
  for (const entry of entries) {
    const occurrences = Array.isArray(entry.metadata?.occurrences)
      ? entry.metadata.occurrences
      : [];
    const usableOccurrences = occurrences.filter((item): item is {
      sessionId: string;
      role: "user" | "assistant";
      ts: number;
    } => Boolean(item) && typeof item === "object"
      && typeof (item as { sessionId?: unknown }).sessionId === "string"
      && ((item as { role?: unknown }).role === "user" || (item as { role?: unknown }).role === "assistant")
      && typeof (item as { ts?: unknown }).ts === "number");
    if (usableOccurrences.length > 0) {
      for (const occurrence of usableOccurrences) {
        timeline.push({
          text: entry.text,
          createdAt: occurrence.ts,
          score: entry.weight,
          metadata: { ...entry.metadata, ...occurrence },
          sessionId: occurrence.sessionId,
          role: occurrence.role,
        });
      }
      continue;
    }
    const sessionId = entry.metadata?.sessionId;
    const role = entry.metadata?.role;
    if (typeof sessionId === "string" && (role === "user" || role === "assistant")) {
      timeline.push({
        text: entry.text,
        createdAt: entry.createdAt,
        score: entry.weight,
        metadata: entry.metadata,
        sessionId,
        role,
      });
    }
  }
  return timeline.sort((a, b) => a.createdAt - b.createdAt);
}

export function reconcileHistoryHitsWithTimeline(
  hits: HistoryRetrievalHit[],
  entries: StoredHistoryEntry[],
): HistoryRetrievalHit[] {
  const timeline = materializeHistoryTimeline(entries);
  const byText = new Map<string, TimelineHistoryEntry[]>();
  for (const item of timeline) {
    const key = item.text.normalize("NFC").replace(/\r\n?/g, "\n").trim();
    const group = byText.get(key) ?? [];
    group.push(item);
    byText.set(key, group);
  }
  return hits.map((hit) => {
    const key = hit.text.normalize("NFC").replace(/\r\n?/g, "\n").trim();
    const match = (byText.get(key) ?? []).sort((a, b) => (
      Math.abs(a.createdAt - hit.createdAt) - Math.abs(b.createdAt - hit.createdAt)
    ))[0];
    if (!match) return hit;
    return {
      ...hit,
      createdAt: match.createdAt,
      metadata: { ...hit.metadata, ...match.metadata },
    };
  });
}

export function expandHistoryHitsWithSentenceWindows(
  hits: HistoryRetrievalHit[],
): HistoryRetrievalHit[] {
  const maxWindowsPerHit = 6;
  const maxExpandedCandidates = 96;
  const result: HistoryRetrievalHit[] = [];
  const seen = new Set<string>();
  for (const hit of hits) {
    const cleanText = hit.text.replace(/\[sticker:[^\]]+\]/giu, "").trim();
    if (cleanText.length <= 140) {
      const key = cleanText.normalize("NFC");
      if (!seen.has(key)) {
        seen.add(key);
        result.push(hit);
      }
      continue;
    }
    const sentences = cleanText
      .split(/(?<=[。！？!?；;.])|\n{2,}/u)
      .map((sentence) => sentence.trim())
      .filter((sentence) => sentence.length >= 8);
    const windows: string[] = [];
    for (let index = 0; index < sentences.length && windows.length < maxWindowsPerHit; index += 1) {
      let window = sentences[index];
      while (window.length < 60 && index + 1 < sentences.length && window.length + sentences[index + 1].length <= 220) {
        index += 1;
        window += sentences[index];
      }
      if (window.length > 220) window = window.slice(0, 220);
      if (window.length >= 12) windows.push(window);
    }
    if (windows.length === 0) windows.push(cleanText.slice(0, 220));
    const originalKey = hit.text.normalize("NFC");
    if (!seen.has(originalKey)) {
      seen.add(originalKey);
      result.push(hit);
      if (result.length >= maxExpandedCandidates) return result;
    }
    for (const window of windows) {
      const key = window.normalize("NFC");
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({
        ...hit,
        text: window,
        metadata: {
          ...hit.metadata,
          retrievalExpansion: "sentence_window",
          retrievalParentText: hit.text,
        },
      });
      if (result.length >= maxExpandedCandidates) return result;
    }
  }
  return result;
}

export async function rerankHistoryCandidatesForSandbox(
  query: string,
  documents: string[],
  rerank: (query: string, documents: string[]) => Promise<Array<{ text: string; score: number }>>,
): Promise<Array<{ text: string; score: number }>> {
  const explicitIntentMatchBoost = 0.016;
  const cleanQuery = sanitizeHistoryRetrievalQuery(query);
  const expandedQuery = expandHistoryRetrievalQuery(cleanQuery);
  const focusedQuery = buildHistoryRetrievalIntentQuery(cleanQuery);
  const queries = focusedQuery && focusedQuery !== cleanQuery
    ? [{ query: cleanQuery, weight: 0.35 }, { query: focusedQuery, weight: 0.65 }]
    : [{ query: cleanQuery || query, weight: 1 }];
  const rankings = await Promise.all(queries.map((item) => rerank(item.query, documents)));
  const fused = new Map<string, number>();
  rankings.forEach((ranking, queryIndex) => {
    ranking.forEach((item, rankIndex) => {
      const score = fused.get(item.text) ?? 0;
      fused.set(item.text, score + queries[queryIndex].weight / (8 + rankIndex + 1));
    });
  });
  const intentTerms = expandedQuery.startsWith(`${cleanQuery} `)
    ? expandedQuery.slice(cleanQuery.length + 1).split(/\s+/u).filter((term) => term.length >= 2)
    : [];
  return documents
    .map((text) => {
      const lexicalMatches = intentTerms.filter((term) => text.includes(term)).length;
      return {
        text,
        score: (fused.get(text) ?? 0) + Math.min(lexicalMatches, 2) * explicitIntentMatchBoost,
      };
    })
    .sort((a, b) => b.score - a.score);
}

export function diversifySandboxRerankResults(
  ranked: Array<{ text: string; score: number }>,
  candidates: HistoryRetrievalHit[],
  finalK = 5,
): Array<{ text: string; score: number }> {
  if (ranked.length <= finalK) return ranked;
  const candidateByText = new Map(candidates.map((candidate) => [candidate.text, candidate]));
  const roleByText = new Map(candidates.map((candidate) => [candidate.text, candidate.metadata?.role]));
  const isShortAssistantFollowUp = (text: string): boolean => {
    const candidate = candidateByText.get(text);
    const compactText = text.replace(/\s+/gu, " ").trim();
    return candidate?.metadata?.role === "assistant"
      && compactText.length < 140
      && /[?？]|(?:吗|呢|是不是|有没有|怎么样)[。！…]*$/u.test(compactText);
  };
  const evidenceRanked = ranked.map((item) => {
    const candidate = candidateByText.get(item.text);
    const expansion = candidate?.metadata?.retrievalExpansion;
    const compactText = item.text.replace(/\s+/gu, " ").trim();
    let multiplier = 1;
    if (expansion === "sentence_window") multiplier *= 1.06;
    else if (!expansion && compactText.length >= 140) multiplier *= 1.03;
    if (expansion === "adjacent_turn") multiplier *= 0.9;
    if (isShortAssistantFollowUp(item.text)) multiplier *= 0.86;
    return { ...item, score: item.score * multiplier };
  }).sort((a, b) => b.score - a.score);
  const selected = evidenceRanked.slice(0, finalK);
  const deferred = evidenceRanked.slice(finalK);
  const cutoffScore = selected[selected.length - 1]?.score ?? 0;
  for (const desiredRole of ["user", "assistant"] as const) {
    const desiredCount = selected.filter((item) => roleByText.get(item.text) === desiredRole).length;
    if (desiredCount >= 2) continue;
    const replacement = deferred.find((item) => (
      roleByText.get(item.text) === desiredRole
      && item.score >= cutoffScore * 0.8
    ));
    if (!replacement) continue;
    const replaceIndex = [...selected].reverse().findIndex((item) => {
      const role = roleByText.get(item.text);
      return role !== desiredRole
        && selected.filter((selectedItem) => roleByText.get(selectedItem.text) === role).length > 2;
    });
    if (replaceIndex < 0) continue;
    selected[selected.length - 1 - replaceIndex] = replacement;
  }
  const selectedTextsBeforeParentPromotion = new Set(selected.map((item) => item.text));
  const selectedParentTexts = [...new Set(selected.flatMap((item) => {
    const parentText = candidateByText.get(item.text)?.metadata?.retrievalParentText;
    return typeof parentText === "string" ? [parentText] : [];
  }))];
  for (const parentText of selectedParentTexts) {
    if (selectedTextsBeforeParentPromotion.has(parentText)) continue;
    const parent = deferred.find((item) => (
      item.text === parentText
      && item.score >= cutoffScore * 0.75
    ));
    if (!parent) continue;
    const replaceIndex = selected.findIndex((item) => isShortAssistantFollowUp(item.text));
    const adjacentIndex = replaceIndex >= 0 ? -1 : selected.findIndex((item) => (
      candidateByText.get(item.text)?.metadata?.retrievalExpansion === "adjacent_turn"
    ));
    const targetIndex = replaceIndex >= 0 ? replaceIndex : adjacentIndex;
    if (targetIndex < 0) continue;
    selected[targetIndex] = parent;
    break;
  }
  const selectedTexts = new Set(selected.map((item) => item.text));
  return [
    ...selected,
    ...evidenceRanked.filter((item) => !selectedTexts.has(item.text)),
  ];
}

export function expandHistoryHitsWithAdjacentTurns(
  hits: HistoryRetrievalHit[],
  entries: StoredHistoryEntry[] = getEntriesBySource("chat_history"),
  excludedKeys: ReadonlySet<string> = new Set(),
  bounds: { createdAfter?: number; createdBefore?: number } = {},
): HistoryRetrievalHit[] {
  const timeline = materializeHistoryTimeline(entries).filter((item) => (
    (bounds.createdAfter === undefined || item.createdAt >= bounds.createdAfter)
    && (bounds.createdBefore === undefined || item.createdAt < bounds.createdBefore)
  ));
  const bySession = new Map<string, TimelineHistoryEntry[]>();
  for (const item of timeline) {
    const group = bySession.get(item.sessionId) ?? [];
    group.push(item);
    bySession.set(item.sessionId, group);
  }
  const result = hits.filter((hit) => !excludedKeys.has(historyHitKey(hit)));
  const seen = new Set(result.map((hit) => historyHitKey(hit)));
  for (const hit of [...result]) {
    const sessionId = hit.metadata?.sessionId;
    const role = hit.metadata?.role;
    if (typeof sessionId !== "string" || (role !== "user" && role !== "assistant")) continue;
    const session = bySession.get(sessionId) ?? [];
    const index = session.findIndex((entry) => historyHitKey(entry) === historyHitKey(hit));
    if (index < 0) continue;
    const neighbor = role === "user" ? session[index + 1] : session[index - 1];
    if (!neighbor || neighbor.role === role) continue;
    if (Math.abs(neighbor.createdAt - hit.createdAt) > HISTORY_ADJACENT_MAX_GAP_MS) continue;
    const key = historyHitKey(neighbor);
    if (seen.has(key) || excludedKeys.has(key)) continue;
    seen.add(key);
    result.push({
      text: neighbor.text,
      createdAt: neighbor.createdAt,
      score: hit.score,
      metadata: { ...neighbor.metadata, retrievalExpansion: "adjacent_turn" },
    });
  }
  return result;
}

export function collectRepeatedTestTurnKeys(
  userQuery: string,
  entries: StoredHistoryEntry[] = getEntriesBySource("chat_history"),
): Set<string> {
  const cleanQuery = sanitizeHistoryRetrievalQuery(userQuery);
  const timeline = materializeHistoryTimeline(entries);
  const excluded = new Set<string>();
  for (let index = 0; index < timeline.length; index += 1) {
    const item = timeline[index];
    if (item.role !== "user" || sanitizeHistoryRetrievalQuery(item.text) !== cleanQuery) continue;
    excluded.add(historyHitKey(item));
    const next = timeline[index + 1];
    if (next?.sessionId === item.sessionId
      && next.role === "assistant"
      && next.createdAt - item.createdAt <= HISTORY_ADJACENT_MAX_GAP_MS) {
      excluded.add(historyHitKey(next));
    }
  }
  return excluded;
}

export interface HistoryRetrievalSandboxResult {
  query: string;
  excludedRepeatedTestRecords: number;
  excludedOrphanedRecords: number;
  baseline: HistoryRetrievalHit[];
  selected: HistoryRetrievalHit[];
  candidates: Array<HistoryRetrievalHit & {
    candidateRank: number;
    sources: Array<{ channel: string; query: string; rank: number; score: number }>;
    rerankerScore: number | null;
    selectedRank: number | null;
  }>;
  method: "reranker" | "rrf";
  candidateCount: number;
  queryVariants: Array<{ channel: string; query: string }>;
}

export async function runHistoryRetrievalSandbox(
  userQuery: string,
  days = 90,
  authoritativeEntries?: StoredHistoryEntry[],
): Promise<HistoryRetrievalSandboxResult> {
  const query = userQuery.trim();
  if (!query) throw new Error("测试问题不能为空");
  const now = Date.now();
  const cutoff = now - days * 24 * 60 * 60 * 1000;
  const historyEntries = getEntriesBySource("chat_history");
  const timelineEntries = authoritativeEntries?.length ? authoritativeEntries : historyEntries;
  const excludedKeys = collectRepeatedTestTurnKeys(query, timelineEntries);
  const authoritativeTexts = authoritativeEntries?.length
    ? new Set(authoritativeEntries.map((entry) => entry.text.normalize("NFC").replace(/\r\n?/g, "\n").trim()))
    : null;
  const excludedOrphanedTexts = new Set<string>();
  const searchWithoutTestTurns = async (
    shadowQuery: string,
    depth: number,
    options: { rawScore?: boolean; semanticOnly?: boolean } = {},
  ): Promise<HistoryRetrievalHit[]> => {
    const extraDepth = Math.min(excludedKeys.size, 12) + (authoritativeTexts ? 24 : 0);
    const hits = await searchHistoryEntries(shadowQuery, depth + extraDepth, {
      recordRecall: false,
      createdAfter: cutoff,
      ...options,
    });
    const filtered = hits.filter((hit) => {
      if (excludedKeys.has(historyHitKey(hit))) return false;
      const normalizedText = hit.text.normalize("NFC").replace(/\r\n?/g, "\n").trim();
      if (authoritativeTexts && !authoritativeTexts.has(normalizedText)) {
        excludedOrphanedTexts.add(normalizedText);
        return false;
      }
      return true;
    }).slice(0, depth);
    return authoritativeEntries?.length
      ? reconcileHistoryHitsWithTimeline(filtered, authoritativeEntries)
      : filtered;
  };
  const baseline = await searchWithoutTestTurns(query, 5);
  const { createStandardReranker, getRerankerInstallStatus } = await import("../rag/reranker");
  let reranker;
  if (getRerankerInstallStatus().standard) {
    try {
      reranker = await createStandardReranker();
    } catch (error) {
      console.warn("[History/RetrievalSandbox] reranker unavailable, using RRF:", error);
    }
  }
  let selected: HistoryRetrievalHit[] = [];
  let candidates: HistoryRetrievalHit[] = [];
  const record = await runHistoryRetrievalV2Shadow({
    userQuery: query,
    toolQuery: query,
    days,
    baseline,
    search: (shadowQuery, depth) => searchWithoutTestTurns(shadowQuery, depth),
    semanticSearch: (shadowQuery, depth) => searchWithoutTestTurns(shadowQuery, depth, {
      rawScore: true,
      semanticOnly: true,
    }),
    rerank: reranker
      ? async (rerankQuery, documents) => diversifySandboxRerankResults(
          await rerankHistoryCandidatesForSandbox(
            rerankQuery,
            documents,
            (focusedQuery, focusedDocuments) => reranker.rerank(focusedQuery, focusedDocuments),
          ),
          candidates,
        )
      : undefined,
    expandCandidates: (hits) => expandHistoryHitsWithSentenceWindows(
      expandHistoryHitsWithAdjacentTurns(hits, timelineEntries, excludedKeys, { createdAfter: cutoff }),
    ),
    enabled: true,
    source: "sandbox",
    writeLog: false,
    onCandidates: (hits) => { candidates = hits; },
    onResult: (hits) => { selected = hits; },
  });
  if (!record) throw new Error("检索沙箱未能生成结果");
  return {
    query,
    excludedRepeatedTestRecords: excludedKeys.size,
    excludedOrphanedRecords: excludedOrphanedTexts.size,
    baseline,
    selected,
    candidates: candidates.map((hit, index) => {
      const trace = record.selectionTrace[index];
      return {
        ...hit,
        candidateRank: index + 1,
        sources: trace?.sources ?? [],
        rerankerScore: trace?.rerankerScore ?? null,
        selectedRank: trace?.selectedRank ?? null,
      };
    }),
    method: record.method,
    candidateCount: record.candidateCount,
    queryVariants: record.queryVariants,
  };
}

const HISTORY_AUTO_PROBE_CUE = /还记得|记不记得|记得吗|上次|之前|以前|前几天|当时|我们说过|提过|答应过/u;

export function shouldAutoProbeHistoryRetrieval(userQuery: string): boolean {
  const clean = userQuery
    .replace(/^\s*\[[^\]\n]{1,120}\]\s*/u, "")
    .replace(/[（(]\s*用户发送表情包\s*[：:]?[\s\S]*?[）)]/gu, " ")
    .replace(/\[sticker:[^\]]+\]/giu, " ")
    .trim();
  return clean.length >= 3 && HISTORY_AUTO_PROBE_CUE.test(clean);
}

export async function runHistoryRetrievalV2AutoProbe(
  userQuery: string,
  days = 90,
  createdBefore?: number,
): Promise<void> {
  if (!isHistoryRetrievalDiagnosticsEnabled() || !shouldAutoProbeHistoryRetrieval(userQuery)) return;

  const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
  const cleanUserQuery = sanitizeHistoryRetrievalQuery(userQuery);
  const baseline = (await searchHistoryEntries(userQuery, 5, {
    recordRecall: false,
    createdAfter: cutoff,
  })).filter((hit) => sanitizeHistoryRetrievalQuery(hit.text) !== cleanUserQuery);
  const { createStandardReranker, getRerankerInstallStatus } = await import("../rag/reranker");
  let reranker;
  if (getRerankerInstallStatus().standard) {
    try {
      reranker = await createStandardReranker();
    } catch (error) {
      console.warn("[History/RetrievalV2AutoProbe] reranker unavailable, using RRF:", error);
    }
  }
  const historyEntries = getEntriesBySource("chat_history");
  await runHistoryRetrievalV2Shadow({
    userQuery,
    toolQuery: userQuery,
    days,
    baseline,
    search: (shadowQuery, depth) => searchHistoryEntries(shadowQuery, depth, {
      recordRecall: false,
      createdAfter: cutoff,
    }),
    semanticSearch: (shadowQuery, depth) => searchHistoryEntries(shadowQuery, depth, {
      recordRecall: false,
      createdAfter: cutoff,
      rawScore: true,
      semanticOnly: true,
    }),
    rerank: reranker ? (rerankQuery, documents) => reranker.rerank(rerankQuery, documents) : undefined,
    createdBefore,
    expandCandidates: (hits) => expandHistoryHitsWithAdjacentTurns(hits, historyEntries, new Set(), {
      createdAfter: cutoff,
      createdBefore,
    }),
    enabled: true,
    source: "auto_probe",
  });
}

/**
 * 把一轮对话存入向量库。在 agui-bridge 的 complete 回调里调用。
 * user 和 assistant 各存一条，方便按角色召回。
 * 每次出现写入 metadata.occurrences，供单轮删除时只移除对应位置。
 * 失败不抛错（历史存储是副作用，不能影响主流程）。
 */
export async function indexConversationTurn(
  sessionId: string,
  userText: string,
  assistantText: string,
  turnIds?: { userTurnId?: string; assistantTurnId?: string },
): Promise<void> {
  const ts = Date.now();
  try {
    if (userText) {
      await addHistoryMemory(userText, { sessionId, role: "user", ts, turnId: turnIds?.userTurnId });
    }
    if (assistantText) {
      await addHistoryMemory(assistantText, { sessionId, role: "assistant", ts, turnId: turnIds?.assistantTurnId });
    }
  } catch (e) {
    console.warn(LOG_PREFIX, "索引对话失败:", e);
  }
}

/** 注册 recall_history 工具。在 startup 调一次。 */
export function registerRecallHistoryTool(): void {
  toolRegistry.register({
    id: "recall_history",
    name: "回忆历史",
    description:
      "从所有历史对话中语义检索相关内容。返回按时间排序的相关片段（最多 5 条），每条带角色和时间戳。\n\n" +
      "何时用：\n" +
      "- 用户说「还记得」「上次」「之前」「那个」「前几天」等指代词\n" +
      "- 用户问的事在最近几轮对话里找不到答案\n" +
      "- 用户接续之前的话题但当前上下文没有细节\n\n" +
      "不要用于：\n" +
      "- 当前对话最近几轮里能直接看到的信息\n" +
      "- 完全无关的闲聊\n" +
      "- 用户从没提过的事（查不到就老实说不知道）\n\n" +
      "参数：query（必填，检索关键词或自然语言问题），days（可选，限制最近 N 天，默认 90）。",
    enabled: true,
    risk: "safe",
    needsContext: true,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索关键词或自然语言问题" },
        days: { type: "number", description: "可选，限制最近 N 天，默认 30" },
      },
      required: ["query"],
    },
    execute: async (args, ctx) => {
      const query = String(args.query || "").trim();
      if (!query) return "[错误] query 不能为空";

      const days = Number(args.days) || 90;
      const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
      const diagnosticsEnabled = isHistoryRetrievalDiagnosticsEnabled();

      let hits;
      try {
        hits = await searchHistoryEntries(query, 5);
      } catch (e) {
        return "[recall_history] 检索失败：" + (e instanceof Error ? e.message : String(e));
      }

      const filtered = hits.filter(h => h.createdAt >= cutoff);
      let selected = filtered;

      try {
        const { createStandardReranker, getRerankerInstallStatus } = await import("../rag/reranker");
        let reranker;
        if (getRerankerInstallStatus().standard) {
          try {
            reranker = await createStandardReranker();
          } catch (error) {
            console.warn("[History/RetrievalV2] reranker unavailable, using RRF:", error);
          }
        }
        const historyEntries = getEntriesBySource("chat_history");
        let candidates: HistoryRetrievalHit[] = [];
        await runHistoryRetrievalV2Shadow({
          userQuery: ctx?.userQuery?.trim() || query,
          toolQuery: query,
          days,
          baseline: filtered,
          search: (retrievalQuery, depth) => searchHistoryEntries(retrievalQuery, depth, {
            recordRecall: false,
            createdAfter: cutoff,
          }),
          semanticSearch: (retrievalQuery, depth) => searchHistoryEntries(retrievalQuery, depth, {
            recordRecall: false,
            createdAfter: cutoff,
            rawScore: true,
            semanticOnly: true,
          }),
          rerank: reranker
            ? async (rerankQuery, documents) => diversifySandboxRerankResults(
                await rerankHistoryCandidatesForSandbox(
                  rerankQuery,
                  documents,
                  (focusedQuery, focusedDocuments) => reranker.rerank(focusedQuery, focusedDocuments),
                ),
                candidates,
              )
            : undefined,
          expandCandidates: (candidateHits) => expandHistoryHitsWithSentenceWindows(
            expandHistoryHitsWithAdjacentTurns(candidateHits, historyEntries, new Set(), {
              createdAfter: cutoff,
            }),
          ),
          enabled: true,
          source: "tool",
          writeLog: diagnosticsEnabled,
          actualResultUnchanged: false,
          onCandidates: (candidateHits) => { candidates = candidateHits; },
          onResult: (v2Hits) => {
            if (v2Hits.length > 0) selected = v2Hits;
          },
        });
      } catch (error) {
        console.warn("[History/RetrievalV2] failed, using baseline:", error);
      }

      const finalHits = selected.slice(0, 5);
      if (finalHits.length === 0) {
        return `[recall_history] 没有找到关于 "${query}" 的历史记录`;
      }

      // 按时间正序（最早的在前），让对话脉络自然
      const sorted = [...finalHits].sort((a, b) => a.createdAt - b.createdAt);

      const lines = sorted.map(h => {
        const date = new Date(h.createdAt).toLocaleString("zh-CN");
        const role = h.metadata?.role === "user" ? "用户" : "昔涟";
        // 截断过长内容，避免吃太多 token
        const text = h.text.length > 300 ? h.text.slice(0, 300) + "..." : h.text;
        return `[${date}] ${role}：${text}`;
      });

      return `[recall_history] 找到 ${sorted.length} 条相关历史：\n\n${lines.join("\n\n")}`;
    },
  });
}

// ── 历史回填 ──
// 索引曾因去重评分膨胀静默停摆数周（见 vectorstore.add 的 rawScore 注释），
// 修复后把 cyrene-chats 会话日志一次性补进 chat_history 索引，恢复 recall_history 对旧对话的召回。
// - 幂等：v2 标记文件防重跑；即便重跑，相同 occurrence 也不会重复写入。
// - 时效：createdAt 保留消息原始时间（展示与时间排序用），lastRecalledAt 为回填时刻（初期不被衰减压低）。
// - 后台执行不阻塞启动；单条失败跳过，RAG 未初始化则中止且不写标记（下次启动重试）。
interface HistoryBackfillProgress {
  complete: boolean;
  doneSessions: string[];
  sessionOffsets: Record<string, number>;
  indexed: number;
  at: number;
}

function readBackfillProgress(marker: string): HistoryBackfillProgress {
  try {
    const parsed = JSON.parse(fs.readFileSync(marker, "utf8")) as Partial<HistoryBackfillProgress>;
    return {
      complete: parsed.complete === true,
      doneSessions: Array.isArray(parsed.doneSessions)
        ? parsed.doneSessions.filter((id): id is string => typeof id === "string")
        : [],
      sessionOffsets: parsed.sessionOffsets && typeof parsed.sessionOffsets === "object"
        ? parsed.sessionOffsets as Record<string, number>
        : {},
      indexed: typeof parsed.indexed === "number" ? parsed.indexed : 0,
      at: typeof parsed.at === "number" ? parsed.at : 0,
    };
  } catch {
    return { complete: false, doneSessions: [], sessionOffsets: {}, indexed: 0, at: 0 };
  }
}

function writeBackfillProgress(marker: string, progress: HistoryBackfillProgress): void {
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify(progress), "utf8");
}

export async function backfillChatHistoryFromChatLogs(): Promise<void> {
  try {
      const dataDir = getUserDataDir();
      const marker = path.join(dataDir, "rag-data", ".history-occurrences-backfill-v2");
      const indexFile = path.join(dataDir, "cyrene-chats", "index.json");
      if (!fs.existsSync(indexFile)) return;

      const sessions = JSON.parse(fs.readFileSync(indexFile, "utf8")) as Array<{ id?: string }>;
      const sessionIds = sessions.flatMap((session) => typeof session?.id === "string" ? [session.id] : []);
      let progress = fs.existsSync(marker)
        ? readBackfillProgress(marker)
        : { complete: false, doneSessions: [], sessionOffsets: {}, indexed: 0, at: 0 };
      if (progress.complete && sessionIds.length > 0 && getEntriesBySource("chat_history").length === 0) {
        progress = { complete: false, doneSessions: [], sessionOffsets: {}, indexed: 0, at: 0 };
      }
      if (progress.complete) return;

      const doneSessions = new Set(progress.doneSessions);
      let indexed = progress.indexed;
      for (const session of sessions) {
        if (!session?.id || doneSessions.has(session.id)) continue;
        const file = path.join(dataDir, "cyrene-chats", "sessions", `${session.id}.json`);
        if (!fs.existsSync(file)) {
          doneSessions.add(session.id);
          continue;
        }
        const data = JSON.parse(fs.readFileSync(file, "utf8")) as {
          messages?: Array<{ id?: unknown; role?: string; content?: unknown; at?: unknown }>;
        };
        const fileMtime = fs.statSync(file).mtimeMs;
        let sessionFailed = false;
        for (const [messageIndex, m] of (data.messages ?? []).entries()) {
          if (messageIndex <= (progress.sessionOffsets[session.id] ?? -1)) continue;
          if (typeof m.content !== "string" || !m.content.trim()) {
            progress.sessionOffsets[session.id] = messageIndex;
            continue;
          }
          const role = m.role === "user" ? "user" : m.role === "model" || m.role === "assistant" ? "assistant" : null;
          if (!role) {
            progress.sessionOffsets[session.id] = messageIndex;
            continue;
          }
          const ts = typeof m.at === "number" ? m.at : undefined;
          const occurrenceTs = ts ?? fileMtime + messageIndex;
          const turnId = typeof m.id === "string" && m.id
            ? m.id
            : `backfill:${session.id}:${messageIndex}`;
          try {
            await addHistoryMemory(
              m.content,
              {
                sessionId: session.id,
                role,
                ts: occurrenceTs,
                turnId,
              },
              ts !== undefined ? { createdAt: ts } : undefined,
            );
            if (!fs.existsSync(file)) {
              deleteHistoryEntriesBySessionId(session.id);
              doneSessions.add(session.id);
              break;
            }
            indexed++;
            progress.sessionOffsets[session.id] = messageIndex;
            writeBackfillProgress(marker, {
              ...progress,
              complete: false,
              doneSessions: [...doneSessions],
              indexed,
              at: Date.now(),
            });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.includes("RAG not initialized")) {
              console.warn(LOG_PREFIX, "回填中止：RAG 未初始化");
              return; // 不写标记，下次启动重试
            }
            sessionFailed = true;
            console.warn(LOG_PREFIX, `会话 ${session.id} 回填失败，将在下次启动重试:`, msg);
            break;
            // 单条失败（如嵌入异常）跳过，不中断整体回填
          }
        }
        if (!sessionFailed) doneSessions.add(session.id);
        writeBackfillProgress(marker, {
          ...progress,
          complete: false,
          doneSessions: [...doneSessions],
          indexed,
          at: Date.now(),
        });
      }
      const complete = sessionIds.every((id) => doneSessions.has(id));
      writeBackfillProgress(marker, {
        ...progress,
        complete,
        doneSessions: [...doneSessions],
        indexed,
        at: Date.now(),
      });
      if (complete) {
        console.log(LOG_PREFIX, `历史回填完成：${indexed} 条`);
      } else {
        console.warn(LOG_PREFIX, "历史回填未完成，失败位置将在下次启动继续");
      }
  } catch (e) {
    console.warn(LOG_PREFIX, "历史回填失败:", e);
  }
}
