import { useEffect, useMemo, useRef, useState } from "react";
import type { CodeGitChangedPayload, CodeGitStatus } from "../../../../../shared/code-git-types";
import type { TodoState } from "../../../../../shared/todo-types";
import workingPngUrl from "../../../assets/status-moods/工作中.png?url";
import { buildGitStatusCopy } from "./code-git-presentation";
import { useFloatingCard } from "./floating-card";
import { createCodeGitRefreshController, type CodeGitRefreshController } from "./code-git-refresh";
import "./CodeGitPanel.css";

interface CodeGitApi {
  getStatus(sessionId: string): Promise<CodeGitStatus>;
  watch(sessionId: string): Promise<void>;
  unwatch(sessionId: string): Promise<void>;
  switchBranch(sessionId: string, branch: string, create?: boolean): Promise<void>;
  commit(sessionId: string, message: string, paths: string[]): Promise<void>;
  push(sessionId: string): Promise<void>;
  onChanged(callback: (payload: CodeGitChangedPayload) => void): () => void;
}

export interface CodeGitPanelProps {
  sessionId: string;
  projectName?: string;
  todoState: TodoState | null;
}

function codeGitApi(): CodeGitApi | undefined {
  return typeof window === "undefined" ? undefined : (window as Window & { codeGit?: CodeGitApi }).codeGit;
}

function ToggleIcon() {
  return <svg width="16" height="16" viewBox="0 0 48 48" fill="none" aria-hidden="true"><path d="M27 9V21H39M21 39V27H9M27 21L42 6M21 27L6 42" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}

export function CodeGitPanel({ sessionId, projectName, todoState }: CodeGitPanelProps) {
  const [status, setStatus] = useState<CodeGitStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [commitOpen, setCommitOpen] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [operationError, setOperationError] = useState<string | null>(null);
  const [operating, setOperating] = useState(false);
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

  const todos = todoState?.todos ?? [];
  const completed = todos.filter((todo) => todo.status === "completed").length;
  const branchName = status?.branch?.current ?? (status?.branch?.detached ? "detached HEAD" : "暂无分支");
  const statusCopy = status ? buildGitStatusCopy(status) : "正在读取 Git 状态…";
  const runOperation = async (action: () => Promise<void>) => {
    setOperating(true);
    setOperationError(null);
    try {
      await action();
      refreshControllerRef.current?.request();
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "Git 操作失败");
    } finally {
      setOperating(false);
    }
  };

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
          <button type="button" disabled={status?.state !== "ready"} onClick={() => { setBranchOpen((value) => !value); setCommitOpen(false); }}>
            <span>分支切换</span><code>{branchName}</code><b>›</b>
          </button>
          {branchOpen && status?.branch && <div className="cy-code-git__popover">
            {status.branch.branches.map((branch) => <button key={branch} type="button" disabled={branch === status.branch?.current || operating} onClick={() => void runOperation(async () => { await api?.switchBranch(sessionId, branch); setBranchOpen(false); })}>{branch === status.branch?.current ? "✓ " : ""}{branch}</button>)}
            <button type="button" disabled={operating} onClick={() => {
              const branch = window.prompt("新分支名称");
              if (branch?.trim()) void runOperation(async () => { await api?.switchBranch(sessionId, branch.trim(), true); setBranchOpen(false); });
            }}>＋ 新建并切换分支</button>
          </div>}
          <div className="cy-code-git__change-row">
            <span>变更</span>
            <span className="cy-code-git__added">+{status?.lines.insertions ?? 0}</span>
            <span className="cy-code-git__deleted">-{status?.lines.deletions ?? 0}</span>
          </div>
          <button type="button" disabled={status?.state !== "ready" || (status.files.length === 0 && status.ahead === 0)} onClick={() => { setCommitOpen((value) => !value); setBranchOpen(false); }}>
            <span>提交或推送</span><code>{status?.files.length ? "提交变更" : status?.ahead ? `推送 ${status.ahead} 个提交` : "暂无操作"}</code><b>›</b>
          </button>
          {commitOpen && <div className="cy-code-git__popover cy-code-git__commit-popover">
            {status?.files.length ? <>
              <input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="提交说明" disabled={operating} />
              <button type="button" disabled={!commitMessage.trim() || operating} onClick={() => void runOperation(async () => { await api?.commit(sessionId, commitMessage, status.files.map((file) => file.path)); setCommitMessage(""); setCommitOpen(false); })}>提交全部 {status.files.length} 个变更</button>
            </> : null}
            {status?.ahead ? <button type="button" disabled={operating} onClick={() => void runOperation(async () => { await api?.push(sessionId); setCommitOpen(false); })}>推送 {status.ahead} 个提交</button> : null}
          </div>}
          {operationError && <p className="cy-code-git__operation-error">{operationError}</p>}
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
