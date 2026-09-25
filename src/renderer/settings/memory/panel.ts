// Memory 面板业务逻辑：加载 / 编辑 / 保存 / 渲染
// 从 settings.ts 抽离。依赖 memory DOM 引用（./dom）、memoryState（./state）、
// shared 工具（renderInfoList / renderEmptyState / shallowEqual / formatDateTime / escapeHtml）。

import { memoryState } from "./state";
import {
  memoryL0NameInput, memoryL0OccupationInput, memoryL0InterestsInput,
  memoryL0LanguageInput, memoryL0NoteInput,
  memoryL1GoalsInput, memoryL1PreferencesInput, memoryL1ProjectInput,
  memoryL2SearchInput, memoryL2List,
  memoryImportedList, memoryReflectionList,
  memoryL0EditBtn, memoryL0CancelBtn,
  memoryL1EditBtn, memoryL1CancelBtn,
} from "./dom";
import { renderInfoList, renderEmptyState } from "../shared/render";
import { shallowEqual } from "../shared/utils";
import { formatDateTime, escapeHtml } from "../shared/format";
import { showModal } from "../shared/modal";

function formatL2MemoryTimeMeta(item: NonNullable<typeof memoryState.panelCache>["l2"][number]): string {
  if (typeof item.sourceAt !== "number") return `创建于：${formatDateTime(item.createdAt)}`;
  const sourceStart = formatDateTime(item.sourceAt);
  const sourceEnd = typeof item.sourceEndAt === "number" && item.sourceEndAt !== item.sourceAt
    ? ` ～ ${formatDateTime(item.sourceEndAt)}`
    : "";
  return `来源于：${sourceStart}${sourceEnd} · 写入于：${formatDateTime(item.createdAt)}`;
}

function renderL2List(query = ""): void {
  const list = memoryState.panelCache?.l2 ?? [];
  const normalized = query.trim().toLowerCase();
  const filtered = normalized
    ? list.filter((item) => {
        const haystack = [item.content, item.triggerText, item.status].join(" ").toLowerCase();
        return haystack.includes(normalized);
      })
    : list;

  if (!memoryL2List) return;
  if (filtered.length === 0) {
    renderEmptyState(
      memoryL2List,
      normalized ? "没有匹配的事件记忆" : "暂无事件记忆",
      normalized ? "换个关键词试试" : "聊天后昔涟会自动提炼重要信息",
    );
    return;
  }

  memoryL2List.innerHTML = filtered.map((item) => [
    `<article class="memory-record memory-record--doc" data-l2-id="${escapeHtml(item.id)}">`,
    '  <div class="memory-record__main">',
    `    <h3 class="memory-record__title">${escapeHtml(item.content)}</h3>`,
    `    <p class="memory-record__body">${escapeHtml(item.triggerText ? `触发片段：${item.triggerText}` : "无触发片段")}</p>`,
    `    <p class="memory-record__meta">${escapeHtml(`状态：${item.status} · 权重：${item.weight.toFixed(1)} · ${formatL2MemoryTimeMeta(item)}`)}</p>`,
    '  </div>',
    '  <div class="memory-record__actions">',
    '    <button type="button" class="memory-record__edit" title="编辑此记忆">✏️</button>',
    '    <button type="button" class="memory-record__delete" title="删除此记忆">🗑️</button>',
    '  </div>',
    '</article>',
  ].join("\n")).join("\n");
}

memoryL2SearchInput?.addEventListener("input", () => renderL2List(memoryL2SearchInput.value));

