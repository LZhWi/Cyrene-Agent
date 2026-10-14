import { useCallback, useEffect, useMemo, useState } from "react";
import { Button, Card, Empty, Input, InputNumber, Modal, Select, Space, Switch, Tag, message } from "antd";
import { CalendarClock, Clock3, History, Pencil, Play, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { ScheduleConfig, ScheduledTask, ScheduledTaskHistoryEntry, SchedulerApi, SchedulerToolInfo } from "../../../settings/scheduler/types";
import "./ScheduledTasksPanel.css";

type Draft = {
  title: string;
  prompt: string;
  mode: "work" | "code";
  enabled: boolean;
  kind: ScheduleConfig["kind"];
  runAt: string;
  timeOfDay: string;
  dayOfWeek: number;
  every: number;
  unit: "minutes" | "hours";
  allowedToolIds: string[];
  limitTools: boolean;
};

const emptyDraft = (): Draft => ({
  title: "", prompt: "", mode: "work", enabled: true, kind: "daily", runAt: "", timeOfDay: "08:00",
  dayOfWeek: 1, every: 1, unit: "hours", allowedToolIds: [], limitTools: false,
});

function fromTask(task: ScheduledTask): Draft {
  const draft = { ...emptyDraft(), title: task.title, prompt: task.prompt, enabled: task.enabled,
    mode: task.mode === "code" ? "code" as const : "work" as const,
    kind: task.schedule.kind, allowedToolIds: task.allowedToolIds ?? [], limitTools: task.toolMode === "allow-list" };
  switch (task.schedule.kind) {
    case "once": return { ...draft, runAt: new Date(new Date(task.schedule.runAt).getTime() - new Date(task.schedule.runAt).getTimezoneOffset() * 60_000).toISOString().slice(0, 16) };
    case "daily": return { ...draft, timeOfDay: task.schedule.timeOfDay };
    case "weekly": return { ...draft, timeOfDay: task.schedule.timeOfDay, dayOfWeek: task.schedule.dayOfWeek };
    case "interval": return { ...draft, every: task.schedule.every, unit: task.schedule.unit };
  }
}

export function scheduleFromDraft(draft: Draft): ScheduleConfig {
  if (draft.kind === "once") {
    const date = new Date(draft.runAt);
    if (!draft.runAt || !Number.isFinite(date.getTime()) || date.getTime() <= Date.now()) throw new Error("运行时间必须晚于现在");
    return { kind: "once", runAt: date.toISOString() };
  }
  if (draft.kind === "interval") {
    if (!Number.isInteger(draft.every) || draft.every < 1 || draft.every > (draft.unit === "minutes" ? 1440 : 168)) throw new Error("间隔超出允许范围");
    return { kind: "interval", every: draft.every, unit: draft.unit };
  }
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(draft.timeOfDay)) throw new Error("时间格式必须是 HH:mm");
  if (draft.kind === "weekly") return { kind: "weekly", dayOfWeek: draft.dayOfWeek as 0 | 1 | 2 | 3 | 4 | 5 | 6, timeOfDay: draft.timeOfDay };
  return { kind: "daily", timeOfDay: draft.timeOfDay };
}

function describeSchedule(schedule: ScheduleConfig): string {
  switch (schedule.kind) {
    case "once": return new Date(schedule.runAt).toLocaleString();
    case "daily": return `每天 ${schedule.timeOfDay}`;
    case "weekly": return `每周${"日一二三四五六"[schedule.dayOfWeek]} ${schedule.timeOfDay}`;
    case "interval": return `每 ${schedule.every} ${schedule.unit === "hours" ? "小时" : "分钟"}`;
  }
}

function scheduler(): (SchedulerApi & { onChanged?: (callback: () => void) => () => void }) | undefined {
  return (window as typeof window & { cyreneScheduler?: SchedulerApi }).cyreneScheduler;
}

