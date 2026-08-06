import { BrowserWindow } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { loadTodos, onTodosChange, TODO_MODES } from "../orchestrator/todo-store";

/**
 * 启动 Todo 子系统：从磁盘恢复任务并按 mode 订阅变化，
 * 通过 AGUI_EVENT 广播给所有窗口以更新进度面板。
 */
export function bootstrapTodos(): void {
  loadTodos();
  for (const mode of TODO_MODES) {
    onTodosChange(mode, (state) => {
      for (const win of BrowserWindow.getAllWindows()) {
        if (win.isDestroyed()) continue;
        try {
          win.webContents.send(IPC.AGUI_EVENT, {
            type: "CUSTOM",
            name: "cyrene.todos",
            value: state,
          });
        } catch (e) {
          console.warn("[Cyrene] todos 广播失败:", e);
        }
      }
    });
  }
}