memoryL2List?.addEventListener("click", async (event) => {
  const target = event.target as HTMLElement | null;
  const record = target?.closest<HTMLElement>("[data-l2-id]");
  const id = record?.dataset.l2Id || "";
  const item = memoryState.panelCache?.l2.find((entry) => entry.id === id);
  if (!record || !item) return;

  if (target?.closest(".memory-record__edit")) {
    record.innerHTML = [
      '  <div class="memory-record__main">',
      `    <textarea class="memory-record__editor" maxlength="2000" aria-label="编辑记忆内容">${escapeHtml(item.content)}</textarea>`,
      `    <p class="memory-record__body">${escapeHtml(item.triggerText ? `触发片段（不会修改）：${item.triggerText}` : "无触发片段")}</p>`,
      `    <p class="memory-record__meta">${escapeHtml(`状态：${item.status} · 权重：${item.weight.toFixed(1)} · ${formatL2MemoryTimeMeta(item)}`)}</p>`,
      '  </div>',
      '  <div class="memory-record__actions">',
      '    <button type="button" class="memory-record__save">保存</button>',
      '    <button type="button" class="memory-record__cancel">取消</button>',
      '  </div>',
    ].join("\n");
    const editor = record.querySelector<HTMLTextAreaElement>(".memory-record__editor");
    editor?.focus();
    editor?.setSelectionRange(editor.value.length, editor.value.length);
    return;
  }

  if (target?.closest(".memory-record__cancel")) {
    renderL2List(memoryL2SearchInput?.value || "");
    return;
  }

  if (target?.closest(".memory-record__save")) {
    const editor = record.querySelector<HTMLTextAreaElement>(".memory-record__editor");
    const content = editor?.value.trim() || "";
    if (!content) {
      await showModal({ title: "无法保存", message: "记忆内容不能为空。", icon: "⚠️", confirmText: "知道了" });
      return;
    }
    record.querySelectorAll<HTMLButtonElement>("button").forEach((button) => { button.disabled = true; });
    try {
      const result = await window.memoryPanel?.editL2(id, content);
      if (!result?.ok) throw new Error(result?.error || "编辑失败");
      await loadMemoryPanel();
      if (!result.indexed) {
        await showModal({
          title: "正文已保存",
          message: "新的语义索引暂时未能建立，这条记忆在索引修复前不会被自动召回。",
          icon: "⚠️",
          confirmText: "知道了",
        });
      }
    } catch (error) {
      record.querySelectorAll<HTMLButtonElement>("button").forEach((button) => { button.disabled = false; });
      await showModal({ title: "编辑失败", message: error instanceof Error ? error.message : String(error), icon: "⚠️", confirmText: "知道了" });
    }
    return;
  }

  if (target?.closest(".memory-record__delete")) {
    const confirmed = await showModal({
      title: "删除事件记忆",
      message: `确定删除这条记忆？\n\n${item.content}\n\n删除后不可恢复。`,
      icon: "⚠️",
      confirmText: "删除",
      cancelText: "取消",
    });
    if (!confirmed) return;
    try {
      const result = await window.memoryPanel?.deleteL2(id);
      if (!result?.ok) throw new Error(result?.error || "删除失败");
      await loadMemoryPanel();
    } catch (error) {
      await showModal({ title: "删除失败", message: error instanceof Error ? error.message : String(error), icon: "⚠️", confirmText: "知道了" });
    }
  }
});

export async function loadMemoryPanel(): Promise<void> {
  try {
    const payload = await window.memoryPanel?.getData();
    if (!payload) return;
    memoryState.panelCache = payload;

    if (memoryL0NameInput) memoryL0NameInput.value = payload.l0.preferredName || "";
    if (memoryL0OccupationInput) memoryL0OccupationInput.value = payload.l0.occupation || "";
    if (memoryL0InterestsInput) memoryL0InterestsInput.value = payload.l0.longTermInterests || "";
    if (memoryL0LanguageInput) memoryL0LanguageInput.value = payload.l0.language || "";
    if (memoryL0NoteInput) memoryL0NoteInput.value = payload.l0.permanentNote || "";

    if (memoryL1GoalsInput) memoryL1GoalsInput.value = payload.l1.recentGoals || "";
    if (memoryL1PreferencesInput) memoryL1PreferencesInput.value = payload.l1.recentPreferences || "";
    if (memoryL1ProjectInput) memoryL1ProjectInput.value = payload.l1.currentProject || "";

    renderL2List(memoryL2SearchInput?.value || "");

    renderImportedDocs();

    renderInfoList(
      memoryReflectionList,
      payload.reflections,
      "暂无回顾",
      "当前项目里回顾还没真正生成落地",
    );

    if (memoryL0EditBtn) memoryL0EditBtn.disabled = false;
    if (memoryL1EditBtn) memoryL1EditBtn.disabled = false;
  } catch (err) {
    console.error("[settings] load memory panel failed", err);
    renderEmptyState(memoryL2List, "片段读取失败", "请查看终端日志");
    renderEmptyState(memoryImportedList, "导入知识读取失败", "请查看终端日志");
    renderEmptyState(memoryReflectionList, "回顾读取失败", "请查看终端日志");
  }
}

function takeL0Snapshot(): Record<string, string> {
  return {
    preferredName: memoryL0NameInput?.value ?? "",
    occupation: memoryL0OccupationInput?.value ?? "",
    longTermInterests: memoryL0InterestsInput?.value ?? "",
    language: memoryL0LanguageInput?.value ?? "",
    permanentNote: memoryL0NoteInput?.value ?? "",
  };
}

function takeL1Snapshot(): Record<string, string> {
  return {
    recentGoals: memoryL1GoalsInput?.value ?? "",
    recentPreferences: memoryL1PreferencesInput?.value ?? "",
    currentProject: memoryL1ProjectInput?.value ?? "",
  };
}

