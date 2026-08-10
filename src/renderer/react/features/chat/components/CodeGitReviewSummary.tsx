import { useState } from "react";
import type { CodeGitReviewSnapshot } from "../../../../../shared/chat-types";
import "./CodeGitReviewSummary.css";

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
      <ul>{visible.map((file) => <li key={file.path}><button type="button" onClick={() => onOpen(file.path)}><span>{file.path}</span><b>›</b></button></li>)}</ul>
      {snapshot.files.length > 3 && <button type="button" className="cy-git-review-summary__more" onClick={() => setExpanded((value) => !value)}>{expanded ? "收起" : `再显示 ${snapshot.files.length - 3} 个文件`}⌄</button>}
    </section>
  );
}
