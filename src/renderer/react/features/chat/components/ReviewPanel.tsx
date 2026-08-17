// ReviewPanel — 气泡内的 Review 文件列表。
//
// 职责：显示文件变更列表（kind 徽标 + 路径 + 增删统计）。
// 点击某个文件 → 调用 onOpenInspector(runId, fileIndex) 打开右侧纯 diff 面板。

import { useEffect, useMemo, useState } from "react";
import type { ReviewFileChange, ReviewSnapshot } from "../../../../../shared/review-types";
import "./ReviewPanel.css";

const KIND_LABEL: Record<ReviewFileChange["kind"], string> = {
  modified: "修改",
  created: "新增",
  deleted: "删除",
  renamed: "重命名",
  binary: "二进制",
  "large-text": "大文件",
};

const KIND_CLASS: Record<ReviewFileChange["kind"], string> = {
  modified: "is-modified",
  created: "is-created",
  deleted: "is-deleted",
  renamed: "is-renamed",
  binary: "is-binary",
  "large-text": "is-large",
};

function splitPath(filePath: string): { dir: string; base: string } {
  const lastSlash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  if (lastSlash < 0) return { dir: "", base: filePath };
  return { dir: filePath.slice(0, lastSlash + 1), base: filePath.slice(lastSlash + 1) };
}

export function ReviewPanel({
  runId,
  onOpenInspector,
}: {
  runId: string;
  onOpenInspector?: (runId: string, fileIndex: number) => void;
}) {
  const [snapshot, setSnapshot] = useState<ReviewSnapshot | null>(null);

  useEffect(() => {
    let cancelled = false;
    let retryCount = 0;
    const MAX_RETRIES = 3;
    const RETRY_DELAY = 500;

    const fetchData = async () => {
      if (cancelled) return;
      try {
        const result = await window.review?.get(runId);
        if (cancelled) return;
        if (result && result.files.length > 0) {
          setSnapshot(result);
          return;
        }
      } catch {
        // 忽略，进入重试
      }
      retryCount++;
      if (retryCount < MAX_RETRIES && !cancelled) {
        setTimeout(() => void fetchData(), RETRY_DELAY);
      }
    };

    void fetchData();
    return () => { cancelled = true; };
  }, [runId]);

  const totalAdd = useMemo(
    () => snapshot?.files.reduce((sum, f) => sum + f.additions, 0) ?? 0,
    [snapshot],
  );
  const totalDel = useMemo(
    () => snapshot?.files.reduce((sum, f) => sum + f.deletions, 0) ?? 0,
  );

  if (!snapshot) return null;

  return (
    <section className="cy-review-panel" aria-label="文件变更审查">
      <div className="cy-review-panel__summary">
        <span className="cy-review-panel__summary-title">
          {snapshot.files.length} 个文件已更改
        </span>
        <span className="cy-review-panel__summary-stats">
          <span className="is-add">+{totalAdd}</span>
          <span className="is-remove">−{totalDel}</span>
        </span>
      </div>
      <div className="cy-review-panel__list">
        {snapshot.files.map((file, index) => {
          const { dir, base } = splitPath(file.newPath);
          return (
            <button
              key={`${file.kind}:${file.oldPath}:${file.newPath}:${index}`}
              type="button"
              className="cy-review-panel__file-item"
              onClick={() => onOpenInspector?.(runId, index)}
              title={file.newPath}
            >
              <span className={`cy-review-panel__kind ${KIND_CLASS[file.kind]}`}>
                {KIND_LABEL[file.kind]}
              </span>
              <span className="cy-review-panel__file-path">
                {dir && <span className="cy-review-panel__dir">{dir}</span>}
                <span className="cy-review-panel__base">{base}</span>
              </span>
              <span className="cy-review-panel__file-stats">
                {file.additions > 0 && <span className="is-add">+{file.additions}</span>}
                {file.deletions > 0 && <span className="is-remove">−{file.deletions}</span>}
              </span>
              <svg className="cy-review-panel__arrow" viewBox="0 0 16 16" aria-hidden="true">
                <path d="m6 4 4 4-4 4" fill="none" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.75" />
              </svg>
            </button>
          );
        })}
      </div>
    </section>
  );
}
