import { useState } from "react";
import type { CodeGitReviewSnapshot } from "../../../../../shared/chat-types";
import "./CodeGitReviewSummary.css";

export function splitCodeReviewPath(path: string): { directory: string; filename: string } {
  const normalized = path.replace(/\\/g, "/");
  const lastSlash = normalized.lastIndexOf("/");
  return lastSlash < 0
    ? { directory: "", filename: normalized }
    : { directory: normalized.slice(0, lastSlash), filename: normalized.slice(lastSlash + 1) };
}

export function CodeGitReviewSummary({ snapshot, onOpen }: { snapshot: CodeGitReviewSnapshot; onOpen(path: string): void }) {
  const [expanded, setExpanded] = useState(false);
  const visible = expanded ? snapshot.files : snapshot.files.slice(0, 3);
  return (
    <section className="cy-git-review-summary" aria-label="本轮代码变更">
      <header>
        <span className="cy-git-review-summary__icon" aria-hidden="true">▣</span>
        <div><strong>已编辑 {snapshot.files.length} 个文件</strong><small><b>+{snapshot.insertions}</b> <i>-{snapshot.deletions}</i></small></div>
        <button type="button" className="cy-git-review-summary__review" onClick={() => onOpen(snapshot.files[0].path)}>审阅</button>
      </header>
      <ul>{visible.map((file) => {
        const display = splitCodeReviewPath(file.path);
        return <li key={file.path}>
          <button type="button" onClick={() => onOpen(file.path)}>
            <span className="cy-git-review-summary__path">
              {display.directory && <small>{display.directory}/</small>}
              <strong>{display.filename}</strong>
            </span>
            <span className="cy-git-review-summary__file-stats" aria-label={`${file.insertions} 行新增，${file.deletions} 行删除`}>
              <b>+{file.insertions}</b><i>-{file.deletions}</i><em>›</em>
            </span>
          </button>
        </li>;
      })}</ul>
      {snapshot.files.length > 3 && <button type="button" className="cy-git-review-summary__more" onClick={() => setExpanded((value) => !value)}>{expanded ? "收起" : `再显示 ${snapshot.files.length - 3} 个文件`}⌄</button>}
    </section>
  );
}
