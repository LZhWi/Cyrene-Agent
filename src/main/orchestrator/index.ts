// Orchestrator — unified entry point
// Function Calling 模式下，Orchestrator 只负责构建 always-on 上下文（世界书 + L0/L1）
// 工具的选择和执行由 function-calling.ts 的 runFunctionCallingLoop 处理
import { updateWorldbookActivation, getPermanentWorldbookEntries, getActiveWorldbookEntries, getCascadeWorldbookEntries, searchMemory, searchMemoryEntries, INJECTION_HEADER, INJECTION_PREAMBLE } from "../rag";
import { memoryStore } from "../memory/memory-store";
import { memoryManager } from "../memory/memory-manager";
import { isL1Fresh } from "../memory/memory-types";
import { entityGraph } from "../memory/entity-graph";
import { isL2DmaeEnabled, l2DmaeManager } from "../memory/dmae-manager";
import { NARRATIVE_INJECT_MAX } from "../memory/memory-dream";
import { recordRecentMemorySearchEntries } from "../memory/recent-injected-memory";
import { toolRegistry } from "./tool-registry";

export { ToolCallResult } from "./types";
export { scheduleMemoryWrite } from "./context-builder";
export { buildToneInjection } from "./tone-injector";
export { runFunctionCallingLoop } from "./function-calling";

// topicState TTL 已移除——由 DMAE Activation 状态机接管（见 rag/worldbook.ts）

/**
 * 构建相关记忆注入：自动检索 top-N 相关 L2 记忆和导入文档，
 * 注入到 system prompt 中，让模型无需主动调用 tool 也能感知到相关信息。
 * 原有 tool 保留，模型仍可深度搜索。
 */
