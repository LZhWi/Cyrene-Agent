import { useEffect, useState } from "react";
import { XMarkdown } from "@ant-design/x-markdown";
import { Diff, Hunk, type ViewType } from "react-diff-view";
import type { CodeGitDiffResult } from "../../../../../shared/code-git-types";
import { buildCodeDiffViewModel } from "./code-diff-view-model";
import "react-diff-view/style/index.css";
import "./CodeDiffReview.css";

interface CodeGitApi { getDiff(sessionId: string, path: string): Promise<CodeGitDiffResult> }
export interface CodeDiffReviewProps { sessionId: string; path: string | null; open: boolean; onClose(): void }

function codeGitApi(): CodeGitApi | undefined {
  return typeof window === "undefined" ? undefined : (window as Window & { codeGit?: CodeGitApi }).codeGit;
}

function Notice({ children }: { children: string }) {
  return <div className="cy-code-diff-review__notice"><XMarkdown content={children} /></div>;
}

export function CodeDiffReview({ sessionId, path, open, onClose }: CodeDiffReviewProps) {
  const [result, setResult] = useState<CodeGitDiffResult | null>(null);
  const [viewType, setViewType] = useState<ViewType>("unified");
  const api = codeGitApi();

  useEffect(() => {
    let disposed = false;
    setViewType("unified");
    setResult(null);
    if (!open || !path || !api) return () => { disposed = true; };
    void api.getDiff(sessionId, path).then((next) => { if (!disposed) setResult(next); })
      .catch(() => { if (!disposed) setResult({ kind: "error", sessionId, path, message: "无法读取这个文件的 Git 差异" }); });
    return () => { disposed = true; };
  }, [api, open, path, sessionId]);

  if (!open) return null;
  const model = result ? buildCodeDiffViewModel(result) : null;
  return (
    <aside className="cy-code-diff-review" aria-label="代码审阅">
      <header>
        <div><span>审阅</span><strong title={path ?? undefined}>{path ?? "文件变更"}</strong></div>
        <div className="cy-code-diff-review__actions">
          <div className="cy-code-diff-review__view-switch" aria-label="差异视图">
            <button type="button" className={viewType === "unified" ? "is-active" : ""} onClick={() => setViewType("unified")}>单栏</button>
            <button type="button" className={viewType === "split" ? "is-active" : ""} onClick={() => setViewType("split")}>双栏</button>
          </div>
          <button type="button" className="cy-code-diff-review__close" onClick={onClose} aria-label="关闭审阅">×</button>
        </div>
      </header>
      <div className="cy-code-diff-review__body">
        {!model && <Notice>正在读取 Git 差异…</Notice>}
        {model?.kind === "binary" && <Notice>这是二进制文件，无法显示文本差异。</Notice>}
        {model?.kind === "too_large" && <Notice>这个文件的差异超过 **2 MiB**，为保持界面流畅暂不展开。</Notice>}
        {model?.kind === "error" && <Notice>{model.message}</Notice>}
        {model?.kind === "ready" && model.files.length === 0 && <Notice>当前 Git 工作区已经没有这个文件的可显示差异；它可能已被提交或变更。</Notice>}
        {model?.kind === "ready" && model.files.map((file, index) => (
          <section key={`${file.oldPath}-${file.newPath}-${index}`} className="cy-code-diff-review__file">
            <Diff diffType={file.type} hunks={file.hunks} viewType={viewType}>{(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}</Diff>
          </section>
        ))}
      </div>
    </aside>
  );
}
