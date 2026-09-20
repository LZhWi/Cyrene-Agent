const $ = (id) => document.getElementById(id);
let currentState;
let legacyPreview;
let vectorPreview;
let historyPreview;
let semanticBackfillPreview;
let lifecyclePreview;
let capacityPreview;
let maintenancePreview;
let coldRecallPreview;
const statusLabels = { active: "有效", aging: "老化", archived: "已归档", superseded: "已取代", merged: "已合并" };
function evidenceText(records, memoryId) {
  const linked = (records ?? []).filter((e) => e.memoryId === memoryId && e.sourceStatus !== "deleted" && e.quoteSnippet.trim());
  return linked.map((e) => `关联片段（${e.provenance === "verified" ? "已核对来源" : "未核对原始对话"}；${e.sourceStatus === "archived" ? "来源已归档" : "来源记录有效"}；记录时间 ${new Date(e.createdAt).toLocaleString()}）\n${e.quoteSnippet}`).join("\n");
}
function recallable(e) { const now = Date.now(); return ["active", "aging"].includes(e.status) && !e.supersededBy && !e.mergedInto && (e.validFrom === undefined || e.validFrom <= now) && (e.validTo === undefined || e.validTo > now); }
function importTargetEmpty(state) { return state && !state.turns.length && !state.entries.length && !(state.evidence ?? []).length && !Object.keys(state.profiles.l0).length && !Object.keys(state.profiles.l1).length && !(state.profileChanges ?? []).length && !(state.entryReviews ?? []).length && !state.legacyImport; }
function renderRecentCompressionGroups(reviews) {
  const container = $("recent-compression-groups"); container.replaceChildren();
  const recent = (reviews ?? []).filter((review) => ["applied", "undone"].includes(review.status))
    .sort((left, right) => (right.undoneAt ?? right.appliedAt ?? right.createdAt) - (left.undoneAt ?? left.appliedAt ?? left.createdAt)).slice(0, 3);
  if (!recent.length) { container.textContent = "暂无压缩记录"; return; }
  for (const review of recent) {
    const article = document.createElement("article"), body = document.createElement("div");
    const eventAt = review.undoneAt ?? review.appliedAt ?? review.createdAt;
    const timeLabel = review.undoneAt !== undefined ? "撤销时间" : review.appliedAt !== undefined ? "应用时间" : "旧记录时间";
    body.textContent = `${review.status === "applied" ? "已应用" : "已撤销"} · ${timeLabel} ${new Date(eventAt).toLocaleString()}\n总结：${review.summary ?? "（无总结）"}\n来源：\n${review.entries.map((entry, index) => `${index + 1}. ${entry.content.slice(0, 120)}`).join("\n")}`;
    article.append(body); container.append(article);
  }
}
async function edit(action, data) {
  try { await invoke(action, { ...data, revision: currentState.revision }); await refresh(); }
  catch (e) { $("status").textContent = e.message; }
}
async function invoke(action, data) { const r = await window.companion.invoke(action, data); if (!r.ok) throw new Error(r.error); return r.data; }
function renderHistoryPreview(preview) {
  historyPreview = preview;
  $("history-results").replaceChildren();
  if (!preview) { $("history-status").textContent = ""; $("history-apply-unique").disabled = true; return; }
  const labels = { exact: "逐字唯一", "normalized-exact": "规范化唯一", ambiguous: "重复原文，待选择", "no-match": "未匹配", "empty-trigger": "缺少触发片段", "no-history": "所选范围无用户消息" };
  $("history-apply-unique").disabled = preview.unique < 1;
  $("history-status").textContent = `待核验记忆 ${preview.totalEligible ?? preview.results.length} 条${preview.truncated ? `（本次检查前 ${preview.results.length} 条）` : ""} · 可自动绑定 ${preview.unique} 条 · 歧义 ${preview.counts.ambiguous ?? 0} 条 · 未匹配 ${(preview.counts["no-match"] ?? 0) + (preview.counts["empty-trigger"] ?? 0) + (preview.counts["no-history"] ?? 0)} 条`;
  for (const result of preview.results) {
    const article = document.createElement("article");
    const summary = document.createElement("div");
    summary.textContent = `${labels[result.method] ?? result.method}\n记忆：${result.content}\n旧触发片段：${result.trigger || "（空）"}${result.totalCandidates > result.candidates.length ? `\n仅显示前 ${result.candidates.length}/${result.totalCandidates} 个候选；可缩小会话范围后重试` : ""}`;
    article.append(summary);
    if (result.method === "ambiguous") for (const candidate of result.candidates) {
      const detail = document.createElement("pre");
      detail.textContent = `时间：${new Date(candidate.at).toLocaleString()}\n用户消息：${candidate.text}${candidate.before ? `\n前一条：${candidate.before}` : ""}${candidate.after ? `\n后一条：${candidate.after}` : ""}`;
      const button = document.createElement("button");
      const recommended = result.recommendation?.conversationId === candidate.conversationId && result.recommendation?.messageId === candidate.messageId;
      button.textContent = recommended ? "模型复核推荐；确认这条是来源" : "确认这条是来源";
      button.onclick = async () => {
        if (!window.confirm("将所选用户消息 ID、原文片段、相邻上下文和来源时间复制到插件私有记忆，并把这条记忆标为已核对。不会修改宿主会话。确认？")) return;
        try {
          const applied = await invoke("apply-native-history-selection", { previewId: historyPreview.id, entryId: result.entryId, conversationId: candidate.conversationId, messageId: candidate.messageId });
          await refresh(); renderHistoryPreview(applied.preview); $("status").textContent = "已绑定 1 条人工确认的历史来源。";
        } catch (e) { $("status").textContent = e.message; }
      };
      article.append(detail, button);
    }
    if (result.method === "ambiguous") {
      const review = document.createElement("button"); review.textContent = "使用主程序模型辅助判断";
      review.onclick = async () => {
        if (!window.confirm("将这条记忆摘要、旧触发片段和最多 12 个候选的用户原文及相邻上下文发送给主程序当前模型，先定位再独立复核，可能产生两次请求和费用。模型只给推荐，不会写入来源。确认？")) return;
        try {
          const reviewed = await invoke("review-native-history-ambiguity", { previewId: historyPreview.id, entryId: result.entryId });
          renderHistoryPreview(reviewed.preview);
          $("status").textContent = reviewed.recommended ? "模型已给出通过双阶段复核的单一推荐，仍需你确认。" : reviewed.multipleSupported ? "模型认为多条消息共同支持，未自动选单一来源，请人工核对。" : "模型未找到达到双阶段阈值的单一来源，请人工核对。";
        } catch (e) { $("status").textContent = e.message; }
      };
      article.append(review);
    }
    $("history-results").append(article);
  }
}
async function refresh() {
  try {
    const state = await invoke("state");
    currentState = state;
    renderRecentCompressionGroups(state.compressionReviews);
    const nativeSettings = state.native?.settings ?? { captureEnabled: false, autoExtractEnabled: false, promptInjectionEnabled: false, momentsInjectionEnabled: false, socialContextEnabled: false };
    $("native-capture").checked = nativeSettings.captureEnabled;
    $("native-auto-extract").checked = nativeSettings.autoExtractEnabled;
    $("native-prompt-injection").checked = nativeSettings.promptInjectionEnabled;
    $("native-social-context").checked = nativeSettings.socialContextEnabled;
    $("native-moments-injection").checked = nativeSettings.momentsInjectionEnabled;
    $("native-retry").disabled = !(state.native?.pending > 0);
    const nativeError = state.native?.lastError ? ` · 上次${state.native.lastError.kind === "read" ? "读取" : "提取"}失败，可安全重试` : "";
    $("native-status").textContent = `读取${nativeSettings.captureEnabled ? "已启用" : "已关闭"} · 自动提取${nativeSettings.autoExtractEnabled ? "已启用" : "已关闭"} · 回复注入${nativeSettings.promptInjectionEnabled ? "已启用" : "已关闭"} · 对话连续性${nativeSettings.socialContextEnabled ? "已启用" : "已关闭"}（有效 ${state.social?.active ?? 0}） · 动态发帖记忆${nativeSettings.momentsInjectionEnabled ? "已启用" : "已关闭"} · 待处理 ${state.native?.pending ?? 0} · 已接收事件 ${state.native?.completed ?? 0}${nativeError}`;
    if (legacyPreview) $("legacy-import").disabled = !legacyPreview.canImport || !importTargetEmpty(state);
    if (!$(`legacy-source`).value) $(`legacy-source`).value = state.defaultLegacyMemoryPath ?? "";
    if (!$("vector-source").value) $("vector-source").value = state.defaultLegacyVectorPath ?? "";
    if (vectorPreview) $("vector-import").disabled = !vectorPreview.canImport || !state.legacyImport || state.vectorIndex?.imported;
    $("embedding-enabled").checked = Boolean(state.embedding?.enabled);
    $("embedding-url").value = state.embedding?.baseUrl ?? "";
    $("embedding-model").value = state.embedding?.model ?? "";
    $("embedding-dimensions").value = state.embedding?.dimensions ?? 1024;
    $("embedding-key").value = "";
    $("embedding-status").textContent = `${state.embedding?.hasKey ? "已保存密钥" : "未保存密钥（本机无鉴权服务可留空）"} · ${state.vectorIndex?.entries ? `索引 ${state.vectorIndex.entries} 条（旧 ${state.vectorIndex.legacyEntries ?? 0} / 新 ${state.vectorIndex.generatedEntries ?? 0}）/ ${state.vectorIndex.dimensions} 维` : "尚无向量索引"}`;
    $("semantic-index-enabled").checked = Boolean(state.semanticIndex?.enabled);
    $("semantic-index-retry").disabled = !(state.semanticIndex?.enabled && (state.semanticIndex?.pending > 0 || state.semanticIndex?.lastError));
    const semanticError = state.semanticIndex?.lastError ? ` · 上次${state.semanticIndex.lastError.kind === "configuration" ? "配置" : state.semanticIndex.lastError.kind === "stale" ? "版本校验" : "请求"}失败，可安全重试` : "";
    $("semantic-index-status").textContent = `${state.semanticIndex?.enabled ? "已启用" : "已关闭"} · 待处理 ${state.semanticIndex?.pending ?? 0} · 已生成 ${state.semanticIndex?.generatedEntries ?? 0}${state.semanticIndex?.processing ? " · 处理中" : ""}${semanticError}`;
    for (const id of ["review-left", "review-right"]) {
      const select = $(id), previous = select.value; select.replaceChildren();
      for (const entry of state.entries.filter(recallable)) {
        const option = document.createElement("option"); option.value = entry.id; option.textContent = `${entry.content.slice(0, 80)} · ${entry.id}`;
        select.append(option);
      }
      if ([...select.options].some((o) => o.value === previous)) select.value = previous;
    }
    const compressionSelect = $("compression-entries"), compressionSelected = new Set([...compressionSelect.selectedOptions].map((option) => option.value)); compressionSelect.replaceChildren();
    for (const entry of state.entries.filter(recallable)) {
      const option = document.createElement("option"); option.value = entry.id; option.textContent = `${entry.content.slice(0, 80)} · ${entry.id}`; option.selected = compressionSelected.has(entry.id); compressionSelect.append(option);
    }
    $("compression-reviews").replaceChildren();
    for (const review of state.compressionReviews ?? []) {
      const article = document.createElement("article"), body = document.createElement("div");
      const verdict = { mergeable: "模型认为可无损合并", different: "模型认为不应合并", uncertain: "证据不足" }[review.verdict];
      const status = { pending: "待处理", dismissed: "已关闭", applied: "已应用", undone: "已撤销" }[review.status];
      const safety = `置信度 ${review.confidence === undefined ? "未提供" : review.confidence.toFixed(2)} · 完整覆盖 ${review.coverageConfirmed === true ? "已确认" : "未确认"}`;
      body.textContent = `${verdict} · ${status}\n${safety}\n${review.reason}${review.summary ? `\n候选总结：${review.summary}` : ""}\n${review.entries.map((entry, index) => `${index + 1}. ${entry.content}（来源 ${new Date(entry.sourceAt).toLocaleString()}${entry.sourceEndAt !== undefined ? ` 至 ${new Date(entry.sourceEndAt).toLocaleString()}` : ""}）`).join("\n")}`;
      article.append(body);
      if (review.status === "pending") {
        const dismiss = document.createElement("button"); dismiss.textContent = "关闭建议，不改记忆";
        dismiss.onclick = async () => { try { await invoke("resolve-compression", { id: review.id, action: "dismiss", revision: currentState.revision }); await refresh(); } catch (e) { $("status").textContent = e.message; } }; article.append(dismiss);
        if (review.verdict === "mergeable") {
          const apply = document.createElement("button"); apply.textContent = "确认应用压缩";
          apply.onclick = async () => { if (!window.confirm("将新建一条用户确认的多来源总结，并把原条目标记为 merged；不会删除原条目或证据。确认应用？")) return; try { await invoke("resolve-compression", { id: review.id, action: "apply", revision: currentState.revision }); await refresh(); } catch (e) { $("status").textContent = e.message; } }; article.append(apply);
        }
      } else if (review.status === "applied") {
        const undo = document.createElement("button"); undo.textContent = "撤销这次压缩";
        undo.onclick = async () => { if (!window.confirm("仅当新总结、原条目和证据都未发生后续变化时才会撤销：移除新总结并恢复原条目状态。确认？")) return; try { await invoke("resolve-compression", { id: review.id, action: "undo", revision: currentState.revision }); await refresh(); } catch (e) { $("status").textContent = e.message; } }; article.append(undo);
      }
      $("compression-reviews").append(article);
    }
    $("entry-reviews").replaceChildren();
    for (const review of state.entryReviews ?? []) {
      const article = document.createElement("article"), body = document.createElement("div");
      const verdict = { conflict: "可能冲突", compatible: "可并存", uncertain: "不确定" }[review.verdict];
      const status = { pending: "待处理", "keep-both": "已关闭，未改记忆", "archive-left": "已归档左侧", "archive-right": "已归档右侧", "plan-applied": "Resolver 计划已应用", "plan-undone": "Resolver 计划已撤销" }[review.status];
      const plan = review.resolverPlan, planText = plan ? `\n关系：${{ unrelated: "无关", context_difference: "上下文差异", preference_evolution: "偏好演进", direct_conflict: "直接冲突", uncertain: "证据不足" }[plan.resolutionType]} · 置信度 ${plan.confidence.toFixed(2)}\n计划：${plan.actions.createResolvedMemory ? "创建完整合并总结" : "不创建总结"}${plan.actions.leftStatus ? `；左侧 → ${plan.actions.leftStatus}` : ""}${plan.actions.rightStatus ? `；右侧 → ${plan.actions.rightStatus}` : ""}${plan.actions.shouldAskUser || plan.actions.clarificationNeeded ? "；需要用户澄清，不可自动应用" : ""}${plan.resolvedSummary ? `\n候选总结：${plan.resolvedSummary}` : ""}` : "\n旧格式复核：没有结构化 Resolver 计划";
      body.textContent = `模型建议（不是事实结论）：${verdict} · ${status}\n${review.reason}${planText}\n左侧：${review.left.content}\n证据：${review.left.quote}（${new Date(review.left.sourceAt).toLocaleString()}）\n右侧：${review.right.content}\n证据：${review.right.quote}（${new Date(review.right.sourceAt).toLocaleString()}）`;
      article.append(body);
      const reviewEvidence = document.createElement("div");
      reviewEvidence.textContent = [evidenceText(review.leftEvidence, review.left.id), evidenceText(review.rightEvidence, review.right.id)].filter(Boolean).join("\n");
      article.append(reviewEvidence);
      if (review.status === "pending") {
        const revision = state.revision;
        for (const [label, action] of [["关闭，不改记忆", "keep-both"], ["归档左侧", "archive-left"], ["归档右侧", "archive-right"]]) {
          const button = document.createElement("button"); button.textContent = label;
          button.onclick = async () => {
            if (action !== "keep-both" && !window.confirm("归档选中的摘要，不删除原始对话；之后可在记忆列表恢复。确认？")) return;
            try { await invoke("resolve-entry-review", { id: review.id, action, revision }); await refresh(); }
            catch (e) { $("status").textContent = e.message; }
          }; article.append(button);
        }
        const actionablePlan = plan && !plan.actions.shouldAskUser && !plan.actions.clarificationNeeded && plan.resolutionType !== "uncertain" && (plan.actions.createResolvedMemory || plan.actions.leftStatus || plan.actions.rightStatus);
        if (actionablePlan) {
          const apply = document.createElement("button"); apply.textContent = "确认应用 Resolver 计划";
          apply.onclick = async () => { if (!window.confirm("将严格按上方结构化计划一次性创建总结和/或改变两侧插件私有记忆状态。原条目与证据不会删除，并可在未发生后续变化时撤销。确认应用？")) return; try { await invoke("resolve-entry-review", { id: review.id, action: "apply-plan", revision }); await refresh(); } catch (e) { $("status").textContent = e.message; } };
          article.append(apply);
        }
      } else if (review.status === "plan-applied") {
        const undo = document.createElement("button"); undo.textContent = "撤销 Resolver 计划";
        undo.onclick = async () => { if (!window.confirm("仅当两侧记忆、新总结和证据都未发生后续变化时，才恢复计划应用前的精确状态。确认撤销？")) return; try { await invoke("resolve-entry-review", { id: review.id, action: "undo-plan", revision: currentState.revision }); await refresh(); } catch (e) { $("status").textContent = e.message; } };
        article.append(undo);
      }
      $("entry-reviews").append(article);
    }
    $("query-expansion").checked = Boolean(state.queryExpansion);
    $("reranker-enabled").checked = Boolean(state.reranker?.enabled);
    $("reranker-status").textContent = state.reranker?.enabled ? `已启用：仅重排非置顶 L2 候选${state.reranker?.lastError ? ` · 上次${state.reranker.lastError.kind === "invalid" ? "输出无效" : "请求失败"}，已使用基础顺序` : ""}` : "已关闭";
    $("dmae-enabled").checked = Boolean(state.dmae?.enabled);
    $("dmae-status").textContent = state.dmae?.enabled ? `已启用 · 轮次 ${state.dmae.round} · 跟踪 ${state.dmae.tracked} 条 · 当前活跃 ${state.dmae.active} 条` : `已关闭 · 已保存 ${state.dmae?.tracked ?? 0} 条插件私有激活状态`;
    $("lifecycle-enabled").checked = Boolean(state.lifecycle?.enabled);
    $("auto-lifecycle").checked = Boolean(state.autoLifecycle?.enabled);
    $("auto-lifecycle-apply").checked = Boolean(state.autoLifecycle?.applyEnabled);
    const autoLife = state.autoLifecycle;
    $("auto-lifecycle-status").textContent = autoLife?.enabled ? "已启用" : "已关闭";
    if (autoLife?.lastScanAt) $("auto-lifecycle-status").textContent += ` · 上次扫描 ${new Date(autoLife.lastScanAt).toLocaleString()} · 待老化 ${autoLife.agingCandidates ?? 0} 条 · 待归档 ${autoLife.archivedCandidates ?? 0} 条`;
    else $("auto-lifecycle-status").textContent += " · 尚未扫描";
    if (autoLife?.lastErrorAt) $("auto-lifecycle-status").textContent += " · 上次扫描失败";
    if (autoLife?.lastAppliedAt) $("auto-lifecycle-status").textContent += ` · 上次自动变更 ${new Date(autoLife.lastAppliedAt).toLocaleString()}（老化 ${autoLife.lastAppliedAging ?? 0}、归档 ${autoLife.lastAppliedArchived ?? 0}）`;
    if (autoLife?.lastWeightDecayCount !== undefined) $("auto-lifecycle-status").textContent += ` · 权重衰减 ${autoLife.lastWeightDecayCount} 条`;
    $("lifecycle-status").textContent = `${state.lifecycle?.enabled ? "已启用" : "已关闭"} · 已记录 ${state.lifecycle?.tracked ?? 0} 条实际注入时间`;
    $("lifecycle-changes").replaceChildren();
    for (const change of (state.lifecycleChanges ?? []).slice().reverse()) {
      const article = document.createElement("article"), body = document.createElement("div");
      body.textContent = `${change.entries.length} 条 → ${change.target} · ${change.status === "applied" ? "已应用" : "已撤销"} · ${new Date(change.createdAt).toLocaleString()}`; article.append(body);
      if (change.status === "applied") {
        const undo = document.createElement("button"); undo.textContent = "撤销这次生命周期变更";
        undo.onclick = async () => { if (!window.confirm("仅当这些记忆此后未被编辑或改变状态时，才恢复应用前的精确状态。确认撤销？")) return; try { await invoke("undo-lifecycle-transition", { id: change.id, revision: currentState.revision }); await refresh(); } catch (e) { $("status").textContent = e.message; } }; article.append(undo);
      }
      $("lifecycle-changes").append(article);
    }
    $("dream-injection").checked = Boolean(state.dream?.injectionEnabled);
    $("dream-status").textContent = `${state.dream?.injectionEnabled ? "注入已启用" : "注入已关闭"} · 已确认叙事 ${state.dream?.narratives?.length ?? 0} 段`;
    $("auto-dream").checked = Boolean(state.autoDream?.enabled);
    $("auto-dream-apply").checked = Boolean(state.autoDream?.applyEnabled);
    const dreamPhase = { capacity: "容量瘦身", dream: "叙事生成", compression: "压缩复核" }[state.autoDream?.phase] ?? "";
    const failedDreamPhase = { capacity: "容量瘦身", dream: "叙事生成", compression: "压缩复核" }[state.autoDream?.lastFailedStage] ?? "";
    $("auto-dream-status").textContent = `${state.autoDream?.enabled ? "已启用" : "已关闭"} · 自动保存叙事${state.autoDream?.applyEnabled ? "已启用" : "已关闭"}${state.autoDream?.running ? ` · 正在执行${dreamPhase}` : ""}${state.autoDream?.lastCompletedAt ? ` · 上次完成 ${new Date(state.autoDream.lastCompletedAt).toLocaleString()} · 降为 aging ${state.autoDream.lastDemotedToAging ?? 0} · 归档 ${state.autoDream.lastDemotedToArchived ?? 0} · 压缩复核 ${state.autoDream.lastCompressionReviewed ?? 0} 组（自动应用 ${state.autoDream.lastCompressionApplied ?? 0}）` : " · 尚未完成完整周期"}${state.autoDream?.lastAutoAppliedAt ? ` · 上次自动保存叙事 ${new Date(state.autoDream.lastAutoAppliedAt).toLocaleString()}` : ""}${state.autoDream?.lastErrorAt ? ` · 上次在${failedDreamPhase || "未知阶段"}失败` : ""}`;
    const dreamSelect = $("dream-entries"), dreamSelected = new Set([...dreamSelect.selectedOptions].map((option) => option.value)); dreamSelect.replaceChildren();
    for (const entry of state.entries.filter((entry) => entry.status === "aging" && !entry.pinned && !entry.supersededBy && !entry.mergedInto)) {
      const option = document.createElement("option"); option.value = entry.id; option.textContent = `${entry.content.slice(0, 90)} · ${entry.id}`; option.selected = dreamSelected.has(entry.id); dreamSelect.append(option);
    }
    $("dream-reviews").replaceChildren();
    for (const review of state.dream?.reviews ?? []) {
      const article = document.createElement("article"), body = document.createElement("div");
      body.textContent = `${{ pending: "待确认", dismissed: "已关闭", applied: "已保存", undone: "已撤销", evicted: "已被 8 段容量上限淘汰" }[review.status]} · ${review.entries.length} 条材料\n${review.narrative}`;
      article.append(body);
      if (review.status === "pending") {
        const dismiss = document.createElement("button"); dismiss.textContent = "关闭草稿，不保存";
        dismiss.onclick = async () => { try { await invoke("resolve-dream", { id: review.id, action: "dismiss" }); await refresh(); } catch (e) { $("status").textContent = e.message; } };
        const apply = document.createElement("button"); apply.textContent = "确认保存叙事";
        apply.onclick = async () => { if (!window.confirm("将这段模型生成的反思保存到插件私有梦境库。它不会修改或删除来源记忆；是否注入聊天由独立开关决定。确认？")) return; try { await invoke("resolve-dream", { id: review.id, action: "apply" }); await refresh(); } catch (e) { $("status").textContent = e.message; } };
        article.append(dismiss, apply);
      } else if (review.status === "applied") {
        const undo = document.createElement("button"); undo.textContent = "撤销这段叙事";
        undo.onclick = async () => { if (!window.confirm("移除这段插件私有叙事，不修改任何来源记忆。确认？")) return; try { await invoke("resolve-dream", { id: review.id, action: "undo" }); await refresh(); } catch (e) { $("status").textContent = e.message; } };
        article.append(undo);
      }
      $("dream-reviews").append(article);
    }
    $("status").textContent = `原始对话 ${state.turns.length} 轮 · 待提取 ${state.pending} 轮 · 记忆 ${state.entries.length} 条${state.legacyImport ? " · 已导入旧记忆快照" : ""}${state.maintaining ? " · 提取中" : ""}`;
    $("entries").replaceChildren();
    $("maintenance-inbox").replaceChildren();
    $("auto-maintenance").checked = Boolean(state.autoMaintenance?.enabled);
    $("auto-maintenance-status").textContent = `${state.autoMaintenance?.enabled ? "已启用" : "已关闭"}${state.autoMaintenance?.lastScanAt ? ` · 上次扫描 ${new Date(state.autoMaintenance.lastScanAt).toLocaleString()} · 新增 ${state.autoMaintenance.lastAdded ?? 0} 对` : " · 尚未自动扫描"}${state.autoMaintenance?.lastErrorAt ? " · 上次扫描失败" : ""}`;
    $("auto-review").checked = Boolean(state.autoReview?.enabled);
    $("auto-review-apply").checked = Boolean(state.autoReview?.applyEnabled);
    $("auto-review-status").textContent = `${state.autoReview?.enabled ? "已启用" : "已关闭"} · 自动安全应用${state.autoReview?.applyEnabled ? "已启用" : "已关闭"} · 已累计 ${state.autoReview?.pendingTurns ?? 0}/${state.autoReview?.turnInterval ?? 5} 轮${state.autoReview?.running ? " · 正在复核" : ""}${state.autoReview?.lastCompletedAt ? ` · 上次完成 ${new Date(state.autoReview.lastCompletedAt).toLocaleString()}` : " · 尚未完成后台复核"}${state.autoReview?.lastAutoAppliedAt ? ` · 上次自动应用 ${new Date(state.autoReview.lastAutoAppliedAt).toLocaleString()}` : ""}${state.autoReview?.lastErrorAt ? " · 上次复核失败，将在后续轮次重试" : ""}`;
    $("auto-compression").checked = Boolean(state.autoCompression?.enabled);
    $("auto-compression-mode").value = state.autoCompression?.applyEnabled ? "auto" : "manual";
    $("auto-compression-status").textContent = `${state.autoCompression?.enabled ? "已启用" : "已关闭"} · ${state.autoCompression?.applyEnabled ? "达标后自动压缩" : "生成建议后手动确认"}${state.autoCompression?.suppressed ? " · 已由完整梦境周期接管，暂停独立二十轮计时" : ` · 已累计 ${state.autoCompression?.pendingTurns ?? 0}/${state.autoCompression?.turnInterval ?? 20} 轮`}${state.autoCompression?.running ? " · 正在生成建议" : ""}${state.autoCompression?.lastCompletedAt ? ` · 上次完成 ${new Date(state.autoCompression.lastCompletedAt).toLocaleString()}` : " · 尚未生成后台建议"}${state.autoCompression?.lastAutoAppliedAt ? ` · 上次自动应用 ${new Date(state.autoCompression.lastAutoAppliedAt).toLocaleString()}` : ""}${state.autoCompression?.lastErrorAt ? " · 上次生成失败，将在后续轮次重试" : ""}`;
    $("auto-reflection").checked = Boolean(state.autoReflection?.enabled);
    $("auto-reflection-status").textContent = `${state.autoReflection?.enabled ? "已启用" : "已关闭"} · 已累计 ${state.autoReflection?.pendingTurns ?? 0}/${state.autoReflection?.turnInterval ?? 20} 轮${state.autoReflection?.running ? " · 正在反思" : ""}${state.autoReflection?.lastCompletedAt ? ` · 上次完成 ${new Date(state.autoReflection.lastCompletedAt).toLocaleString()} · 新增 ${state.autoReflection.lastSuggested ?? 0} 条候选` : " · 尚未完成后台反思"}${state.autoReflection?.lastErrorAt ? " · 上次反思失败，将在后续轮次重试" : ""}`;
    for (const item of state.maintenanceInbox?.items ?? []) {
      const left = state.entries.find((entry) => entry.id === item.leftId), right = state.entries.find((entry) => entry.id === item.rightId);
      const article = document.createElement("article"), body = document.createElement("div");
      body.textContent = `${item.kind === "normalized-duplicate" ? "规范化正文相同" : `向量相似 ${item.score?.toFixed(3)}`} · ${item.status === "open" ? "待处理" : "已关闭"}${item.stale ? " · 来源已变化" : ""}\n左：${left?.content ?? item.leftId}\n右：${right?.content ?? item.rightId}`;
      article.append(body);
      if (item.status === "open" && !item.stale && left && right) {
        const pickLabel = document.createElement("label"), pick = document.createElement("input"); pick.type = "checkbox"; pick.className = "maintenance-inbox-pick"; pick.value = item.id; pickLabel.append(pick, document.createTextNode("加入本次批量复核")); article.append(pickLabel);
        const conflict = document.createElement("button"); conflict.textContent = "填入双条复核";
        conflict.onclick = () => { $("review-left").value = item.leftId; $("review-right").value = item.rightId; $("status").textContent = "已填入候选；请求模型前仍会再次确认。"; };
        const compression = document.createElement("button"); compression.textContent = "填入压缩复核";
        compression.onclick = () => { [...$("compression-entries").options].forEach((option) => { option.selected = [item.leftId, item.rightId].includes(option.value); }); $("status").textContent = "已填入候选；请求模型前仍会再次确认。"; };
        const dismiss = document.createElement("button"); dismiss.textContent = "关闭候选";
        dismiss.onclick = async () => { try { await invoke("dismiss-maintenance-inbox", { id: item.id }); await refresh(); } catch (e) { $("status").textContent = e.message; } };
        article.append(conflict, compression, dismiss);
      }
      $("maintenance-inbox").append(article);
    }
    $("profiles").replaceChildren();
    $("profile-changes").replaceChildren();
    for (const change of state.profileChanges ?? []) {
      const article = document.createElement("article"), body = document.createElement("div");
      body.textContent = `${change.layer} · ${change.field} · ${change.status === "pending" ? "待确认" : change.status === "accepted" ? "已采用" : change.status === "undone" ? "已撤销采用" : "已保留当时的当前值"}\n旧值：${change.before.content}\n旧证据：${change.before.quote || "手动设置"}（${new Date(change.before.sourceAt).toLocaleString()}）\n候选：${change.after.content}\n新证据：${change.after.quote}（${new Date(change.after.sourceAt).toLocaleString()}）${change.reflection ? `\n反思来源：${change.reflection.kind === "turn" ? "插件私有用户轮次" : "已核验历史证据"} · 模型自报置信度 ${change.reflection.confidence.toFixed(2)}\n建议理由：${change.reflection.reason}` : ""}`;
      article.append(body);
      if (change.status === "pending") {
        const revision = state.revision;
        for (const [label, action] of [["保留当前值", "keep"], ["采用候选", "accept"]]) {
          const button = document.createElement("button"); button.textContent = label;
          button.onclick = async () => {
            if (action === "accept" && change.reflection && !window.confirm("这是模型根据已保存用户原话提出的画像候选，置信度仅为模型自报，不能证明语义正确。请核对新旧值与证据；只修改插件私有画像，不修改原始对话。确认采用？")) return;
            try { await invoke("resolve-profile-change", { id: change.id, action, revision }); await refresh(); }
            catch (e) { $("status").textContent = e.message; }
          }; article.append(button);
        }
      } else if (change.status === "accepted") {
        const undo = document.createElement("button"); undo.textContent = "撤销这次采用";
        undo.onclick = async () => {
          if (!window.confirm("仅当当前画像和反思来源均未发生后续变化时，恢复这次采用前的插件私有画像值。不会修改原始对话或宿主记忆。确认撤销？")) return;
          try { await invoke("resolve-profile-change", { id: change.id, action: "undo-accept", revision: state.revision }); await refresh(); }
          catch (e) { $("status").textContent = e.message; }
        }; article.append(undo);
      }
      $("profile-changes").append(article);
    }
    $("lock").textContent = state.profiles.l0Locked ? "解除 L0 自动更新锁定" : "锁定 L0 自动更新";
    const fields = { L0: { preferredName: "称呼", occupation: "职业", longTermInterests: "长期兴趣", language: "常用语言", permanentNote: "稳定个人信息" }, L1: { recentGoals: "近期目标", recentPreferences: "近期偏好", currentProject: "当前项目" } };
    for (const [layer, labels] of Object.entries(fields)) {
      for (const [field, label] of Object.entries(labels)) {
        const row = document.createElement("article"), input = document.createElement("input"), button = document.createElement("button"), heading = document.createElement("label");
        heading.textContent = `${layer} · ${label}`; input.id = `profile-${field}`; heading.htmlFor = input.id;
        input.value = state.profiles[layer.toLowerCase()][field]?.content ?? ""; input.maxLength = 1500;
        button.textContent = "保存";
        const revision = state.revision;
        button.onclick = async () => {
          try { await invoke("edit-profile", { layer, field, content: input.value, revision }); await refresh(); }
          catch (e) { $("status").textContent = e.message; }
        };
        row.append(heading, input, button); $("profiles").append(row);
      }
    }
    for (const e of state.entries) {
      const article = document.createElement("article"), time = document.createElement("time"), body = document.createElement("div");
      time.textContent = `来源时间：${new Date(e.sourceAt).toLocaleString()}${e.sourceEndAt !== undefined && e.sourceEndAt !== e.sourceAt ? ` 至 ${new Date(e.sourceEndAt).toLocaleString()}` : ""} · ${e.isSummary ? `压缩摘要（${e.subEntryIds?.length ?? 0} 个子项）` : e.turnId}`;
      const evidence = document.createElement("div"); evidence.textContent = evidenceText(state.evidence, e.id);
      article.append(evidence);
      const quote = e.provenance === "legacy-unverified" ? (e.quote?.trim() ? `旧系统来源片段（未核对）：${e.quote}` : "旧系统未保存可核对的逐字原话") : (e.quote?.trim() ? `用户原话：${e.quote}` : "证据提示：未保存逐字原话，摘要需核对");
      body.textContent = `${e.content}${e.editedAt ? "（手动修改）" : ""}\n${quote}\n状态：${statusLabels[e.status]}${e.pinned ? " · 置顶" : ""} · ${recallable(e) ? "可检索" : "不注入摘要"}\n有效期：${e.validFrom === undefined ? "无起点限制" : new Date(e.validFrom).toLocaleString()} 至 ${e.validTo === undefined ? "无终点限制" : new Date(e.validTo).toLocaleString()}${e.supersededBy ? `\n取代条目：${e.supersededBy}` : ""}${e.mergedInto ? `\n合并目标：${e.mergedInto}` : ""}`;
      article.append(time, body);
      const revision = state.revision;
      const actions = [[e.pinned ? "取消置顶" : "置顶", { pinned: !e.pinned }]];
      if (["active", "aging", "archived"].includes(e.status)) actions.push([e.status === "archived" ? "恢复" : "归档", { status: e.status === "archived" ? "active" : "archived" }]);
      for (const [label, patch] of actions) {
        const button = document.createElement("button"); button.textContent = label;
        button.onclick = async () => {
          try { await invoke("edit-entry", { id: e.id, content: e.content, pinned: e.pinned, status: e.status, ...patch, revision }); await refresh(); }
          catch (err) { $("status").textContent = err.message; }
        }; article.append(button);
      }
      const input = document.createElement("textarea"); input.value = e.content; input.maxLength = 1500; input.setAttribute("aria-label", "编辑记忆摘要");
      const save = document.createElement("button"); save.textContent = "保存摘要";
      save.onclick = async () => { try { await invoke("edit-entry", { id: e.id, content: input.value, pinned: e.pinned, status: e.status, revision }); await refresh(); } catch (err) { $("status").textContent = err.message; } };
      article.append(input, save); $("entries").append(article);
    }
  } catch (e) { $("status").textContent = e.message; }
}
$("refresh").onclick = refresh;
$("native-integration-form").onsubmit = async (event) => {
  event.preventDefault();
  const previous = currentState?.native?.settings ?? { captureEnabled: false, autoExtractEnabled: false, promptInjectionEnabled: false, momentsInjectionEnabled: false, socialContextEnabled: false };
  const next = {
    captureEnabled: $("native-capture").checked,
    autoExtractEnabled: $("native-auto-extract").checked,
    promptInjectionEnabled: $("native-prompt-injection").checked,
    socialContextEnabled: $("native-social-context").checked,
    momentsInjectionEnabled: $("native-moments-injection").checked,
  };
  if (next.autoExtractEnabled && !next.captureEnabled) {
    $("status").textContent = "自动提取依赖原生聊天读取，请先启用读取";
    await refresh();
    return;
  }
  if (next.socialContextEnabled && !next.captureEnabled) {
    $("status").textContent = "对话连续性依赖原生聊天读取，请先启用读取";
    await refresh();
    return;
  }
  if (next.captureEnabled && !previous.captureEnabled && !window.confirm("启用后，插件会读取以后成功完成的原生桌面聊天，并把该轮用户与助手纯文本复制到插件私有存储。不会扫描旧会话，也不会修改宿主聊天或宿主记忆。确认启用？")) { await refresh(); return; }
  if (next.autoExtractEnabled && !previous.autoExtractEnabled && !window.confirm("启用后，插件每积累 10 个待处理轮次，会把当前 10 轮及最多 2 轮前置上下文发送给主程序当前模型提取记忆，可能产生费用。确认启用？")) { await refresh(); return; }
  if (next.promptInjectionEnabled && !previous.promptInjectionEnabled && !window.confirm("启用后，每次上游原生桌面 Chat 都会用当前用户问题检索插件记忆，并把命中结果作为参考资料交给主程序当前模型；外部渠道不会使用。若语义检索也已启用，当前查询还会发送到该 Embedding 服务。确认启用？")) { await refresh(); return; }
  if (next.socialContextEnabled && !previous.socialContextEnabled && !window.confirm("启用后，每个成功落盘的 companion 桌面 Chat 回合都会额外调用一次主程序当前模型，只提取有逐字用户证据的两周内短期状态或三天内未完话题，并写入插件私有存储；相关内容会在同一会话的后续回复中按需注入。若语义检索已启用，新摘要和当前查询可能发送到该 Embedding 服务。确认启用？")) { await refresh(); return; }
  if (next.momentsInjectionEnabled && !previous.momentsInjectionEnabled && !window.confirm("启用后，动态发帖决策会用宿主提供的最近对话摘录检索插件记忆，并把命中摘要作为参考资料。不会更新 DMAE、生命周期或梦境上下文；若语义检索已启用，对话摘录还会发送到该 Embedding 服务。确认启用？")) { await refresh(); return; }
  try { await invoke("save-native-integration", next); await refresh(); $("status").textContent = "原生聊天接入设置已保存。"; }
  catch (e) { await refresh(); $("status").textContent = e.message; }
};
$("native-retry").onclick = async () => {
  try { await invoke("retry-native-integration"); await refresh(); $("status").textContent = "已开始重试待处理轮次。"; }
  catch (e) { $("status").textContent = e.message; }
};
$("history-load-conversations").onclick = async () => {
  try {
    const conversations = await invoke("list-native-conversations");
    const select = $("history-conversations"); select.replaceChildren();
    for (const conversation of conversations) {
      const option = document.createElement("option"); option.value = conversation.id;
      option.textContent = `${conversation.title || "未命名会话"} · ${new Date(conversation.updatedAt).toLocaleString()} · ${conversation.mode}`;
      select.append(option);
    }
    $("history-status").textContent = `已加载 ${conversations.length} 个会话标题；尚未读取消息正文。`;
  } catch (e) { $("status").textContent = e.message; }
};
$("history-preview-form").onsubmit = async (event) => {
  event.preventDefault();
  const conversationIds = [...$("history-conversations").selectedOptions].map((option) => option.value);
  if (!conversationIds.length) { $("status").textContent = "请至少选择一个会话"; return; }
  if (!window.confirm(`将只读分页读取所选 ${conversationIds.length} 个原生会话的 user/assistant 纯文本，在内存中匹配旧触发片段，并在本窗口显示有限候选片段。不会写宿主数据、不会调用模型。确认预检？`)) return;
  try { renderHistoryPreview(await invoke("preview-native-history", { conversationIds })); }
  catch (e) { renderHistoryPreview(undefined); $("status").textContent = e.message; }
};
$("history-apply-unique").onclick = async () => {
  if (!historyPreview?.unique) return;
  if (!window.confirm(`将 ${Math.min(historyPreview.unique, 100)} 条唯一匹配的消息 ID、原文片段、相邻上下文和来源时间写入插件私有记忆，并标为已核对。不会修改宿主会话。确认？`)) return;
  try {
    const result = await invoke("apply-native-history-unique", { previewId: historyPreview.id });
    historyPreview = undefined; renderHistoryPreview(undefined); await refresh(); $("status").textContent = `已绑定 ${result.bound} 条唯一历史来源。`;
  } catch (e) { $("status").textContent = e.message; }
};
$("legacy-preview-form").onsubmit = async (event) => {
  event.preventDefault();
  if (!window.confirm("将只读打开指定 memory.json 并在内存中统计结构，不导入、不调用模型。是否继续？")) return;
  legacyPreview = undefined;
  $("legacy-import").disabled = true;
  $("legacy-preserve-runtime").disabled = true;
  $("legacy-preserve-runtime").checked = false;
  $("legacy-preview").textContent = "";
  try {
    const preview = await invoke("preview-legacy-import", { sourcePath: $("legacy-source").value });
    legacyPreview = preview;
    $("legacy-import").disabled = !preview.canImport || !importTargetEmpty(currentState);
    $("legacy-preserve-runtime").disabled = !preview.runtime?.valid;
    $("legacy-preview").textContent = [
      `源文件：${preview.sourceBytes} 字节 · SHA-256 ${preview.sourceHash}`,
      `L2：${preview.entries.total} 条，有效结构 ${preview.entries.valid}，无效 ${preview.entries.invalid}，重复 ID ${preview.entries.duplicateIds}`,
      `总结 ${preview.entries.summaries} · 谱系异常 ${preview.entries.summaryLineageIssues ?? 0} · 缺逐字原话 ${preview.entries.missingQuote} · 缺 sourceAt ${preview.entries.missingSourceAt} · 缺来源引用 ${preview.entries.missingSourceReference}`,
      `关系异常 ${preview.entries.brokenRelations} · 状态 ${JSON.stringify(preview.entries.statuses)}`,
      `Evidence：${preview.evidence.total} 条，有效结构 ${preview.evidence.valid}，无效 ${preview.evidence.invalid}，孤立 ${preview.evidence.orphaned}，deleted ${preview.evidence.deleted}`,
      `Facets：${preview.facets.present} 条，结构有效 ${preview.facets.valid}，无效 ${preview.facets.invalid}，待分类 ${preview.facets.pending}`,
      `画像：L0 ${preview.profiles.l0} 项 · L1 ${preview.profiles.l1} 项 · 无效 ${preview.profiles.invalid} · 暂不映射旧字段 ${preview.profiles.ignoredLegacyFields}`,
      `本阶段排除：Embedding ${preview.excluded.embeddings} · facets ${preview.excluded.facets} · DMAE ${preview.excluded.dmaeStates} · 梦境 ${preview.excluded.dreams} · 反思日志 ${preview.excluded.reflectionLogs} · 冲突日志 ${preview.excluded.conflictLogs} · 待处理轮次 ${preview.excluded.pendingTurns}`,
      `旧运行状态只读映射：生命周期 ${preview.runtime?.lifecycleRecords ?? 0} 条 · DMAE ${preview.runtime?.dmaeStates ?? 0} 条 · ${preview.runtime?.valid ? "字段兼容，尚未导入" : "存在缺失或异常，禁止宣称状态保真"}`,
      `导入门禁：${preview.canImport ? "结构允许进入下一步（仍未导入）" : "禁止导入"}`,
      `目标插件库：${importTargetEmpty(currentState) ? "空库，可在再次确认后导入" : "非空，禁止覆盖或自动合并"}`,
      ...preview.warnings,
    ].join("\n");
  } catch (e) { $("status").textContent = e.message; }
};
$("legacy-import").onclick = async () => {
  if (!legacyPreview?.canImport || !currentState) return;
  const sourceAttested = $("legacy-source-attested").checked;
  const preserveRuntime = $("legacy-preserve-runtime").checked && legacyPreview.runtime?.valid === true;
  const warning = `将把 ${legacyPreview.entries.total} 条L2（含有效facets）、${legacyPreview.evidence.total}条证据和画像复制到本插件私有空库。源文件只读；Embedding、梦境和维护日志不会导入。${preserveRuntime ? "旧权重、访问统计及 DMAE 状态会一同复制，但插件更新开关不自动启用。" : "旧权重、访问统计及 DMAE 状态不会导入。"}${sourceAttested ? "你确认旧库已核验；插件会如实标注为用户确认，但不会伪造消息 ID。" : "旧来源仍标为未核对。"}插件会先保存空库备份。确认继续？`;
  if (!window.confirm(warning)) return;
  $("legacy-import").disabled = true;
  try {
    const result = await invoke("import-legacy", { sourcePath: $("legacy-source").value, sourceHash: legacyPreview.sourceHash, revision: currentState.revision, sourceAttested, preserveRuntime });
    legacyPreview = undefined; $("legacy-preview").textContent = "";
    await refresh();
    $("status").textContent = `已导入 ${result.importedEntries} 条L2、${result.importedEvidence}条证据、${result.importedProfiles}项画像；源文件未修改。`;
  } catch (e) { $("status").textContent = e.message; $("legacy-import").disabled = false; }
};
$("vector-preview-form").onsubmit = async (event) => {
  event.preventDefault();
  if (!window.confirm("将只读打开指定 memory-store.json，仅统计 user_memory 向量并与已导入 L2 ID 匹配；不读取聊天正文到界面、不导入。是否继续？")) return;
  vectorPreview = undefined; $("vector-import").disabled = true; $("vector-preview").textContent = "";
  try {
    const preview = await invoke("preview-legacy-vectors", { sourcePath: $("vector-source").value }); vectorPreview = preview;
    $("vector-import").disabled = !preview.canImport || !currentState?.legacyImport || currentState?.vectorIndex?.imported;
    $("vector-preview").textContent = [`源文件：${preview.sourceBytes} 字节 · SHA-256 ${preview.sourceHash}`, `全部记录 ${preview.total} · user_memory ${preview.userMemory} · 可关联L2 ${preview.usable}`, `无效 ${preview.invalid} · 重复L2 ID ${preview.duplicateL2Ids} · 未匹配L2 ${preview.unmatchedL2Ids}`, `维度 ${preview.dimensions.join(", ") || "无"}`, `导入门禁：${preview.canImport ? "允许进入下一步（仍未导入）" : "禁止导入"}`].join("\n");
  } catch (e) { $("status").textContent = e.message; }
};
$("vector-import").onclick = async () => {
  if (!vectorPreview?.canImport || !currentState?.legacyImport) return;
  if (!window.confirm(`将 ${vectorPreview.usable} 条 user_memory 向量复制到插件私有索引，并先保存空索引备份。不会复制 chat_history 或修改源文件。确认继续？`)) return;
  $("vector-import").disabled = true;
  try { const result = await invoke("import-legacy-vectors", { sourcePath: $("vector-source").value, sourceHash: vectorPreview.sourceHash }); vectorPreview = undefined; $("vector-preview").textContent = ""; await refresh(); $("status").textContent = `已导入 ${result.entries} 条、${result.dimensions} 维向量；源文件未修改。`; }
  catch (e) { $("status").textContent = e.message; $("vector-import").disabled = false; }
};
$("embedding-form").onsubmit = async (event) => {
  event.preventDefault(); const enabled = $("embedding-enabled").checked;
  if (enabled && !window.confirm("启用 Provider 后，每次聊天或手动检索会把当前查询文本发送到此 Embedding 服务，可能产生费用和延迟。此操作本身不会发送记忆库；只有另行启用“新记忆语义索引”后，后续新增或编辑的摘要才会外发。确认保存并启用？")) return;
  try {
    await invoke("save-embedding", { enabled, baseUrl: $("embedding-url").value, model: $("embedding-model").value, dimensions: Number($("embedding-dimensions").value), apiKey: $("embedding-key").value });
    await refresh(); $("status").textContent = "Embedding Provider 设置已保存；尚未发送测试请求。";
  } catch (e) { $("status").textContent = e.message; }
};
$("embedding-test").onclick = async () => {
  if (!currentState?.embedding?.enabled) { $("status").textContent = "请先保存并启用 Embedding Provider"; return; }
  if (!window.confirm("将向已保存的 Provider 发送固定英文测试文本，不包含用户查询或记忆内容。可能产生少量费用。是否继续？")) return;
  try { const result = await invoke("test-embedding"); $("status").textContent = `Embedding 测试成功：${result.dimensions} 维。`; }
  catch (e) { $("status").textContent = e.message; }
};
$("semantic-index-form").onsubmit = async (event) => {
  event.preventDefault();
  const enabled = $("semantic-index-enabled").checked;
  const wasEnabled = Boolean(currentState?.semanticIndex?.enabled);
  if (enabled && !wasEnabled && !window.confirm("启用时，当前已有记忆只会在插件私有存储中记录内容哈希作为本地基线，不会发送。此后每条新提取或手动编辑且可检索的 L2 摘要正文会发送给已配置的 Embedding Provider，可能产生费用和延迟；不会发送原话、证据、消息 ID或聊天历史。确认启用？")) { await refresh(); return; }
  try { await invoke("save-semantic-index", { enabled }); await refresh(); $("status").textContent = enabled ? "新记忆语义索引已启用；现有记忆未发送。" : "新记忆语义索引已关闭；不会继续外发摘要。"; }
  catch (e) { await refresh(); $("status").textContent = e.message; }
};
$("semantic-index-retry").onclick = async () => {
  try { await invoke("retry-semantic-index"); await refresh(); $("status").textContent = "已开始重试待处理摘要。"; }
  catch (e) { $("status").textContent = e.message; }
};
$("semantic-backfill-preview").onclick = async () => {
  try {
    semanticBackfillPreview = await invoke("preview-semantic-backfill");
    const select = $("semantic-backfill-entries"); select.replaceChildren();
    for (const entry of semanticBackfillPreview.entries) {
      const option = document.createElement("option"); option.value = entry.id; option.textContent = entry.content; select.append(option);
    }
    $("semantic-backfill-apply").disabled = semanticBackfillPreview.entries.length === 0;
    $("semantic-backfill-status").textContent = `有效摘要 ${semanticBackfillPreview.eligible} 条 · 已有当前向量 ${semanticBackfillPreview.alreadyCurrent} 条 · 待补建 ${semanticBackfillPreview.missing} 条${semanticBackfillPreview.truncated ? ` · 本次仅显示前 ${semanticBackfillPreview.entries.length} 条` : ""}`;
  } catch (e) { semanticBackfillPreview = undefined; $("semantic-backfill-apply").disabled = true; $("semantic-backfill-status").textContent = e.message; }
};
$("semantic-backfill-form").onsubmit = async (event) => {
  event.preventDefault();
  if (!semanticBackfillPreview) return;
  const entryIds = [...$("semantic-backfill-entries").selectedOptions].map((option) => option.value);
  if (!entryIds.length) { $("status").textContent = "请至少选择一条摘要"; return; }
  if (entryIds.length > semanticBackfillPreview.maxSelection) { $("status").textContent = `单次最多选择 ${semanticBackfillPreview.maxSelection} 条摘要`; return; }
  if (!window.confirm(`将把所选 ${entryIds.length} 条既有 L2 摘要正文逐条发送给已配置的 Embedding Provider，可能产生费用和延迟。不会发送原话、证据、消息 ID 或聊天历史。确认补建？`)) return;
  try {
    const result = await invoke("apply-semantic-backfill", { previewId: semanticBackfillPreview.id, entryIds });
    semanticBackfillPreview = undefined; $("semantic-backfill-entries").replaceChildren(); $("semantic-backfill-apply").disabled = true;
    await refresh(); $("status").textContent = `已将 ${result.queued} 条摘要加入补建队列。`;
  } catch (e) { $("status").textContent = e.message; }
};
$("related-pairs-preview").onclick = async () => {
  try {
    const preview = await invoke("preview-related-pairs"), byId = new Map(currentState.entries.map((entry) => [entry.id, entry]));
    $("related-pairs").replaceChildren();
    $("related-pairs-status").textContent = `有向量且有效 ${preview.indexed} 条 · 实际比较 ${preview.considered} 条 · 相似候选 ${preview.pairs.length} 对${preview.truncated ? " · 数量超过 300，仅比较首批；未形成全库结论" : ""}`;
    for (const pair of preview.pairs) {
      const left = byId.get(pair.leftId), right = byId.get(pair.rightId); if (!left || !right) continue;
      const article = document.createElement("article"), body = document.createElement("div"), button = document.createElement("button"), compressionButton = document.createElement("button");
      body.textContent = `向量相似度 ${pair.score.toFixed(3)}（不代表冲突）\n左：${left.content}\n右：${right.content}`;
      button.textContent = "填入双条复核";
      button.onclick = () => {
        if (currentState.revision !== preview.revision) { $("status").textContent = "记忆已变化，请重新预检相似候选"; return; }
        $("review-left").value = pair.leftId; $("review-right").value = pair.rightId;
        $("status").textContent = "已填入两条候选；提交模型复核前仍会再次要求确认。";
      };
      compressionButton.textContent = "填入压缩复核";
      compressionButton.onclick = () => {
        if (currentState.revision !== preview.revision) { $("status").textContent = "记忆已变化，请重新预检相似候选"; return; }
        for (const option of $("compression-entries").options) option.selected = option.value === pair.leftId || option.value === pair.rightId;
        $("status").textContent = "已填入压缩候选；请求模型前仍会再次要求确认。";
      };
      article.append(body, button, compressionButton); $("related-pairs").append(article);
    }
  } catch (e) { $("related-pairs").replaceChildren(); $("related-pairs-status").textContent = e.message; }
};
$("review-form").onsubmit = async (event) => {
  event.preventDefault();
  if (!currentState || !$("review-left").value || $("review-left").value === $("review-right").value) { $("status").textContent = "请选择两条不同的有效记忆"; return; }
  if (!window.confirm("将选中两条记忆的摘要、原文证据、关联片段（每条最多3段、每段1200字符）和来源时间发送给当前宿主官方模型服务，可能产生费用。模型仅提供建议，不会自动归档。确认发送？")) return;
  $("review-submit").disabled = true;
  $("status").textContent = "L2 复核中，可取消…";
  try { await invoke("review-entries", { leftId: $("review-left").value, rightId: $("review-right").value, revision: currentState.revision }); await refresh(); }
  catch (e) { $("status").textContent = e.message; }
  finally { $("review-submit").disabled = false; }
};
$("compression-review-form").onsubmit = async (event) => {
  event.preventDefault();
  const entryIds = [...$("compression-entries").selectedOptions].map((option) => option.value);
  if (entryIds.length < 2 || entryIds.length > 5) { $("status").textContent = "请选择 2 至 5 条有效记忆"; return; }
  if (!window.confirm(`将所选 ${entryIds.length} 条记忆的摘要、原文提示、最多三段关联证据及来源时间发送给当前宿主官方模型服务，可能产生费用。模型只提出压缩建议，不会自动修改。确认发送？`)) return;
  $("compression-review-submit").disabled = true;
  try { await invoke("review-compression", { entryIds, revision: currentState.revision }); await refresh(); }
  catch (e) { $("status").textContent = e.message; }
  finally { $("compression-review-submit").disabled = false; }
};
$("compression-clusters-preview").onclick = async () => {
  try {
    const preview = await invoke("preview-compression-clusters"), section = $("compression-clusters"); section.replaceChildren();
    for (const group of preview.groups) {
      const article = document.createElement("article"), entries = group.entryIds.map((id) => currentState.entries.find((entry) => entry.id === id)).filter(Boolean), body = document.createElement("div");
      body.textContent = `组内 ${entries.length} 条 · 种子最低相似度 ${group.minimumScore.toFixed(3)}\n${entries.map((entry) => entry.content).join("\n")}`;
      const fill = document.createElement("button"); fill.textContent = "填入压缩复核";
      fill.onclick = () => { [...$("compression-entries").options].forEach((option) => { option.selected = group.entryIds.includes(option.value); }); $("status").textContent = "已填入 aging 聚类；相似不代表可无损合并，请在请求模型前再次核对并确认。"; };
      article.append(body, fill); section.append(article);
    }
    $("compression-clusters-status").textContent = `比较 ${preview.considered} 条已索引有效记忆，得到 ${preview.groups.length} 组${preview.truncated ? "；索引范围已截断" : ""}。预检没有写入或模型调用。`;
  } catch (e) { $("compression-clusters-status").textContent = e.message; }
};
$("cancel-review").onclick = async () => { try { await invoke("cancel-review"); } catch (e) { $("status").textContent = e.message; } };
$("query-expansion").onchange = async () => {
  const enabled = $("query-expansion").checked;
  if (enabled && !window.confirm("开启后，每次聊天或手动检索将额外向当前宿主官方模型服务发送当前查询，以生成扩展词，可能增加费用和延迟。不发送整个记忆库。是否开启？")) { $("query-expansion").checked = false; return; }
  try { await invoke("query-expansion", enabled); }
  catch (e) { $("query-expansion").checked = !enabled; $("status").textContent = e.message; }
};
$("reranker-enabled").onchange = async () => {
  const enabled = $("reranker-enabled").checked;
  if (enabled && !window.confirm("启用后，每次独立聊天检索或本窗口手动搜索可能会把当前查询和最多 12 条非置顶 L2 摘要正文发送给当前宿主官方模型服务，产生额外费用和延迟。不会发送原话、证据、历史或真实记忆 ID；不会用于原生回复注入。确认启用？")) { $("reranker-enabled").checked = false; return; }
  try { await invoke("reranker", enabled); await refresh(); }
  catch (e) { $("reranker-enabled").checked = !enabled; $("status").textContent = e.message; }
};
$("dmae-enabled").onchange = async () => {
  const enabled = $("dmae-enabled").checked;
  if (enabled && !window.confirm("启用后，插件会在记忆真正注入独立聊天或上游原生回复时保存独立的激活度、静默轮数和注入轮次，使近期话题记忆短暂驻留。不会修改记忆正文、宿主记忆或访问统计；手动搜索与预检不更新状态。确认启用？")) { $("dmae-enabled").checked = false; return; }
  try { await invoke("dmae", enabled); await refresh(); }
  catch (e) { $("dmae-enabled").checked = !enabled; $("status").textContent = e.message; }
};
$("lifecycle-enabled").onchange = async () => {
  const enabled = $("lifecycle-enabled").checked;
  if (enabled && !window.confirm("启用后，只在记忆实际进入独立聊天或原生回复上下文时，向插件私有存储写入该记忆的最后注入时间和累计次数。不会更新宿主访问统计、DMAE 激活值或记忆正文；手动搜索与预检不记录。确认启用？")) { $("lifecycle-enabled").checked = false; return; }
  try { await invoke("lifecycle-tracking", enabled); await refresh(); }
  catch (e) { $("lifecycle-enabled").checked = !enabled; $("status").textContent = e.message; }
};
$("auto-lifecycle").onchange = async () => {
  const enabled = $("auto-lifecycle").checked;
  if (enabled && !window.confirm("启用后，插件只把成功桌面聊天结束事件作为低频时钟，每 24 小时最多一次，仅在插件私有记忆中统计待老化和待归档数量。只保存候选数量，不保存候选正文、不调用模型，也不会自动改变任何记忆状态；具体条目仍需重新预检、选择并确认。确认启用？")) { $("auto-lifecycle").checked = false; return; }
  try { await invoke("auto-lifecycle", enabled); await refresh(); }
  catch (e) { $("auto-lifecycle").checked = !enabled; $("status").textContent = e.message; }
};
$("auto-lifecycle-apply").onchange = async () => {
  const enabled = $("auto-lifecycle-apply").checked;
  if (enabled && !window.confirm("启用后，每日生命周期扫描会自动修改插件私有记忆状态：闲置满 30 天的 active 记忆降为 aging，扫描开始前已为 aging 且闲置满 90 天的记忆归档；已记录的有效非置顶记忆 weight 同时减 1。每次状态降级最多各 100 条，正文和证据不删除，每批都有可撤销快照，不调用模型。确认启用？")) { $("auto-lifecycle-apply").checked = false; return; }
  try { await invoke("auto-lifecycle-apply", enabled); await refresh(); }
  catch (e) { $("auto-lifecycle-apply").checked = !enabled; $("status").textContent = e.message; }
};
$("capacity-preview").onclick = async () => {
  try {
    const preview = await invoke("preview-capacity"); capacityPreview = preview;
    const describe = (entry) => `${entry.id} · ${entry.status} · weight ${entry.weight} · score ${entry.score.toFixed(6)} · ${entry.content}`;
    $("capacity-preview-result").textContent = [
      `active ${preview.activeCount}/${preview.activeCap} · 工作集 ${preview.workingSetCount}/${preview.totalCap}`,
      `计划降为 aging：${preview.toAging.length} 条`, ...preview.toAging.map(describe),
      `计划归档：${preview.toArchive.length} 条`, ...preview.toArchive.map(describe),
    ].join("\n");
    $("capacity-apply").disabled = preview.toAging.length + preview.toArchive.length < 1;
  } catch (e) { capacityPreview = undefined; $("capacity-apply").disabled = true; $("capacity-preview-result").textContent = e.message; }
};
$("capacity-apply").onclick = async () => {
  if (!capacityPreview || !window.confirm(`将按当前预检把最多 ${Math.min(100, capacityPreview.toAging.length)} 条记忆降为 aging，并把最多 ${Math.min(100, capacityPreview.toArchive.length)} 条降为 archived。仅改变插件私有状态，不删除正文或证据，之后可按变更批次撤销。确认执行？`)) return;
  try {
    const result = await invoke("apply-capacity", capacityPreview);
    capacityPreview = undefined; $("capacity-apply").disabled = true;
    $("capacity-preview-result").textContent = `已执行：降为 aging ${result.agingApplied} 条，归档 ${result.archivedApplied} 条。`;
    await refresh();
  } catch (e) { capacityPreview = undefined; $("capacity-apply").disabled = true; $("capacity-preview-result").textContent = e.message; }
};
$("lifecycle-preview-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    lifecyclePreview = await invoke("preview-lifecycle-aging", { days: Number($("lifecycle-days").value), target: $("lifecycle-target").value });
    const select = $("lifecycle-entries"); select.replaceChildren();
    for (const candidate of lifecyclePreview.candidates) {
      const option = document.createElement("option"); option.value = candidate.id;
      option.textContent = `${candidate.content.slice(0, 90)} · ${candidate.basis === "last-injected" ? "最后实际注入" : "无注入记录，按来源时间"} ${new Date(candidate.referenceAt).toLocaleString()}`;
      select.append(option);
    }
    $("lifecycle-apply").disabled = lifecyclePreview.candidates.length < 1;
    $("lifecycle-preview-status").textContent = `${lifecyclePreview.target === "aging" ? "active → aging" : "aging → archived"} 候选 ${lifecyclePreview.candidates.length} 条${lifecyclePreview.truncated ? "（仅显示前 200 条）" : ""}。这只是闲置信号，不代表内容失效。`;
  } catch (e) { $("lifecycle-preview-status").textContent = e.message; }
};
$("lifecycle-apply-form").onsubmit = async (event) => {
  event.preventDefault();
  if (!lifecyclePreview) return;
  const entryIds = [...$("lifecycle-entries").selectedOptions].map((option) => option.value);
  if (!entryIds.length || entryIds.length > 100) { $("lifecycle-preview-status").textContent = "请选择 1 至 100 条候选"; return; }
  const isArchive = lifecyclePreview.target === "archived";
  if (!window.confirm(isArchive ? `将所选 ${entryIds.length} 条 aging 记忆归档。不会删除正文、原始对话或证据，之后可在 L2 列表手动恢复。确认？` : `将所选 ${entryIds.length} 条 active 记忆标为 aging。它们仍可检索和注入；不会归档、删除或修改证据。确认？`)) return;
  try {
    await invoke("apply-lifecycle-aging", { ...lifecyclePreview, candidates: undefined, entryIds });
    lifecyclePreview = undefined; $("lifecycle-entries").replaceChildren(); $("lifecycle-apply").disabled = true;
    await refresh(); $("lifecycle-preview-status").textContent = `已将 ${entryIds.length} 条记忆标为 ${isArchive ? "archived" : "aging"}。`;
  } catch (e) { $("lifecycle-preview-status").textContent = e.message; }
};
$("lifecycle-target").onchange = () => { const archived = $("lifecycle-target").value === "archived"; $("lifecycle-days").min = archived ? "90" : "30"; $("lifecycle-days").value = archived ? "90" : "30"; lifecyclePreview = undefined; $("lifecycle-entries").replaceChildren(); $("lifecycle-apply").disabled = true; };
$("dream-injection").onchange = async () => {
  const enabled = $("dream-injection").checked;
  if (enabled && !window.confirm("启用后，最近 3 段由你确认保存的模型反思会作为明确标注的非事实材料注入独立聊天和上游原生回复。不会注入手动搜索，不会修改来源记忆。确认启用？")) { $("dream-injection").checked = false; return; }
  try { await invoke("dream-injection", enabled); await refresh(); }
  catch (e) { $("dream-injection").checked = !enabled; $("status").textContent = e.message; }
};
$("auto-dream").onchange = async () => {
  const enabled = $("auto-dream").checked;
  if (enabled && !window.confirm("启用后，插件会把原生桌面 Chat 连续 15 分钟没有新活动视为近似空闲，每 24 小时最多运行一次完整梦境周期：先按 300/800 容量规则在插件私有记忆中降级溢出项，再把本轮最多 20 条降级记忆发送给当前宿主官方模型生成叙事草稿，最后按 0.82 向量阈值最多生成 5 组安全压缩建议，可能产生模型费用。容量状态会自动改变但可撤销；叙事保存和压缩应用仍由各自独立设置决定。系统级真实空闲状态不可用，用户返回会取消尚未开始的阶段。确认启用？")) { $("auto-dream").checked = false; return; }
  try { await invoke("auto-dream", enabled); await refresh(); }
  catch (e) { $("auto-dream").checked = !enabled; $("status").textContent = e.message; }
};
$("auto-dream-apply").onchange = async () => {
  const enabled = $("auto-dream-apply").checked;
  if (enabled && !window.confirm("启用后，后台梦境生成并通过现有来源快照与长度校验的叙事会自动保存到插件私有梦境库。它不会修改来源记忆，仍可撤销；是否注入聊天由独立开关控制。确认启用自动保存？")) { $("auto-dream-apply").checked = false; return; }
  try { await invoke("auto-dream-apply", enabled); await refresh(); }
  catch (e) { $("auto-dream-apply").checked = !enabled; $("status").textContent = e.message; }
};
$("dream-review-form").onsubmit = async (event) => {
  event.preventDefault();
  const entryIds = [...$("dream-entries").selectedOptions].map((option) => option.value);
  if (entryIds.length < 2 || entryIds.length > 20) { $("status").textContent = "请选择 2 至 20 条 aging 非置顶记忆"; return; }
  if (!window.confirm(`将所选 ${entryIds.length} 条记忆的摘要、原话提示、最多两段关联证据和来源时间发送给当前宿主官方模型服务，可能产生费用。模型只生成草稿，不会直接保存或修改记忆。确认发送？`)) return;
  $("dream-review-submit").disabled = true;
  try { await invoke("review-dream", { entryIds, revision: currentState.revision }); await refresh(); }
  catch (e) { $("status").textContent = e.message; }
  finally { $("dream-review-submit").disabled = false; }
};
$("maintenance-preview").onclick = async () => {
  try {
    maintenancePreview = await invoke("preview-maintenance-inbox");
    const section = $("maintenance-preview-results"); section.replaceChildren();
    for (const candidate of maintenancePreview.candidates) {
      const left = currentState.entries.find((entry) => entry.id === candidate.leftId), right = currentState.entries.find((entry) => entry.id === candidate.rightId);
      const label = document.createElement("label"), checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.value = candidate.key;
      label.append(checkbox, document.createTextNode(`${candidate.kind === "normalized-duplicate" ? "规范化正文相同" : `向量相似 ${candidate.score?.toFixed(3)}`} · ${left?.content ?? candidate.leftId} / ${right?.content ?? candidate.rightId}`)); section.append(label);
    }
    $("maintenance-add").disabled = maintenancePreview.candidates.length < 1;
    $("maintenance-status").textContent = `发现 ${maintenancePreview.candidates.length} 对候选；尚未写入。`;
  } catch (e) { $("maintenance-status").textContent = e.message; }
};
$("auto-maintenance").onchange = async () => {
  const enabled = $("auto-maintenance").checked;
  if (enabled && !window.confirm("启用后，插件只把成功桌面聊天结束事件当作低频时钟，每 24 小时最多扫描一次插件私有 L2 与已有向量索引，并把新候选关系写入插件私有收件箱。事件不含聊天正文；扫描不读取宿主会话、不调用模型、不修改记忆，也不创建 Scheduler 聊天任务。确认启用？")) { $("auto-maintenance").checked = false; return; }
  try { await invoke("auto-maintenance", enabled); await refresh(); }
  catch (e) { $("auto-maintenance").checked = !enabled; $("status").textContent = e.message; }
};
$("auto-review").onchange = async () => {
  const enabled = $("auto-review").checked;
  if (enabled && !window.confirm("启用后，每累计 5 个成功桌面聊天轮次，插件最多选择一对尚未复核的收件箱候选，把两条记忆摘要、原话提示、来源时间和有限关联证据发送给当前宿主官方模型服务，可能产生费用。模型结果只保存为待确认建议，不会自动归档、合并或修改记忆。确认启用？")) { $("auto-review").checked = false; return; }
  try { await invoke("auto-review", enabled); await refresh(); }
  catch (e) { $("auto-review").checked = !enabled; $("status").textContent = e.message; }
};
$("auto-review-apply").onchange = async () => {
  const enabled = $("auto-review-apply").checked;
  if (enabled && !window.confirm("启用后，后台 Resolver 复核可自动关闭高置信无变更结论，或原子应用置信度至少 0.90、带完整双来源总结且两侧均退出当前状态的偏好演进计划。直接冲突、证据不足、低置信或要求澄清的计划不会自动应用；实际变更可在未发生后续变化时撤销。确认启用？")) { $("auto-review-apply").checked = false; return; }
  try { await invoke("auto-review-apply", enabled); await refresh(); }
  catch (e) { $("auto-review-apply").checked = !enabled; $("status").textContent = e.message; }
};
$("auto-compression").onchange = async () => {
  const enabled = $("auto-compression").checked;
  if (enabled && !window.confirm("启用后，每累计 20 个成功桌面聊天轮次，插件最多选择一组 aging、非置顶且已有私有向量索引的相似记忆，把摘要、原话提示、来源时间和有限关联证据发送给当前宿主官方模型服务，可能产生费用。模型结果只保存为待确认压缩建议，不会自动创建总结、合并来源记忆或改变任何状态。确认启用？")) { $("auto-compression").checked = false; return; }
  try { await invoke("auto-compression", enabled); await refresh(); }
  catch (e) { $("auto-compression").checked = !enabled; $("status").textContent = e.message; }
};
$("auto-compression-mode").onchange = async () => {
  const enabled = $("auto-compression-mode").value === "auto";
  if (enabled && !window.confirm("切换到自动模式后，后台压缩只会自动应用至少 3 条 aging、非置顶、非摘要来源构成的建议，并要求模型置信度至少 0.80 且明确确认总结完整覆盖时间变化、对象、否定、计划和结果。任何快照或证据变化都会拒绝执行；实际变更可在未发生后续变化时严格撤销。确认启用？")) { $("auto-compression-mode").value = "manual"; return; }
  try { await invoke("auto-compression-apply", enabled); await refresh(); }
  catch (e) { $("auto-compression-mode").value = enabled ? "manual" : "auto"; $("status").textContent = e.message; }
};
$("auto-reflection").onchange = async () => {
  const enabled = $("auto-reflection").checked;
  if (enabled && !window.confirm("启用后，每累计 20 个成功桌面聊天轮次，插件会把当前 L0/L1 和最多 30 条带原话或证据的当前有效 L2 发送给当前宿主官方模型服务，可能产生费用。模型最多生成 8 条待确认变更，不会新增空字段、直接覆盖画像或绕过 L0 锁定。确认启用？")) { $("auto-reflection").checked = false; return; }
  try { await invoke("auto-reflection", enabled); await refresh(); }
  catch (e) { $("auto-reflection").checked = !enabled; $("status").textContent = e.message; }
};
$("maintenance-add").onclick = async () => {
  if (!maintenancePreview) return;
  const keys = [...$("maintenance-preview-results").querySelectorAll('input[type="checkbox"]:checked')].map((input) => input.value);
  if (!keys.length || keys.length > 50) { $("maintenance-status").textContent = "请选择 1 至 50 对候选"; return; }
  if (!window.confirm(`只把所选 ${keys.length} 对关系保存到插件私有维护收件箱，不调用模型、不修改记忆。确认？`)) return;
  try { await invoke("add-maintenance-inbox", { ...maintenancePreview, candidates: undefined, keys }); maintenancePreview = undefined; $("maintenance-preview-results").replaceChildren(); $("maintenance-add").disabled = true; await refresh(); $("maintenance-status").textContent = `已保存 ${keys.length} 对候选。`; }
  catch (e) { $("maintenance-status").textContent = e.message; }
};
$("maintenance-review-batch").onclick = async () => {
  const itemIds = [...document.querySelectorAll(".maintenance-inbox-pick:checked")].map((input) => input.value);
  if (!itemIds.length || itemIds.length > 5) { $("maintenance-status").textContent = "请选择 1 至 5 对未失效的收件箱候选"; return; }
  if (!window.confirm(`将逐对发送所选 ${itemIds.length} 对记忆的摘要、原话提示、来源时间和最多三段关联证据给当前宿主官方模型服务，最多产生 ${itemIds.length} 次请求。结果只保存为待确认建议，不会自动归档、合并或关闭候选。确认发送？`)) return;
  $("maintenance-review-batch").disabled = true;
  try { const result = await invoke("review-maintenance-batch", { itemIds }); await refresh(); $("maintenance-status").textContent = `已生成 ${result.completed} 条待确认复核建议。`; }
  catch (e) { await refresh(); $("maintenance-status").textContent = e.message; }
  finally { $("maintenance-review-batch").disabled = false; }
};
$("lock").onclick = () => { if (currentState) return edit("lock-profile", { locked: !currentState.profiles.l0Locked }); };
$("search").onsubmit = async (event) => { event.preventDefault(); try { $("result").textContent = await invoke("search", $("query").value) || "没有匹配结果"; } catch (e) { $("status").textContent = e.message; } };
$("cold-recall-preview-form").onsubmit = async (event) => {
  event.preventDefault();
  try {
    coldRecallPreview = await invoke("preview-archived-recall", { query: $("cold-recall-query").value });
    const select = $("cold-recall-candidates"); select.replaceChildren();
    for (const candidate of coldRecallPreview.candidates) {
      const option = document.createElement("option"); option.value = candidate.id;
      const evidence = candidate.evidence ? `；${candidate.evidence.replace(/\s+/g, " ").slice(0, 240)}` : "";
      option.textContent = `${candidate.content}；来源 ${new Date(candidate.sourceAt).toLocaleString()}；${candidate.quote}${evidence}`;
      select.append(option);
    }
    $("cold-recall-restore").disabled = coldRecallPreview.candidates.length < 1;
    $("cold-recall-status").textContent = coldRecallPreview.reason === "ordinary-match-present"
      ? `普通有效记忆已有 ${coldRecallPreview.hotRelevantCount} 条明确命中，未开放归档候选。`
      : coldRecallPreview.reason === "archived-candidates"
        ? `找到 ${coldRecallPreview.candidates.length} 条归档候选；尚未恢复，也未写入任何检索状态。`
        : "普通记忆和归档记忆都没有明确命中。";
  } catch (e) { coldRecallPreview = undefined; $("cold-recall-candidates").replaceChildren(); $("cold-recall-restore").disabled = true; $("cold-recall-status").textContent = e.message; }
};
$("cold-recall-restore-form").onsubmit = async (event) => {
  event.preventDefault();
  if (!coldRecallPreview) return;
  const entryIds = [...$("cold-recall-candidates").selectedOptions].map((option) => option.value);
  if (!entryIds.length || entryIds.length > 8) { $("cold-recall-status").textContent = "请选择 1 至 8 条候选"; return; }
  if (!window.confirm(`将所选 ${entryIds.length} 条 archived 记忆恢复为 active，使其从后续查询起重新参与检索和聊天注入。不会修改正文、原始对话、证据、DMAE 激活值或访问统计；本次变更可在未发生后续修改时撤销。确认？`)) return;
  try {
    await invoke("restore-archived-recall", { memoryRevision: coldRecallPreview.memoryRevision, query: coldRecallPreview.query, token: coldRecallPreview.token, entryIds });
    coldRecallPreview = undefined; $("cold-recall-candidates").replaceChildren(); $("cold-recall-restore").disabled = true;
    await refresh(); $("cold-recall-status").textContent = `已恢复 ${entryIds.length} 条记忆；本次操作没有更新 DMAE 或访问统计。`;
  } catch (e) { $("cold-recall-status").textContent = e.message; }
};
refresh();
