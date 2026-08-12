import { useEffect, useMemo, useState } from "react";
import { XMarkdown } from "@ant-design/x-markdown";
import { Diff, Hunk, tokenize, type FileData, type ViewType } from "react-diff-view";
import type { CodeGitDiffResult } from "../../../../../shared/code-git-types";
import type { CodeGitReviewSnapshot } from "../../../../../shared/chat-types";
import { languageForCodeDiffPath } from "./code-diff-language";
import { refractor } from "./code-diff-refractor";
import { buildCodeDiffViewModel } from "./code-diff-view-model";
import "react-diff-view/style/index.css";
import "prism-color-variables/variables.css";
import "./CodeDiffReview.css";

interface CodeGitApi { getDiff(sessionId: string, path: string): Promise<CodeGitDiffResult> }

function codeGitApi(): CodeGitApi | undefined {
  return typeof window === "undefined" ? undefined : (window as Window & { codeGit?: CodeGitApi }).codeGit;
}

function Notice({ children }: { children: string }) {
  return <div className="cy-code-diff-review__notice"><XMarkdown content={children} /></div>;
}

function HighlightedDiffFile({ file, viewType }: { file: FileData; viewType: ViewType }) {
  const language = languageForCodeDiffPath(file.newPath || file.oldPath || "");
  const tokens = useMemo(() => language === "none" ? null : tokenize(file.hunks, {
    highlight: true,
    refractor,
    language,
  }), [file.hunks, language]);

  return (
    <section className="cy-code-diff-review__file">
      <Diff diffType={file.type} hunks={file.hunks} tokens={tokens} viewType={viewType}>
        {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
      </Diff>
    </section>
  );
}

export interface CodeDiffReviewProps { sessionId: string; snapshot: CodeGitReviewSnapshot; initialPath?: string; open: boolean; onClose(): void }

export function CodeDiffReview({ sessionId, snapshot, initialPath, open, onClose }: CodeDiffReviewProps) {
  const [results, setResults] = useState<Record<string, CodeGitDiffResult>>({});
  const [viewType, setViewType] = useState<ViewType>("unified");
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(new Set());
  const api = codeGitApi();

  useEffect(() => {
    let disposed = false;
    setViewType("unified");
    setResults({});
    setCollapsedPaths(initialPath ? new Set(snapshot.files.filter((file) => file.path !== initialPath).map((file) => file.path)) : new Set());
    if (!open || !api) return () => { disposed = true; };
    void Promise.all(snapshot.files.map(async (file) => {
      try { return [file.path, await api.getDiff(sessionId, file.path)] as const; }
      catch { return [file.path, { kind: "error", sessionId, path: file.path, message: "无法读取这个文件的 Git 差异" } as CodeGitDiffResult] as const; }
    })).then((entries) => { if (!disposed) setResults(Object.fromEntries(entries)); });
    return () => { disposed = true; };
  }, [api, initialPath, open, sessionId, snapshot]);

  if (!open) return null;
  return (
    <aside className="cy-code-diff-review" aria-label="代码审阅">
      <header>
        <div><span>审阅</span><strong>{snapshot.files.length} 个文件的本轮变更</strong></div>
        <div className="cy-code-diff-review__actions">
          <div className="cy-code-diff-review__view-switch" aria-label="差异视图">
            <button type="button" className={viewType === "unified" ? "is-active" : ""} onClick={() => setViewType("unified")}>单栏</button>
            <button type="button" className={viewType === "split" ? "is-active" : ""} onClick={() => setViewType("split")}>双栏</button>
          </div>
          <button type="button" className="cy-code-diff-review__close" onClick={onClose} aria-label="关闭审阅">×</button>
        </div>
      </header>
      <div className="cy-code-diff-review__body">
        {snapshot.files.map((entry) => {
          const result = results[entry.path];
          const model = result ? buildCodeDiffViewModel(result) : null;
          const collapsed = collapsedPaths.has(entry.path);
          return <section className="cy-code-diff-review__entry" key={entry.path}>
            <button type="button" className="cy-code-diff-review__entry-header" onClick={() => setCollapsedPaths((current) => { const next = new Set(current); if (next.has(entry.path)) next.delete(entry.path); else next.add(entry.path); return next; })}>
              <span>{collapsed ? "›" : "⌄"}</span><strong>{entry.path}</strong><b>+{entry.insertions}</b><i>-{entry.deletions}</i>
            </button>
            {!collapsed && !model && <Notice>正在读取 Git 差异…</Notice>}
            {!collapsed && model?.kind === "binary" && <Notice>这是二进制文件，无法显示文本差异。</Notice>}
            {!collapsed && model?.kind === "too_large" && <Notice>这个文件的差异超过 **2 MiB**，为保持界面流畅暂不展开。</Notice>}
            {!collapsed && model?.kind === "error" && <Notice>{model.message}</Notice>}
            {!collapsed && model?.kind === "ready" && model.files.length === 0 && <Notice>当前 Git 工作区已经没有这个文件的可显示差异；它可能已被提交或变更。</Notice>}
            {!collapsed && model?.kind === "ready" && model.files.map((file, index) => <HighlightedDiffFile key={`${file.oldPath}-${file.newPath}-${index}`} file={file} viewType={viewType} />)}
          </section>;
        })}
      </div>
    </aside>
  );
}
