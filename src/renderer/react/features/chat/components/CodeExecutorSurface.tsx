import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { Popover } from "antd";
import { isCodeTaskBusy, type CodeExecutorAction, type CodeExecutorApi, type CodeExecutorSnapshot } from "../../../../../shared/code-executor";
import "./CodeExecutorSurface.css";
import "./PermissionControl.css";

const CodeRouteContext = createContext<ReactNode>(null);
export function useCodeExecutorRoute() { return useContext(CodeRouteContext); }

function CodeRouteControl({ selected, disabled, onSelect }: { selected: boolean; disabled: boolean; onSelect(value: boolean): void }) {
  const [open, setOpen] = useState(false);
  return <Popover trigger="click" placement="topLeft" open={open && !disabled} onOpenChange={setOpen}
    overlayClassName="cy-permission-popover" content={<div className="cy-permission-panel">
      <strong>执行线路</strong>
      <div className="cy-permission-panel__options">
        {[{ value: false, label: "原生" }, { value: true, label: "Codex" }].map(option => <button
          type="button" key={option.label} disabled={disabled} aria-pressed={selected === option.value}
          className={`cy-permission-panel__option is-per-action ${selected === option.value ? "is-active" : ""}`}
          onClick={() => { onSelect(option.value); setOpen(false); }}>{option.label}</button>)}
      </div>
    </div>}>
    <button type="button" className="cy-code-executor__route cy-composer__footer-button" aria-label="Code 执行器"
      aria-expanded={open && !disabled} disabled={disabled}>
      <span>{selected ? "Codex" : "原生"}</span>
      <svg viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" /></svg>
    </button>
  </Popover>;
}

export function CodeExecutorSurface(props: { enabled: boolean; sessionId: string | null; workspace?: string; nativeBusy: boolean; onChooseWorkspace(): void; children: ReactNode }) {
  // Chat/Work/Learn never mount the executor, poll its API or change their composer.
  if (!props.enabled) return <>{props.children}</>;
  return <CodeSurface key={`${props.sessionId}:${props.workspace}`} {...props} />;
}

