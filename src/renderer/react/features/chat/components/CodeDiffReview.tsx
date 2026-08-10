import { useEffect, useState } from "react";
import { Drawer } from "antd";
import { Diff, Hunk, type ViewType } from "react-diff-view";
import type { CodeGitDiffResult } from "../../../../../shared/code-git-types";
import { buildCodeDiffViewModel } from "./code-diff-view-model";
import "react-diff-view/style/index.css";
import "./CodeDiffReview.css";

interface CodeGitApi {
  getDiff(sessionId: string, path: string): Promise<CodeGitDiffResult>;
}

export interface CodeDiffReviewProps {
  sessionId: string;
  path: string | null;
  open: boolean;
  onClose(): void;
}

function codeGitApi(): CodeGitApi | undefined {
  return (window as Window & { codeGit?: CodeGitApi }).codeGit;
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
    void api.getDiff(sessionId, path).then((next) => {
      if (!disposed) setResult(next);
    }).catch(() => {
      if (!disposed) setResult({ kind: "error", sessionId, path, message: "无法读取这个文件的 Git 差异" });
    });
    return () => { disposed = true; };
  }, [api, open, path, sessionId]);

  const model = result ? buildCodeDiffViewModel(result) : null;

  return (
    <Drawer
      className="cy-code-diff-review"
      title={path ?? "文件审阅"}
      placement="right"
      width={900}
      open={open}
      onClose={onClose}
      extra={(
        <div className="cy-code-diff-review__view-switch" aria-label="差异视图">
          <button type="button" className={viewType === "unified" ? "is-active" : ""} onClick={() => setViewType("unified")}>单栏</button>
          <button type="button" className={viewType === "split" ? "is-active" : ""} onClick={() => setViewType("split")}>双栏</button>
        </div>
      )}
    >
      {!model && <p className="cy-code-diff-review__notice">正在读取 Git 差异…</p>}
      {model?.kind === "binary" && <p className="cy-code-diff-review__notice">这是二进制文件，无法显示文本差异。</p>}
      {model?.kind === "too_large" && <p className="cy-code-diff-review__notice">这个文件的差异超过 2 MiB，为保持界面流畅暂不展开。</p>}
      {model?.kind === "error" && <p className="cy-code-diff-review__notice">{model.message}</p>}
      {model?.kind === "ready" && model.files.length === 0 && <p className="cy-code-diff-review__notice">Git 没有返回可显示的文本差异。</p>}
      {model?.kind === "ready" && model.files.map((file, index) => (
        <section key={`${file.oldPath}-${file.newPath}-${index}`} className="cy-code-diff-review__file">
          <Diff diffType={file.type} hunks={file.hunks} viewType={viewType}>
            {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
          </Diff>
        </section>
      ))}
    </Drawer>
  );
}