export async function buildMemoryInjection(
  userInput: string,
  options: { trackState?: boolean } = {},
): Promise<string> {
  const parts: string[] = [];

  try {
    // 检索 top-5 L2 用户记忆（召回统计改在最终注入集上记账，见下方 onL2Recalled）
    const userMemoryEntries = await searchMemoryEntries(userInput, "user_memory", 5, { recordRecall: false });
    const allL2 = await memoryStore.getAllL2();
    // DMAE 工作记忆：开启时按"检索 ∪ pinned ∪ 活跃集"选注入集，话题记忆跨轮驻留；
    // 关闭时走纯检索路径，输出与改造前一致。只读调用方用预览，不变更状态。
    let injectionEntries = userMemoryEntries;
    if (isL2DmaeEnabled()) {
      injectionEntries = options.trackState !== false
        ? await l2DmaeManager.applyTurn(userMemoryEntries, allL2)
        : await l2DmaeManager.previewTurn(userMemoryEntries, allL2);
    }
    if (injectionEntries.length > 0) {
      if (options.trackState !== false) {
        recordRecentMemorySearchEntries(injectionEntries);
        // reconsolidation：对"最终注入"的条目（含 DMAE 补位/pinned）刷召回统计，
        // 取代旧的按搜索命中记账——搜索命中不等于进入上下文，补位条目此前从不刷新。
        void memoryManager.onL2Recalled(
          injectionEntries
            .map((entry) => entry.metadata?.l2Id)
            .filter((id): id is string => typeof id === "string" && id.length > 0),
        );
      }
      // 按数据信号分档措辞：冲突条目需求证；aging（久未提及）条目用不确定语气；active 正常引用
      const l2ById = new Map(allL2.map((l) => [l.id, l]));
      let hasConflict = false;
      let hasAging = false;
      const annotated = injectionEntries.map((entry) => {
        const m = entry.text;
        const l2Id = entry.metadata?.l2Id;
        const l2Entry = (typeof l2Id === "string" ? l2ById.get(l2Id) : undefined)
          ?? allL2.find((l) => l.content === m);
        // 时间锚点：优先 L2 的 createdAt（回填条目保留原始时间），缺失时回落向量条目时间
        const d = new Date(l2Entry?.createdAt ?? entry.createdAt);
        const dateNote = `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
        // 字面证据：优先提取期保留的 sourceQuote，缺失时回退 triggerText（也是用户原话短引文）。
        // 摘要会丢失专有名词/数字等字面信息，附上原文让模型引用时有据可依。
        const quote = (l2Entry?.sourceQuote ?? l2Entry?.triggerText ?? "").trim();
        const quoteNote = quote && quote !== m ? `原文：${quote}；` : "";
        if (l2Entry?.conflictWith && l2Entry.conflictWith.length > 0) {
          hasConflict = true;
          return `· ${m} ⚠️（该信息可能存在矛盾记录，${quoteNote}记录于 ${dateNote}）`;
        }
        if (l2Entry?.status === "aging") {
          hasAging = true;
          return `· ${m}（较久远的印象，${quoteNote}记录于 ${dateNote}）`;
        }
        return `· ${m}（${quoteNote}记录于 ${dateNote}）`;
      });
      const notes: string[] = [];
      if (hasConflict) notes.push("带 ⚠️ 的条目存在矛盾记录，引用前先向用户求证，不要当作事实。");
      if (hasAging) notes.push("标注「较久远的印象」的条目可能已过时，提及时用不确定的语气，不要断言。");
      parts.push(
        "【相关记忆】\n" + annotated.join("\n") +
        (notes.length > 0 ? "\n（" + notes.join("") + "）" : "")
      );
    }
  } catch (err) {
    console.warn("[Orchestrator] user_memory search failed:", err);
  }

  try {
    // 检索 top-2 导入文档片段
    const docResults = await searchMemory(userInput, "imported_doc", 2);
    if (docResults.length > 0) {
      parts.push("【相关文档】\n" + docResults.map((d) => "· " + d).join("\n"));
    }
  } catch (err) {
    console.warn("[Orchestrator] imported_doc search failed:", err);
  }

  try {
    // 实体关系图谱
    const entityInfo = entityGraph.search(userInput);
    if (entityInfo) {
      parts.push("【人物关系】\n" + entityInfo);
    }
  } catch (err) {
    console.warn("[Orchestrator] entity graph search failed:", err);
  }

  return parts.join("\n\n");
}

function getWorldbookTriggerText(userInput: string): string {
  const contextMarkers = [
    "【本轮文件】",
    "【文档内容】",
    "【图片视觉信息】",
    "【图片附件】",
  ];
  const firstContextIndex = contextMarkers
    .map((marker) => userInput.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];
  return (typeof firstContextIndex === "number" ? userInput.slice(0, firstContextIndex) : userInput).trim();
}

/**
 * 构建 always-on 上下文：世界书 + L0/L1 画像。
 * 不涉及工具选择和执行——那些由 function calling 处理。
 */
export async function buildAlwaysOnContext(
  userInput: string,
  recentMessages: Array<{ role: string; content: string }>,
  options: { trackState?: boolean } = {},
): Promise<string> {
  const parts: string[] = [];

  // ── 世界书 — 永远跑 ──────────────────────────────────
  // DMAE：常驻始终注入；非常驻条目按 Activation 生命周期门控。
  // updateActivation 在调 LLM 之前跑 → 用户当轮命中的条目当轮就进 Prompt。
  try {
    const permanentWb = getPermanentWorldbookEntries();
    if (permanentWb.length > 0) {
      parts.push("【常驻背景】\n" + permanentWb.join("\n\n"));
    }

    if (options.trackState !== false) {
      const lastAssistant = recentMessages
        .filter(m => m.role === "assistant")
        .slice(-1)[0]?.content ?? "";
      updateWorldbookActivation(getWorldbookTriggerText(userInput), lastAssistant);  // 打分（本轮用户 + 上轮模型）
    }
    const active = getActiveWorldbookEntries();           // 阈值门控 + 注入
    // One-Shot cascade：用户命中后连带触发的条目（不入 DMAE 状态表，只本轮有效）
    // 只读调用不能复用其他管线上一轮遗留的 cascade。
    const cascade = options.trackState === false ? [] : getCascadeWorldbookEntries();
    const allInjected = active.length > 0 || cascade.length > 0;
    if (allInjected) {
      const sections: string[] = [];
      if (active.length > 0) {
        sections.push(active.join("\n\n"));
      }
      if (cascade.length > 0) {
        sections.push(cascade.join("\n\n"));
      }
      parts.push(INJECTION_HEADER + "\n" + INJECTION_PREAMBLE + "\n\n" + sections.join("\n\n"));
    }
  } catch (err) {
    console.warn("[Orchestrator] worldbook dmae failed:", err);
  }

  // ── L0/L1 画像 — 永远跑 ──────────────────────────────
  try {
    const l0 = await memoryStore.getL0();
    const l1 = await memoryStore.getL1();

    const l0Lines = [
      l0.preferredName && `称呼：${l0.preferredName}`,
      l0.occupation && `职业：${l0.occupation}`,
      l0.longTermInterests && `长期兴趣：${l0.longTermInterests}`,
      l0.language && `常用语言：${l0.language}`,
      l0.permanentNote && `备注：${l0.permanentNote}`,
    ].filter(Boolean);

    // L1 超过新鲜期（30 天未更新）就不再注入，避免陈旧“近期状态”污染上下文
    const l1Lines = isL1Fresh(l1) ? [
      l1.recentGoals && `最近目标：${l1.recentGoals}`,
      l1.recentPreferences && `近期偏好：${l1.recentPreferences}`,
      l1.currentProject && `当前项目：${l1.currentProject}`,
    ].filter(Boolean) : [];

    if (l0Lines.length > 0 || l1Lines.length > 0) {
      let memoryContext = "";
      if (l0Lines.length > 0) {
        memoryContext += `[用户画像]\n${l0Lines.join("\n")}\n\n`;
      }
      if (l1Lines.length > 0) {
        memoryContext += `[近期状态]\n${l1Lines.join("\n")}\n\n`;
      }
      parts.push(memoryContext.trim());
    }

    // ── 梦境沉淀叙事 — 有内容才注入 ─────────────────────
    // 被降级记忆在遗忘前蒸馏出的长期陪伴叙事（永不衰减）。
    // 只取最新几条控制注入体积（每条 ≤400 字，3 条约 600 token）。
    const narratives = await memoryStore.getDreamNarratives();
    if (narratives.length > 0) {
      const injected = narratives.slice(-NARRATIVE_INJECT_MAX).map((n) => `· ${n.text}`).join("\n");
      parts.push(`[长期陪伴叙事]\n${injected}\n（这是你在梦里沉淀下来的关系印象，可作为语气与默契的背景，不要逐字复述）`);
    }
  } catch (err) {
    console.warn("[Orchestrator] memory load failed:", err);
  }

  // ── 日志 ──────────────────────────────────────────────
  const enabledTools = toolRegistry.getEnabledTools();
  console.log("[Orchestrator] Always-on context built, enabled tools: " + enabledTools.map(t => t.id).join(", "));

  return parts.join("\n\n");
}