function CodeSurface({ sessionId, workspace, nativeBusy, onChooseWorkspace, children }: Omit<Parameters<typeof CodeExecutorSurface>[0], "enabled">) {
  const [selected, setSelected] = useState(false);
  const [snapshot, setSnapshot] = useState<CodeExecutorSnapshot>();
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const [message, setMessage] = useState("");
  const [model, setModel] = useState("");
  const [effort, setEffort] = useState("");
  const [skillPath, setSkillPath] = useState("");
  const [sandbox, setSandbox] = useState("read-only");
  const [autoExplain, setAutoExplain] = useState(true);
  const [newThread, setNewThread] = useState(false);
  const alive = useRef(true);
  const acting = useRef(false);
  const running = snapshot?.tasks.some(task => isCodeTaskBusy(task.status)) ?? false;
  const busy = snapshot?.tasks.some(task => isCodeTaskBusy(task.status) || task.status === "unknown") ?? false;
  const available = snapshot && ["connected", "idle"].includes(snapshot.connection);
  const models = snapshot?.models ?? [];
  const efforts = models.find(item => item.model === model)?.supportedReasoningEfforts ?? [];

  async function invoke(action: CodeExecutorAction, data?: unknown) {
    const api = (window as unknown as { codeExecutor?: CodeExecutorApi }).codeExecutor;
    if (!api || !sessionId) throw new Error("请先创建 Code 会话并选择工作目录");
    const result = await api.invoke(sessionId, action, data);
    if (!result.ok) throw new Error(result.error);
    return result.data;
  }
  async function act(action: CodeExecutorAction, data?: unknown) {
    if (acting.current) return;
    acting.current = true; setPending(true); setError("");
    try {
      const result = await invoke(action, data);
      if (!alive.current) return;
      setSnapshot(result);
      if (action === "connect") {
        const chosen = result.models.find(item => item.model === result.config.model) ?? result.models.find(item => item.isDefault) ?? result.models[0];
        setModel(chosen?.model ?? "");
        setEffort(chosen?.supportedReasoningEfforts.some(item => item.reasoningEffort === result.config.effort) ? result.config.effort : chosen?.defaultReasoningEffort ?? "");
        setSkillPath(result.skills.some(item => item.enabled && item.path === result.config.skillPath) ? result.config.skillPath : "");
        setSandbox(result.config.sandbox); setAutoExplain(result.config.autoExplain);
      }
      if (action === "submit") { setMessage(""); setNewThread(false); }
    } catch (e) { if (alive.current) setError(e instanceof Error ? e.message : String(e)); }
    finally { acting.current = false; if (alive.current) setPending(false); }
  }
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    if (!sessionId || !workspace) return;
    let cancelled = false, polling = false;
    const refresh = async () => {
      if (polling || acting.current) return;
      polling = true;
      try { const result = await invoke("state"); if (!cancelled) setSnapshot(result); }
      catch (e) { if (!cancelled && selected) setError(e instanceof Error ? e.message : String(e)); }
      finally { polling = false; }
    };
    void refresh(); const timer = setInterval(refresh, 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [selected, sessionId, workspace]);

  const routeControl = <CodeRouteControl selected={selected} disabled={nativeBusy || (selected && busy) || pending} onSelect={setSelected} />;
  return <CodeRouteContext.Provider value={!selected && busy ? null : routeControl}><div className="cy-code-executor">
    {!selected ? <>{busy && <p role="status">此会话有 Codex 任务待处理，请切换至 Codex 查看。{routeControl}</p>}<div inert={busy || undefined}>{children}</div></> : <section aria-label="Codex 任务" className="cy-code-executor__panel">
      {routeControl}
      <p>消息直接发送给 Codex。此处仅发送文本；原生聊天历史和附件不会自动传入。</p>
      <div className="cy-code-executor__controls">
        <button type="button" disabled={pending || busy} onClick={onChooseWorkspace}>{workspace || "选择工作目录"}</button>
        <button type="button" disabled={!sessionId || !workspace || pending || running} onClick={() => void act("connect")}>连接 / 刷新目录</button>
        <span role="status">{snapshot?.connection === "idle" ? "会话已释放，下次提交自动连接" : snapshot?.connection === "releasing" ? "正在释放会话…" : snapshot?.connection === "connected" ? "已连接" : "尚未连接"}</span>
      </div>
      {error && <p role="alert">{error}</p>}
      {snapshot?.connectionError && <p role="alert">{snapshot.connectionError}</p>}
      <div className="cy-code-executor__records">
        {snapshot?.tasks.slice().reverse().map(task => <article key={task.id}>
          <strong>Codex · {({ completed: "已完成", failed: "失败", interrupted: "已中断", unknown: "待核对", waiting: "等待回答", inProgress: "执行中", submitting: "提交中", cancelling: "取消中" } as Record<string, string>)[task.status] ?? task.status}</strong>
          <pre>{task.message}</pre>
          <small>{task.config.model} · {task.config.effort}</small>
          {task.finalText ? <><h4>原始回执</h4><pre>{task.finalText}</pre></> : <pre>{task.progress}</pre>}
          {task.error && <p role="alert">{task.error}</p>}
          {task.diff && <details><summary>文件变化</summary><pre>{task.diff}</pre></details>}
          {snapshot.prompts.filter(prompt => prompt.taskId === task.id).map(prompt => <CodePrompt key={`${task.id}:${prompt.id}`} prompt={prompt} disabled={pending}
            onAnswer={data => void act("answer", { taskId: task.id, requestId: prompt.id, ...data })} />)}
          {isCodeTaskBusy(task.status) && task.turnId && <button type="button" disabled={pending} onClick={() => void act("cancel", { id: task.id })}>取消任务</button>}
          {task.status === "unknown" && <button type="button" disabled={pending} onClick={() => void act("sync", { id: task.id })}>核对回执</button>}
          {(task.explanation || task.explaining || task.explanationError) && <aside><h4>Cyrene 解读</h4><pre>{task.explaining ? "正在生成解读…" : task.explanation || task.explanationError}</pre></aside>}
          {task.finalText && !isCodeTaskBusy(task.status) && <button type="button" disabled={pending || task.explaining} onClick={() => void act("explain", { id: task.id })}>由 Cyrene 解读</button>}
        </article>)}
      </div>
      <fieldset disabled={!available || busy || pending || nativeBusy}>
        <div className="cy-code-executor__controls">
          <label>Codex 模型 <select value={model} onChange={event => { setModel(event.target.value); setEffort(models.find(item => item.model === event.target.value)?.defaultReasoningEffort ?? ""); }}>
            <option value="" disabled>请选择</option>{models.map(item => <option key={item.model} value={item.model}>{item.displayName || item.model}</option>)}
          </select></label>
          <label>思考强度 <select value={effort} onChange={event => setEffort(event.target.value)}>{efforts.map(item => <option key={item.reasoningEffort}>{item.reasoningEffort}</option>)}</select></label>
          <label>技能 <select value={skillPath} onChange={event => setSkillPath(event.target.value)}><option value="">不指定</option>{snapshot?.skills.filter(item => item.enabled).map(item => <option key={item.path} value={item.path}>{item.name}</option>)}</select></label>
          <label>执行范围 <select value={sandbox} onChange={event => setSandbox(event.target.value)}><option value="read-only">只读</option><option value="workspace-write">工作区写入</option></select></label>
        </div>
        <textarea aria-label="发送给 Codex 的消息" value={message} onChange={event => setMessage(event.target.value)} placeholder="输入任务；原文直接发送给 Codex" />
        <label><input type="checkbox" checked={autoExplain} onChange={event => setAutoExplain(event.target.checked)} />完成后由 Cyrene 解读（使用宿主模型）</label>
        <label><input type="checkbox" checked={newThread} onChange={event => setNewThread(event.target.checked)} />新建 Codex 会话（默认续接）</label>
        <button type="button" disabled={!message.trim() || !model || !effort} onClick={() => void act("submit", { message, model, effort, skillPath, sandbox, autoExplain, newThread })}>发送给 Codex</button>
      </fieldset>
    </section>}
  </div></CodeRouteContext.Provider>;
}

