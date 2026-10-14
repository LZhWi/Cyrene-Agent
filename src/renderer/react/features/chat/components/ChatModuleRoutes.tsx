import React, { useEffect, useState } from "react";

type Route = "main" | "oauth";
interface Configuration { version: 1; routes: Record<string, Route>; models?: Record<string, string>; reasoning?: Record<string, string>; }
interface RoutesView extends Configuration {
  modules: Record<string, string>;
  mainLabel: string;
  oauthLabel: string;
  mainProfiles?: Array<{ id: string; name: string }>;
}
export interface ChatModuleRoutesApi {
  read(): Promise<RoutesView>;
  save(value: Configuration): Promise<Configuration>;
}

export function ChatModuleRoutes() {
  const settings = (window as unknown as { settings?: { getChatModuleRoutes?: ChatModuleRoutesApi["read"]; saveChatModuleRoutes?: ChatModuleRoutesApi["save"]; chatGptOAuthModels?: () => Promise<Array<{ id: string; name: string }>> } }).settings;
  const [api] = useState<ChatModuleRoutesApi | undefined>(() => settings?.getChatModuleRoutes && settings.saveChatModuleRoutes
    ? { read: settings.getChatModuleRoutes, save: settings.saveChatModuleRoutes } : undefined);
  const [view, setView] = useState<RoutesView>();
  const [draft, setDraft] = useState<Configuration>();
  const [saved, setSaved] = useState<Configuration>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [oauthModels, setOAuthModels] = useState<Array<{ id: string; name: string }>>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [showProactiveHelp, setShowProactiveHelp] = useState(false);
  async function refreshModels() {
    setModelsLoading(true); setError("");
    try { setOAuthModels(await settings?.chatGptOAuthModels?.() ?? []); }
    catch (e) { setError(`无法读取 OAuth 模型：${e instanceof Error ? e.message : String(e)}`); }
    finally { setModelsLoading(false); }
  }
  useEffect(() => {
    let active = true;
    api?.read().then(value => {
      if (!active) return;
      setView(value);
      const config: Configuration = { version: 1, routes: value.routes, ...(value.models ? { models: value.models } : {}), ...(value.reasoning ? { reasoning: value.reasoning } : {}) };
      setDraft(config); setSaved(config);
    }).catch(e => { if (active) setError(String(e.message ?? e)); });
    return () => { active = false; };
  }, [api]);
  const needsOAuth = Object.values(draft?.routes ?? {}).includes("oauth");
  useEffect(() => { if (needsOAuth) void refreshModels(); }, [needsOAuth]);
  if (!api) return null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(saved);
  const change = (routes: Record<string, Route>) => {
    setDraft({ version: 1, routes }); setMessage(""); setError("");
  };
  async function save() {
    if (!draft || !api) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const value = await api.save(draft);
      setDraft(value); setSaved(value); setMessage("已保存，将用于后续任务。");
    } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  }
  return <section className="agent-setting-card agent-setting-card--full chat-module-settings" aria-label="Chat 模块分工">
    <div className="chat-module-settings__heading"><h2>模块分工</h2>
      <button type="button" className="chat-module-settings__help" aria-label="模块分工说明" aria-expanded={showHelp} aria-controls="chat-module-help" onClick={() => setShowHelp(value => !value)}>ⓘ</button>
    </div>
    <div id="chat-module-help" hidden={!showHelp}>
    <p>默认全部由主模型负责。可逐项选择 OAuth，保存后用于后续任务。</p>
    {view && <p>主模型：{view.mainLabel} · OAuth：{view.oauthLabel}</p>}
    <p>分工单独保存，不改变已有模型配置。Work／Code／Learn 保持原有线路。</p>
    <p>右侧可为每个模块指定模型；选择“跟随”时沿用原配置。推荐分工：最终回复和主动消息使用主模型，其余模块使用 OAuth。</p>
    </div>
    {!draft ? <p role="status">{error ? "暂时无法读取分工配置。请重新打开昔涟设置。" : "正在读取分工配置…"}</p> : <>
      <div className="form-actions">
        <button type="button" className="save-btn save-btn--ghost" disabled={busy} onClick={() => change(Object.fromEntries(Object.keys(draft.routes).map(key => [key, "main"])))}>全部由主模型负责</button>
        <button type="button" className="save-btn save-btn--ghost" disabled={busy} onClick={() => change(Object.fromEntries(Object.keys(draft.routes).map(key => [key, ["soul", "proactive", "proactiveDecision"].includes(key) ? "main" : "oauth"])))}>推荐分工</button>
      </div>
      {needsOAuth && <button type="button" className="save-btn save-btn--ghost" disabled={modelsLoading} onClick={() => void refreshModels()}>{modelsLoading ? "正在读取 OAuth 模型…" : "刷新 OAuth 可用模型"}</button>}
      <div className="form-grid">{Object.entries(view!.modules).map(([key, label]) => {
        const choices = draft.routes[key] === "oauth" ? oauthModels : view!.mainProfiles ?? [];
        const selected = draft.models?.[key] ?? "";
        return <div className="field" key={key}>
        <span>{label}{key === "proactive" && <button type="button" className="chat-module-settings__help" aria-label="主动消息说明" aria-expanded={showProactiveHelp} aria-controls="proactive-module-help" onClick={() => setShowProactiveHelp(value => !value)}>ⓘ</button>}</span>
        {key === "proactive" && <p id="proactive-module-help" hidden={!showProactiveHelp}>发送判定与内容生成的实际模型配置（含思考强度）一致时，沿用一次调用；不一致时先判定，只有允许发送才调用内容模型。静默、失败或无效判定不会进入内容生成。</p>}
        <div className="chat-module-settings__selectors"><select aria-label={`${label}的模型线路`} value={draft.routes[key]} disabled={busy} onChange={e => {
          const models = { ...draft.models }; delete models[key];
          setDraft({ ...draft, routes: { ...draft.routes, [key]: e.target.value as Route }, ...(draft.models ? { models } : {}) }); setMessage(""); setError("");
        }}>
          <option value="main">主模型</option><option value="oauth">OAuth</option>
        </select>
        <select aria-label={`${label}的指定模型`} value={selected} disabled={busy || draft.routes[key] === "oauth" && modelsLoading} onChange={e => {
          const models = { ...draft.models }; if (e.target.value) models[key] = e.target.value; else delete models[key];
          setDraft({ ...draft, models }); setMessage(""); setError("");
        }}>
          <option value="">{draft.routes[key] === "oauth" ? "跟随 OAuth 档案" : "跟随原有模型配置"}</option>
          {selected && !choices.some(item => item.id === selected) && <option value={selected}>{selected}（尚未在列表中找到）</option>}
          {choices.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
        <select aria-label={`${label}的思考强度`} value={draft.reasoning?.[key] ?? ""} disabled={busy} onChange={e => {
          const reasoning = { ...draft.reasoning }; if (e.target.value) reasoning[key] = e.target.value; else delete reasoning[key];
          setDraft({ ...draft, reasoning }); setMessage(""); setError("");
        }}>
          <option value="">思考：跟随配置</option>
          {[["auto", "自动"], ["off", "关闭"], ["on", "开启"], ["minimal", "最低"], ["low", "低"], ["medium", "中"], ["high", "高"], ["xhigh", "极高"], ["max", "最高"]].map(([value, text]) => <option key={value} value={value}>{text}</option>)}
        </select></div>
      </div>; })}</div>
      <div className="form-actions">
        <button type="button" className="save-btn" disabled={busy || !dirty} onClick={() => void save()}>{busy ? "正在保存…" : "保存模块分工"}</button>
        <span className="save-status" role="status">{message || (dirty ? "有未保存的修改" : "当前分工已加载")}</span>
      </div>
    </>}
    {error && <p role="alert">保存或读取失败：{error}</p>}
  </section>;
}