function setL0FieldsDisabled(disabled: boolean): void {
  if (memoryL0NameInput) disabled ? memoryL0NameInput.setAttribute("disabled", "") : memoryL0NameInput.removeAttribute("disabled");
  if (memoryL0OccupationInput) disabled ? memoryL0OccupationInput.setAttribute("disabled", "") : memoryL0OccupationInput.removeAttribute("disabled");
  if (memoryL0InterestsInput) disabled ? memoryL0InterestsInput.setAttribute("disabled", "") : memoryL0InterestsInput.removeAttribute("disabled");
  if (memoryL0LanguageInput) disabled ? memoryL0LanguageInput.setAttribute("disabled", "") : memoryL0LanguageInput.removeAttribute("disabled");
  if (memoryL0NoteInput) disabled ? memoryL0NoteInput.setAttribute("disabled", "") : memoryL0NoteInput.removeAttribute("disabled");
}

function setL1FieldsDisabled(disabled: boolean): void {
  if (memoryL1GoalsInput) disabled ? memoryL1GoalsInput.setAttribute("disabled", "") : memoryL1GoalsInput.removeAttribute("disabled");
  if (memoryL1PreferencesInput) disabled ? memoryL1PreferencesInput.setAttribute("disabled", "") : memoryL1PreferencesInput.removeAttribute("disabled");
  if (memoryL1ProjectInput) disabled ? memoryL1ProjectInput.setAttribute("disabled", "") : memoryL1ProjectInput.removeAttribute("disabled");
}

export function enterL0EditMode(): void {
  if (memoryState.l0Editing) return;
  memoryState.l0Editing = true;
  memoryState.l0Snapshot = takeL0Snapshot();
  setL0FieldsDisabled(false);
  if (memoryL0EditBtn) memoryL0EditBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 48 48" fill="none" aria-hidden="true" style="display:inline;vertical-align:-2px"><path d="M6 9C6 7.34315 7.34315 6 9 6H30.3363C31.132 6 31.895 6.31607 32.4576 6.87868L36.3158 10.7368L41.1213 15.5424C41.6839 16.105 42 16.868 42 17.6637V39C42 40.6569 40.6569 42 39 42H9C7.34315 42 6 40.6569 6 39V9Z" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M31 26H17C15.3431 26 14 27.3431 14 29V42H34V29C34 27.3431 32.6569 26 31 26Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M29 16H17C15.3431 16 14 14.6569 14 13V6" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg> 保存`;
  if (memoryL0CancelBtn) memoryL0CancelBtn.classList.remove("is-hidden");
}

export function exitL0EditMode(): void {
  memoryState.l0Editing = false;
  memoryState.l0Snapshot = null;
  setL0FieldsDisabled(true);
  if (memoryL0EditBtn) memoryL0EditBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 48 48" fill="none" aria-hidden="true" style="display:inline;vertical-align:-2px"><path d="M5.32497 43.4996L13.81 43.4998L44.9227 12.3871L36.4374 3.90186L5.32471 35.0146L5.32497 43.4996Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M27.9521 12.3872L36.4374 20.8725" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg> 编辑`;
  if (memoryL0CancelBtn) memoryL0CancelBtn.classList.add("is-hidden");
}

