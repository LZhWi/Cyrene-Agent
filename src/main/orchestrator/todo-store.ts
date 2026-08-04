// 任务清单 store —— todo_write 工具背后的持久化层。
//
// 设计：
// - 按 work / daily / learn 三个模式分别持有独立 TodoState
// - 每次 setTodos(mode, ...) 持久化到 userData/todos/{mode}.json
// - 监听者按 mode 分发；主进程订阅后转发 CUSTOM 事件给渲染端
// - 启动时 loadTodos() 从磁盘恢复各模式未完成任务（跨重启延续）
// - 兼容旧版：启动时发现 userData/current-todos.json 时迁移到 work.json

import * as fs from "fs";
import * as path from "path";
import { app } from "electron";
import { logger, LogTag } from "../logger";

import type { ConversationMode } from "../../shared/chat-types";
export type TodoStatus = "pending" | "in_progress" | "completed";
export type TodoPriority = "high" | "medium" | "low";

import type { TodoItem, TodoState } from "../../shared/todo-types";
export type { TodoItem, TodoState };

export const TODO_MODES = ["work", "daily", "learn"] as const;
export type TodoMode = (typeof TODO_MODES)[number];

const EMPTY_STATE: TodoState = { todos: [], updatedAt: 0 };

const stores: Record<TodoMode, { current: TodoState; listeners: Array<(s: TodoState) => void>; loaded: boolean }> = {
  work: { current: { ...EMPTY_STATE }, listeners: [], loaded: false },
  daily: { current: { ...EMPTY_STATE }, listeners: [], loaded: false },
  learn: { current: { ...EMPTY_STATE }, listeners: [], loaded: false },
};

function todosDirPath(): string {
  return path.join(app.getPath("userData"), "todos");
}

function todoFilePath(mode: TodoMode): string {
  return path.join(todosDirPath(), `${mode}.json`);
}

function legacyTodoFilePath(): string {
  return path.join(app.getPath("userData"), "current-todos.json");
}

function isValidTodoMode(value: unknown): value is TodoMode {
  return typeof value === "string" && TODO_MODES.includes(value as TodoMode);
}

function persist(mode: TodoMode): void {
  try {
    const dir = todosDirPath();
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(todoFilePath(mode), JSON.stringify(stores[mode].current, null, 2), "utf8");
  } catch (e) {
    console.warn(`[TodoStore] persist ${mode} failed:`, e);
  }
}

/** 启动时调一次，从磁盘恢复各模式未完成任务。 */
export function loadTodos(): void {
  // 兼容旧版：把 single-file 数据迁移到 work 模式
  try {
    const legacy = legacyTodoFilePath();
    if (fs.existsSync(legacy)) {
      const raw = fs.readFileSync(legacy, "utf8");
      const parsed = JSON.parse(raw) as TodoState;
      if (parsed && Array.isArray(parsed.todos)) {
        stores.work.current = { ...parsed, mode: "work" };
        persist("work");
      }
      try {
        fs.renameSync(legacy, `${legacy}.migrated`);
      } catch {
        // ignore
      }
    }
  } catch (e) {
    console.warn("[TodoStore] legacy migration failed:", e);
  }

  for (const mode of TODO_MODES) {
    if (stores[mode].loaded) continue;
    stores[mode].loaded = true;
    try {
      const raw = fs.readFileSync(todoFilePath(mode), "utf8");
      const parsed = JSON.parse(raw) as TodoState;
      if (parsed && Array.isArray(parsed.todos)) {
        stores[mode].current = { ...parsed, mode };
        logger.info(LogTag.TodoStore, `${mode} restored ${parsed.todos.length} incomplete tasks`);
      }
    } catch {
      stores[mode].current = { ...EMPTY_STATE, mode };
    }
  }
}

/** 整体覆盖写某个模式的清单（todo_write 工具调这个）。返回更新后的 state。 */
export function setTodos(mode: TodoMode, todos: TodoItem[]): TodoState {
  if (!isValidTodoMode(mode)) {
    throw new Error(`E_TODO_INVALID_MODE: ${mode}`);
  }
  // 轻量校验：丢掉字段不全的项
  const valid = todos.filter(t => t && typeof t.id === "string" && typeof t.content === "string");
  stores[mode].current = { todos: valid, updatedAt: Date.now(), mode };
  persist(mode);
  for (const l of stores[mode].listeners) {
    try { l(stores[mode].current); } catch (e) { console.warn(`[TodoStore] ${mode} listener error:`, e); }
  }
  return stores[mode].current;
}

export function getTodos(mode: TodoMode): TodoState {
  if (!isValidTodoMode(mode)) {
    return { ...EMPTY_STATE };
  }
  return stores[mode].current;
}

export function getCurrentTodos(): Record<TodoMode, TodoState> {
  return {
    work: stores.work.current,
    daily: stores.daily.current,
    learn: stores.learn.current,
  };
}

export function clearTodos(mode: TodoMode): void {
  if (!isValidTodoMode(mode)) return;
  stores[mode].current = { todos: [], updatedAt: Date.now(), mode };
  persist(mode);
  for (const l of stores[mode].listeners) {
    try { l(stores[mode].current); } catch (e) { console.warn(`[TodoStore] ${mode} listener error:`, e); }
  }
}

/** 订阅某个模式的变化。返回取消订阅函数。 */
export function onTodosChange(mode: TodoMode, cb: (s: TodoState) => void): () => void {
  if (!isValidTodoMode(mode)) return () => {};
  stores[mode].listeners.push(cb);
  return () => { stores[mode].listeners = stores[mode].listeners.filter(l => l !== cb); };
}

/** 从 ConversationMode 解析出有效的 TodoMode；非工作模式返回 undefined。 */
export function resolveTodoMode(mode: ConversationMode | undefined): TodoMode | undefined {
  if (mode === "work" || mode === "daily" || mode === "learn") return mode;
  return undefined;
}