function CodePrompt({ prompt, disabled, onAnswer }: { prompt: CodeExecutorSnapshot["prompts"][number]; disabled: boolean; onAnswer(data: object): void }) {
  const [answers, setAnswers] = useState<Record<string, string>>({});
  if (prompt.method !== "item/tool/requestUserInput") return <fieldset disabled={disabled}><legend>Codex 请求审批</legend>
    <pre>{JSON.stringify(prompt.params, null, 2)}</pre>
    {[["accept", "允许此次"], ["decline", "拒绝"], ["cancel", "取消"]].filter(([decision]) => (prompt.params.availableDecisions ?? ["accept", "decline", "cancel"]).includes(decision)).map(([decision, text]) => <button type="button" key={decision} onClick={() => onAnswer({ decision })}>{text}</button>)}
  </fieldset>;
  const questions = prompt.params.questions ?? [];
  return <fieldset disabled={disabled}><legend>Codex 需要回答</legend>{questions.map(question => <div key={question.id}>
    <label>{question.question}<input type={question.isSecret ? "password" : "text"} value={answers[question.id] ?? ""} onChange={event => setAnswers(current => ({ ...current, [question.id]: event.target.value }))} /></label>
    {question.options?.map(option => <button type="button" key={option.label} title={option.description} onClick={() => setAnswers(current => ({ ...current, [question.id]: option.label }))}>{option.label}</button>)}
  </div>)}<button type="button" disabled={questions.some(question => !answers[question.id]?.trim())} onClick={() => onAnswer({ answers })}>提交回答</button></fieldset>;
}
