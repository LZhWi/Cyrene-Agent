import { useEffect, useMemo, useRef, useState } from "react";
import type { CodeGitChangedPayload, CodeGitStatus } from "../../../../../shared/code-git-types";
import type { TodoState } from "../../../../../shared/todo-types";
import workingPngUrl from "../../../assets/status-moods/工作中.png?url";
import { buildGitActionIntent, buildGitStatusCopy } from "./code-git-presentation";
import { useFloatingCard } from "./floating-card";
import { createCodeGitRefreshController, type CodeGitRefreshController } from "./code-git-refresh";
import "./CodeGitPanel.css";

interface CodeGitApi {
  getStatus(sessionId: string): Promise<CodeGitStatus>;
  watch(sessionId: string): Promise<void>;
  unwatch(sessionId: string): Promise<void>;
  onChanged(callback: (payload: CodeGitChangedPayload) => void): () => void;
}

export interface CodeGitPanelProps {
  sessionId: string;
  projectName?: string;
  todoState: TodoState | null;
  onRequestAgentAction(prompt: string): void;
}

function codeGitApi(): CodeGitApi | undefined {
  return typeof window === "undefined" ? undefined : (window as Window & { codeGit?: CodeGitApi }).codeGit;
}

function ToggleIcon() {
  return <svg width="16" height="16" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M27 9V21H39M21 39V27H9M27 21L42 6M21 27L6 42" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export function CodeGitPanel({ sessionId, projectName, todoState, onRequestAgentAction }: CodeGitPanelProps) {
  const [status, setStatus] = useState<CodeGitStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const refreshControllerRef = useRef<CodeGitRefreshController | null>(null);
  const api = codeGitApi();
  const floating = useFloatingCard({ width: 260 });

  useEffect(() => {
    if (!api) return undefined;
    const controller = createCodeGitRefreshController({
      load: () => api.getStatus(sessionId),
      apply: setStatus,
      failed: () => setStatus(null),
      busy: setRefreshing,
    });
    refreshControllerRef.current = controller;
    void api.watch(sessionId).catch(() => undefined);
    controller.request();
    return () => {
      controller.dispose();
      if (refreshControllerRef.current === controller) refreshControllerRef.current = null;
      void api.unwatch(sessionId).catch(() => undefined);
    };
  }, [api, sessionId]);

  useEffect(() => api?.onChanged((payload) => {
    if (payload.sessionId === sessionId) refreshControllerRef.current?.request();
  }), [api, sessionId]);

  const action = useMemo(() => status ? buildGitActionIntent(status) : null, [status]);
  const todos = todoState?.todos ?? [];
  const completed = todos.filter((todo) => todo.status === "completed").length;
  const branchName = status?.branch?.current ?? (status?.branch?.detached ? "detached HEAD" : "暂无分支");
  const statusCopy = status ? buildGitStatusCopy(status) : "正在读取 Git 状态…";

  return (
    <aside
      className={`cy-code-git ${floating.collapsed ? "cy-code-git--collapsed" : ""}`}
      style={{ left: floating.position.x, top: floating.position.y }}
      aria-label="Code 项目与任务"
    >
      <button type="button" className="cy-code-git__dragbar" onMouseDown={floating.onHeaderMouseDown} onClick={floating.onHeaderClick} aria-expanded={!floating.collapsed} title="拖动">
        <span className="cy-code-git__dragline" />
        <span className="cy-code-git__toggle" data-floating-toggle onClick={(event) => { event.stopPropagation(); floating.toggle(); }}><ToggleIcon /></span>
      </button>

      <div className="cy-code-git__body">
        <div className="cy-code-git__mode"><i aria-hidden="true" />模式：Code</div>
        <div className="cy-code-git__hero">
          <img className="cy-code-git__mascot" src={workingPngUrl} alt="工作中" />
          <div className="cy-code-git__project">
            <strong>{projectName ?? "尚未绑定 Git 工作区"}</strong>
            <span title={statusCopy}>{statusCopy}</span>
          </div>
          <button className="cy-code-git__refresh" type="button" onClick={() => refreshControllerRef.current?.request()} disabled={!api || refreshing} aria-label="刷新 Git 状态">↻</button>
        </div>

        <div className="cy-code-git__git-actions">
          <button type="button" disabled={status?.state !== "ready"} onClick={() => onRequestAgentAction("请告诉我当前有哪些 Git 分支，并帮我切换到我指定的分支。")}>
            <span>分支切换</span><code>{branchName}</code><b>›</b>
          </button>
          <div className="cy-code-git__change-row">
            <span>变更</span>
            <span className="cy-code-git__added">+{status?.lines.insertions ?? 0}</span>
            <span className="cy-code-git__deleted">-{status?.lines.deletions ?? 0}</span>
          </div>
          <button type="button" disabled={!action} onClick={() => action && onRequestAgentAction(action.prompt)}>
            <span>提交或推送</span><code>{action?.label ?? "暂无操作"}</code><b>›</b>
          </button>
        </div>

        <div className="cy-code-git__divider" />
        <div className="cy-code-git__todo-heading"><span>当前任务</span><small>{completed}/{todos.length} 已完成</small></div>
        <ul className="cy-code-git__todos" data-testid="code-todo-list">
          {todos.length === 0 ? <li className="is-empty"><i />暂无任务</li> : todos.map((todo) => (
            <li key={todo.id} className={todo.status === "completed" ? "is-completed" : ""}>
              <i /> <span>{todo.content}</span>
            </li>
          ))}
        </ul>
      </div>
    </aside>
  );
}
