import { useCallback, useEffect, useMemo, useState } from "react";
import type { CodeGitChangedPayload, CodeGitStatus } from "../../../../../shared/code-git-types";
import workingPngUrl from "../../../assets/status-moods/工作中.png?url";
import { buildGitActionIntent, buildGitStatusCopy, changeKindLabel } from "./code-git-presentation";
import "./CodeGitPanel.css";

interface CodeGitApi {
  getStatus(sessionId: string): Promise<CodeGitStatus>;
  onChanged(callback: (payload: CodeGitChangedPayload) => void): () => void;
}

export interface CodeGitPanelProps {
  sessionId: string;
  onOpenDiff(path: string): void;
  onRequestAgentAction(prompt: string): void;
}

function codeGitApi(): CodeGitApi | undefined {
  return (window as Window & { codeGit?: CodeGitApi }).codeGit;
}

export function CodeGitPanel({
  sessionId,
  onOpenDiff,
  onRequestAgentAction,
}: CodeGitPanelProps) {
  const [status, setStatus] = useState<CodeGitStatus | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const api = codeGitApi();

  const refresh = useCallback(async () => {
    if (!api) return;
    setRefreshing(true);
    try {
      setStatus(await api.getStatus(sessionId));
    } finally {
      setRefreshing(false);
    }
  }, [api, sessionId]);

  useEffect(() => {
    let disposed = false;
    if (!api) return undefined;
    void api.getStatus(sessionId).then((next) => {
      if (!disposed) setStatus(next);
    }).catch(() => {
      if (!disposed) setStatus(null);
    });
    return () => {
      disposed = true;
    };
  }, [api, sessionId]);

  useEffect(() => {
    if (!api) return undefined;
    return api.onChanged((payload) => {
      if (payload.sessionId === sessionId) void refresh();
    });
  }, [api, refresh, sessionId]);

  const action = useMemo(() => status ? buildGitActionIntent(status) : null, [status]);
  const statusCopy = status ? buildGitStatusCopy(status) : "正在读取 Git 状态…";
  const files = status?.state === "ready" ? status.files : [];
  const branchName = status?.branch?.current ?? (status?.branch?.detached ? "detached HEAD" : "暂无分支");

  return (
    <aside className="cy-code-git" aria-label="Code Git 工作台">
      <div className="cy-code-git__dragline" aria-hidden="true" />
      <div className="cy-code-git__hero">
        <img className="cy-code-git__mascot" src={workingPngUrl} alt="" aria-hidden="true" />
        <div>
          <span className="cy-code-git__mode"><i aria-hidden="true" />代码</span>
          <h2>项目状态</h2>
          <p>{statusCopy}</p>
        </div>
        <button
          className="cy-code-git__refresh"
          type="button"
          onClick={() => void refresh()}
          disabled={!api || refreshing}
          aria-label="刷新 Git 状态"
          title="刷新 Git 状态"
        >
          ↻
        </button>
      </div>

      <section className="cy-code-git__section cy-code-git__changes" aria-label="变更">
        <div className="cy-code-git__section-title">
          <span>变更</span>
          <span className="cy-code-git__count">{files.length}</span>
        </div>
        {status?.state === "ready" && files.length === 0 && (
          <p className="cy-code-git__empty">工作区干净</p>
        )}
        <ul className="cy-code-git__files">
          {files.map((file) => (
            <li key={file.path}>
              <button type="button" onClick={() => onOpenDiff(file.path)} title={`审阅 ${file.path}`}>
                <span className={`cy-code-git__file-kind cy-code-git__file-kind--${file.kind}`}>
                  {changeKindLabel(file.kind)}
                </span>
                <span className="cy-code-git__file-path">{file.path}</span>
              </button>
            </li>
          ))}
        </ul>
      </section>

      <section className="cy-code-git__section" aria-label="分支">
        <div className="cy-code-git__section-title"><span>分支</span></div>
        <button
          type="button"
          className="cy-code-git__branch"
          disabled={status?.state !== "ready"}
          onClick={() => onRequestAgentAction("请告诉我当前有哪些 Git 分支，并帮我切换到我指定的分支。")}
        >
          <span>⑂ {branchName}</span>
          <span aria-hidden="true">›</span>
        </button>
      </section>

      <footer className="cy-code-git__footer">
        <div className="cy-code-git__sync">
          <span>↑ {status?.ahead ?? 0}</span>
          <span>↓ {status?.behind ?? 0}</span>
        </div>
        {action && (
          <button type="button" className="cy-code-git__action" onClick={() => onRequestAgentAction(action.prompt)}>
            {action.label}
          </button>
        )}
      </footer>
    </aside>
  );
}