export function ScheduledTasksPanel() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [tools, setTools] = useState<SchedulerToolInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [editing, setEditing] = useState<ScheduledTask | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [historyTask, setHistoryTask] = useState<ScheduledTask | null>(null);
  const [history, setHistory] = useState<ScheduledTaskHistoryEntry[]>([]);

  const refresh = useCallback(async () => {
    const api = scheduler();
    if (!api) { setLoading(false); return; }
    try {
      const [taskResult, toolResult] = await Promise.all([api.list(), api.getTools()]);
      if (!taskResult.ok) throw new Error(taskResult.error || "读取定时任务失败");
      setTasks(taskResult.value ?? []);
      if (toolResult.ok) setTools(toolResult.value ?? []);
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    return scheduler()?.onChanged?.(() => void refresh());
  }, [refresh]);

  const sortedTasks = useMemo(() => [...tasks].sort((a, b) => {
    if (a.enabled !== b.enabled) return a.enabled ? -1 : 1;
    return (a.nextFireAt ?? "￿").localeCompare(b.nextFireAt ?? "￿");
  }), [tasks]);

  async function mutate(id: string, action: () => Promise<{ ok: boolean; error?: string; reason?: string }>) {
    setBusyId(id);
    try {
      const result = await action();
      if (!result.ok) throw new Error(result.error || result.reason || "操作失败");
      await refresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(null);
    }
  }

  async function saveDraft() {
    if (!draft || !scheduler()) return;
    try {
      if (!draft.title.trim() || !draft.prompt.trim()) throw new Error("请填写标题和任务内容");
      const input = { title: draft.title.trim(), prompt: draft.prompt.trim(), enabled: draft.enabled,
        mode: draft.mode,
        schedule: scheduleFromDraft(draft), toolMode: draft.limitTools ? "allow-list" : "all-enabled",
        allowedToolIds: draft.limitTools ? draft.allowedToolIds : [] };
      setBusyId(editing?.id ?? "new");
      const result = editing ? await scheduler()!.update(editing.id, input) : await scheduler()!.add(input);
      if (!result.ok) throw new Error(result.error || "保存失败");
      setDraft(null);
      setEditing(null);
      await refresh();
    } catch (error) {
      message.error(error instanceof Error ? error.message : String(error));
    } finally {
      setBusyId(null);
    }
  }

  async function showHistory(task: ScheduledTask) {
    setHistoryTask(task);
    const result = await scheduler()?.getHistory(task.id, 30);
    if (result?.ok) setHistory(result.value ?? []);
    else message.error(result?.error || "读取运行记录失败");
  }

  function update(patch: Partial<Draft>) {
    setDraft((current) => current ? { ...current, ...patch } : current);
  }

  return <div className="cy-scheduled-page">
    <header className="cy-scheduled-header">
      <div><div className="cy-scheduled-eyebrow"><CalendarClock size={15} /> 自动化</div>
        <h1>定时任务</h1><p>在指定时间运行工作任务，可随时查看结果或暂停。</p></div>
      <Space><Button icon={<RefreshCw size={15} />} onClick={() => void refresh()} />
        <Button type="primary" icon={<Plus size={15} />} onClick={() => { setEditing(null); setDraft(emptyDraft()); }}>新建任务</Button></Space>
    </header>
    <div className="cy-scheduled-summary"><span>任务 <strong>{tasks.length}</strong></span><span>运行中 <strong>{tasks.filter((task) => task.enabled).length}</strong></span></div>
    {loading ? <div className="cy-scheduled-loading">加载中…</div> : sortedTasks.length === 0
      ? <Card className="cy-scheduled-empty"><Empty description="还没有定时任务" /></Card>
      : <div className="cy-scheduled-list">{sortedTasks.map((task) => <Card key={task.id} className="cy-scheduled-card">
        <div className="cy-scheduled-card-main">
          <div className="cy-scheduled-card-copy">
            <div className="cy-scheduled-card-title-row"><h2>{task.title}</h2><Tag>{task.mode === "code" ? "Code" : "Work"}</Tag><Tag color={task.enabled ? "green" : "default"}>{task.enabled ? "已启用" : "已停用"}</Tag>{task.ownerPluginId && <Tag>插件任务</Tag>}</div>
            <p className="cy-scheduled-prompt">{task.prompt}</p>
            <div className="cy-scheduled-meta"><span><Clock3 size={13} />{describeSchedule(task.schedule)}</span><span>下次：{task.nextFireAt ? new Date(task.nextFireAt).toLocaleString() : "—"}</span></div>
          </div>
          <Space className="cy-scheduled-card-actions">
            <Button type="text" title="运行记录" icon={<History size={16} />} onClick={() => void showHistory(task)} />
            <Button type="text" title="立即运行" disabled={!task.enabled || busyId === task.id} icon={<Play size={16} />} onClick={() => void mutate(task.id, () => scheduler()!.fireNow(task.id))} />
            <Button type="text" title="编辑" icon={<Pencil size={16} />} onClick={() => { setEditing(task); setDraft(fromTask(task)); }} />
            <Switch size="small" checked={task.enabled} disabled={busyId === task.id} onChange={(checked) => void mutate(task.id, () => scheduler()!.toggle(task.id, checked))} />
            <Button type="text" danger title="删除" icon={<Trash2 size={16} />} onClick={() => Modal.confirm({ title: `删除“${task.title}”？`, content: "任务和运行记录将被删除。", okType: "danger", onOk: () => mutate(task.id, () => scheduler()!.delete(task.id)) })} />
          </Space>
        </div>
      </Card>)}</div>}
    <Modal open={Boolean(draft)} title={editing ? "编辑定时任务" : "新建定时任务"} width={600}
      okText="保存" okButtonProps={{ loading: busyId === (editing?.id ?? "new") }} onOk={() => void saveDraft()} onCancel={() => { setDraft(null); setEditing(null); }} destroyOnHidden>
      {draft && <div className="cy-scheduled-editor">
        <label>标题<Input value={draft.title} onChange={(event) => update({ title: event.target.value })} maxLength={120} /></label>
        <label>任务内容<Input.TextArea value={draft.prompt} onChange={(event) => update({ prompt: event.target.value })} rows={5} maxLength={10000} /></label>
        <label>运行模式<Select value={draft.mode} onChange={(mode) => update({ mode })} options={[{ value: "work", label: "Work" }, { value: "code", label: "Code" }]} /></label>
        <div className="cy-scheduled-editor-row"><label>重复方式<Select value={draft.kind} onChange={(kind) => update({ kind })} options={[
          { value: "once", label: "仅一次" }, { value: "daily", label: "每天" }, { value: "weekly", label: "每周" }, { value: "interval", label: "固定间隔" },
        ]} /></label>
          {draft.kind === "once" && <label>运行时间<Input type="datetime-local" value={draft.runAt} onChange={(event) => update({ runAt: event.target.value })} /></label>}
          {(draft.kind === "daily" || draft.kind === "weekly") && <label>时间<Input type="time" value={draft.timeOfDay} onChange={(event) => update({ timeOfDay: event.target.value })} /></label>}
          {draft.kind === "weekly" && <label>星期<Select value={draft.dayOfWeek} onChange={(dayOfWeek) => update({ dayOfWeek })} options={["日", "一", "二", "三", "四", "五", "六"].map((label, value) => ({ value, label }))} /></label>}
          {draft.kind === "interval" && <><label>间隔<InputNumber min={1} value={draft.every} onChange={(every) => update({ every: every ?? 1 })} /></label>
            <label>单位<Select value={draft.unit} onChange={(unit) => update({ unit })} options={[{ value: "minutes", label: "分钟" }, { value: "hours", label: "小时" }]} /></label></>}
        </div>
        <label className="cy-scheduled-editor-toggle">启用<Switch checked={draft.enabled} onChange={(enabled) => update({ enabled })} /></label>
        <label className="cy-scheduled-editor-toggle">限制可用工具<Switch checked={draft.limitTools} onChange={(limitTools) => update({ limitTools })} /></label>
        {draft.limitTools && <Select mode="multiple" value={draft.allowedToolIds} onChange={(allowedToolIds) => update({ allowedToolIds })}
          options={tools.filter((tool) => tool.enabled).map((tool) => ({ value: tool.id, label: tool.name }))} placeholder="选择允许使用的工具" />}
      </div>}
    </Modal>
    <Modal open={Boolean(historyTask)} title={`${historyTask?.title ?? ""} · 运行记录`} footer={null} onCancel={() => { setHistoryTask(null); setHistory([]); }} destroyOnHidden>
      {history.length === 0 ? <Empty description="没有运行记录" /> : <div className="cy-scheduled-history">{history.map((entry) => <Card key={entry.id} size="small">
        <Tag color={entry.status === "success" ? "green" : entry.status === "failed" ? "red" : "default"}>{entry.status}</Tag>
        <span>{new Date(entry.firedAt).toLocaleString()}</span>
        {(entry.outputPreview || entry.errorMessage) && <p>{entry.outputPreview || entry.errorMessage}</p>}
      </Card>)}</div>}
    </Modal>
  </div>;
}