export async function saveL0(): Promise<void> {
  const current = takeL0Snapshot();
  if (memoryState.l0Snapshot && shallowEqual(current, memoryState.l0Snapshot)) {
    exitL0EditMode();
    return;
  }
  try {
    await window.memoryPanel?.saveL0(current);
    await loadMemoryPanel();
    exitL0EditMode();
    if (memoryL0EditBtn) {
      memoryL0EditBtn.textContent = "✅ 已保存";
      setTimeout(() => { if (memoryL0EditBtn && !memoryState.l0Editing) memoryL0EditBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 48 48" fill="none" aria-hidden="true" style="display:inline;vertical-align:-2px"><path d="M5.32497 43.4996L13.81 43.4998L44.9227 12.3871L36.4374 3.90186L5.32471 35.0146L5.32497 43.4996Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M27.9521 12.3872L36.4374 20.8725" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg> 编辑`; }, 2000);
    }
  } catch (err) {
    console.error("[settings] save L0 failed", err);
    alert("保存失败，请重试");
  }
}

export function cancelL0Edit(): void {
  if (memoryState.l0Snapshot) {
    if (memoryL0NameInput) memoryL0NameInput.value = memoryState.l0Snapshot.preferredName;
    if (memoryL0OccupationInput) memoryL0OccupationInput.value = memoryState.l0Snapshot.occupation;
    if (memoryL0InterestsInput) memoryL0InterestsInput.value = memoryState.l0Snapshot.longTermInterests;
    if (memoryL0LanguageInput) memoryL0LanguageInput.value = memoryState.l0Snapshot.language;
    if (memoryL0NoteInput) memoryL0NoteInput.value = memoryState.l0Snapshot.permanentNote;
  }
  exitL0EditMode();
}

export function enterL1EditMode(): void {
  if (memoryState.l1Editing) return;
  memoryState.l1Editing = true;
  memoryState.l1Snapshot = takeL1Snapshot();
  setL1FieldsDisabled(false);
  if (memoryL1EditBtn) memoryL1EditBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 48 48" fill="none" aria-hidden="true" style="display:inline;vertical-align:-2px"><path d="M6 9C6 7.34315 7.34315 6 9 6H30.3363C31.132 6 31.895 6.31607 32.4576 6.87868L36.3158 10.7368L41.1213 15.5424C41.6839 16.105 42 16.868 42 17.6637V39C42 40.6569 40.6569 42 39 42H9C7.34315 42 6 40.6569 6 39V9Z" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M31 26H17C15.3431 26 14 27.3431 14 29V42H34V29C34 27.3431 32.6569 26 31 26Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M29 16H17C15.3431 16 14 14.6569 14 13V6" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg> 保存`;
  if (memoryL1CancelBtn) memoryL1CancelBtn.classList.remove("is-hidden");
}

export function exitL1EditMode(): void {
  memoryState.l1Editing = false;
  memoryState.l1Snapshot = null;
  setL1FieldsDisabled(true);
  if (memoryL1EditBtn) memoryL1EditBtn.innerHTML = `<svg width="18" height="18" viewBox="0 0 48 48" fill="none" aria-hidden="true" style="display:inline;vertical-align:-2px"><path d="M5.32497 43.4996L13.81 43.4998L44.9227 12.3871L36.4374 3.90186L5.32471 35.0146L5.32497 43.4996Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M27.9521 12.3872L36.4374 20.8725" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg> 编辑`;
  if (memoryL1CancelBtn) memoryL1CancelBtn.classList.add("is-hidden");
}

export async function saveL1(): Promise<void> {
  const current = takeL1Snapshot();
  if (memoryState.l1Snapshot && shallowEqual(current, memoryState.l1Snapshot)) {
    exitL1EditMode();
    return;
  }
  try {
    await window.memoryPanel?.saveL1(current);
    await loadMemoryPanel();
    exitL1EditMode();
    if (memoryL1EditBtn) {
      memoryL1EditBtn.textContent = "✅ 已保存";
      setTimeout(() => { if (memoryL1EditBtn && !memoryState.l1Editing) memoryL1EditBtn.textContent = "✏️ 编辑"; }, 2000);
    }
  } catch (err) {
    console.error("[settings] save L1 failed", err);
    alert("保存失败，请重试");
  }
}

export function cancelL1Edit(): void {
  if (memoryState.l1Snapshot) {
    if (memoryL1GoalsInput) memoryL1GoalsInput.value = memoryState.l1Snapshot.recentGoals;
    if (memoryL1PreferencesInput) memoryL1PreferencesInput.value = memoryState.l1Snapshot.recentPreferences;
    if (memoryL1ProjectInput) memoryL1ProjectInput.value = memoryState.l1Snapshot.currentProject;
  }
  exitL1EditMode();
}

export function renderImportedDocs(): void {
  const list = memoryState.panelCache?.importedDocs ?? [];
  if (!memoryImportedList) return;

  if (list.length === 0) {
    renderEmptyState(memoryImportedList, "暂无导入文档", "在聊天窗口上传文件后会自动索引");
    return;
  }

  memoryImportedList.innerHTML = list
    .map((item) => {
      const importId = item.importId || "";
      const fileName = escapeHtml(item.fileName);
      const chunkInfo = "已索引 " + item.chunkCount + " 个片段";
      const timeInfo = "最近导入：" + formatDateTime(item.lastImportedAt);
      return [
        '<article class="memory-record memory-record--doc">',
        '  <div class="memory-record__main">',
        '    <h3 class="memory-record__title">' + fileName + '</h3>',
        '    <p class="memory-record__body">' + escapeHtml(chunkInfo) + '</p>',
        '    <p class="memory-record__meta">' + escapeHtml(timeInfo) + '</p>',
        '  </div>',
        '  <button type="button" class="memory-record__delete" data-import-id="' + escapeHtml(importId) + '" data-file-name="' + fileName + '" title="删除此导入文档"><svg width="16" height="16" viewBox="0 0 48 48" fill="none" aria-hidden="true" style="vertical-align:-2px"><path fill-rule="evenodd" clip-rule="evenodd" d="M8 15H40L37 44H11L8 15Z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><path d="M20.002 25.0024V35.0026" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M28.0024 24.9995V34.9972" stroke="currentColor" stroke-width="4" stroke-linecap="round"/><path d="M12 14.9999L28.3242 3L36 15" stroke="currentColor" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/></svg></button>',
        '</article>',
      ].join("\n");
    })
    .join("\n");
}
