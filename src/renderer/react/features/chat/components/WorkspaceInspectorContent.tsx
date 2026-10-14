import { useEffect, useState } from "react";
import { ChevronRight, File, Folder, RefreshCw } from "lucide-react";
import type { WorkspaceEntry, WorkspaceFileView } from "../../../../../shared/workspace-inspector";
import type { TaskSession } from "../../../../../shared/task-session";
import { chatStore } from "../pages/chat-page-bridge";
import { useTranslation } from "../../../i18n";
import "./WorkspaceInspectorContent.css";

function Directory({ sessionId, directory, onOpen }: { sessionId: string; directory: string; onOpen: (file: string) => void }) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<WorkspaceEntry[]>([]);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let disposed = false;
    setBusy(true);
    void chatStore()?.listFiles(sessionId, directory).then((result) => {
      if (disposed) return;
      if (!result.ok) throw new Error(result.error);
      setEntries(result.value.entries); setHasMore(result.value.hasMore); setError("");
    }).catch((error) => { if (!disposed) setError(String(error)); }).finally(() => { if (!disposed) setBusy(false); });
    return () => { disposed = true; };
  }, [sessionId, directory]);
  async function more() {
    setBusy(true);
    try {
      const result = await chatStore()?.listFiles(sessionId, directory, entries.length);
      if (!result?.ok) throw new Error(result?.error ?? "文件接口不可用");
      setEntries((current) => [...current, ...result.value.entries]); setHasMore(result.value.hasMore); setError("");
    } catch (error) { setError(String(error)); } finally { setBusy(false); }
  }
  return <ul className="cy-file-tree" role="group">
    {error && <li role="alert">{error}<button type="button" onClick={() => void more()}>{t("common.retry")}</button></li>}
    {!busy && !error && !entries.length && <li>{t("common.empty")}</li>}
    {entries.map((entry) => <li key={entry.path}>
      <button type="button" title={entry.path} aria-expanded={entry.directory ? expanded.includes(entry.path) : undefined} onClick={() => {
        if (entry.directory) setExpanded((current) => current.includes(entry.path) ? current.filter((item) => item !== entry.path) : [...current, entry.path]);
        else onOpen(entry.path);
      }}>
        {entry.directory ? <><ChevronRight size={13} className={expanded.includes(entry.path) ? "is-open" : ""} /><Folder size={15} /></> : <File size={15} />}{entry.name}
      </button>
      {entry.directory && expanded.includes(entry.path) && <Directory sessionId={sessionId} directory={entry.path} onOpen={onOpen} />}
    </li>)}
    {busy && <li role="status">{t("common.loading")}</li>}
    {hasMore && <li><button type="button" disabled={busy} onClick={() => void more()}>{t("workspaceUi.moreFiles")}</button></li>}
  </ul>;
}

export function FileTreeContent({ sessionId, workspaceRoot, onOpen }: { sessionId: string; workspaceRoot?: string; onOpen: (file: string) => void }) {
  const { t } = useTranslation();
  const [revision, setRevision] = useState(0);
  return <div className="cy-inspector-content">
    <div className="cy-inspector-toolbar"><span title={workspaceRoot}>{workspaceRoot || t("workspaceUi.chooseWorkspace")}</span>
      <button type="button" aria-label={t("workspaceUi.refresh")} onClick={() => setRevision((current) => current + 1)}><RefreshCw size={15} /></button></div>
    {workspaceRoot && <Directory key={`${sessionId}:${workspaceRoot}:${revision}`} sessionId={sessionId} directory="" onOpen={onOpen} />}
  </div>;
}

export function FilePreviewContent({ sessionId, file }: { sessionId: string; file: string }) {
  const { t } = useTranslation();
  const [value, setValue] = useState<WorkspaceFileView | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let disposed = false;
    setValue(null); setError("");
    void chatStore()?.readFile(sessionId, file).then((result) => {
      if (disposed) return;
      if (!result.ok) throw new Error(result.error);
      setValue(result.value);
    }).catch((error) => { if (!disposed) setError(String(error)); });
    return () => { disposed = true; };
  }, [sessionId, file, revision]);
  return <div className="cy-inspector-content"><div className="cy-inspector-toolbar"><span>{file}</span>
    <button type="button" aria-label={t("workspaceUi.refresh")} onClick={() => setRevision((current) => current + 1)}><RefreshCw size={15} /></button></div>
    {error ? <p role="alert">{error}</p> : !value ? <p role="status">{t("common.loading")}</p>
      : value.kind === "image" ? <img className="cy-file-preview-image" src={value.dataUrl} alt={file} /> : <pre className="cy-file-preview-text">{value.content}</pre>}
  </div>;
}

export function TaskSessionContent({ sessionId, taskId }: { sessionId: string; taskId: string }) {
  const { t } = useTranslation();
  const [task, setTask] = useState<TaskSession | null>(null);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let disposed = false;
    async function load() {
      try {
        const result = await chatStore()?.getTask(sessionId, taskId);
        if (disposed) return;
        if (!result?.ok) throw new Error(result?.error ?? "任务接口不可用");
        setTask(result.value); setError("");
      } catch (error) { if (!disposed) setError(String(error)); }
    }
    void load();
    const timer = task?.status === "running" ? window.setInterval(() => void load(), 3000) : undefined;
    return () => { disposed = true; window.clearInterval(timer); };
  }, [sessionId, taskId, revision, task?.status]);
  return <div className="cy-inspector-content">
    <div className="cy-inspector-toolbar"><strong>{task?.description || t("workspaceUi.tasks")}</strong><button type="button" aria-label={t("workspaceUi.refresh")} onClick={() => setRevision((current) => current + 1)}><RefreshCw size={15} /></button></div>
    {error && <p role="alert">{error}</p>}
    {!task && !error && <p role="status">{t("common.loading")}</p>}
    {task && <><p>{t(`workspaceUi.taskStatus.${task.status}`)}</p>
      {!!task.todoItems.length && <ul>{task.todoItems.map((item) => <li key={item.id}>{item.status === "completed" ? "✓" : "○"} {item.content}</li>)}</ul>}
      {task.error && <p role="alert">{task.error.message}</p>}
      {task.messages.map((message, index) => <section key={index} className="cy-task-transcript"><strong>{message.role}</strong><pre>{message.content}</pre>
        {!!message.toolCalls?.length && <details><summary>{t("workspaceUi.toolCalls")}</summary><pre>{JSON.stringify(message.toolCalls, null, 2)}</pre></details>}</section>)}
      {!!task.trace.length && <details><summary>{t("workspaceUi.taskTrace")}</summary>{task.trace.map((entry) => <pre key={entry.id}>{entry.label || entry.kind} {entry.status} {entry.content}</pre>)}</details>}
    </>}
  </div>;
}
