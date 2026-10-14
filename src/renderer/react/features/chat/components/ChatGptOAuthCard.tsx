import React, { useEffect, useState } from "react";
import { isChatGptOAuth } from "../../../../../shared/chatgpt-oauth";

interface OAuthApi {
  listModelProfiles(): Promise<{ profiles: Array<{ baseUrl?: string; model: string; displayName?: string }> }>;
  chatGptOAuthStatus(): Promise<{ connected: boolean; planEnabled: boolean; label?: string }>;
  chatGptOAuthLogin(): Promise<{ connected: boolean; planEnabled: boolean; label?: string }>;
  chatGptOAuthCancel(): Promise<void>;
  chatGptOAuthModels(): Promise<Array<{ id: string; name: string }>>;
  chatGptOAuthSave(input: { model: string; displayName?: string }): Promise<{ added: boolean }>;
}
export function ChatGptOAuthCard({ onSaved }: { onSaved: () => Promise<void> }) {
  const api = (window as unknown as { settings: OAuthApi }).settings;
  const [status, setStatus] = useState<Awaited<ReturnType<OAuthApi["chatGptOAuthStatus"]>>>();
  const [models, setModels] = useState<Array<{ id: string; name: string }>>([]);
  const [model, setModel] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    api.listModelProfiles().then(({ profiles }) => {
      const saved = profiles.find(isChatGptOAuth);
      if (active && saved) { setModel(saved.model); setName(saved.displayName ?? ""); setModels([{ id: saved.model, name: saved.model }]); }
    }).catch(e => { if (active) setError(String(e.message ?? e)); });
    api.chatGptOAuthStatus().then(value => { if (active) setStatus(value); })
      .catch(e => { if (active) setError(String(e.message ?? e)); });
    return () => { active = false; };
  }, [api]);
  async function run(action: string, fn: () => Promise<void>) {
    setBusy(action); setError(""); setMessage("");
    try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(""); }
  }
  async function refresh() {
    const values = await api.chatGptOAuthModels();
    setModels(values); setModel(current => values.some(m => m.id === current) ? current : "");
  }
  return <section className="model-panel__oauth" aria-label="ChatGPT OAuth 配置">
    <h2>ChatGPT · OAuth <small>固定档案 · 不可移除</small></h2>
    <p>使用 ChatGPT 账号授权，作为可选模型线路。登录和保存均不会切换当前主模型。</p>
    <p>{status ? status.connected ? `已连接${status.label ? `：${status.label}` : ""}${status.planEnabled ? "" : "（尚未授权套餐使用）"}` : "尚未连接" : "正在读取连接状态…"}</p>
    <div className="model-panel__oauth-actions">
      <button type="button" disabled={!!busy} onClick={() => void run("login", async () => {
        const next = await api.chatGptOAuthLogin(); setStatus(next); setModels([]); setModel("");
        if (next.planEnabled) await refresh();
      })}>{busy === "login" ? "请在浏览器完成授权…" : "Continue with ChatGPT"}</button>
      {busy === "login" && <button type="button" onClick={() => void api.chatGptOAuthCancel().catch(e => setError(String(e)))}>取消登录</button>}
      <button type="button" disabled={!!busy || !status?.planEnabled} onClick={() => void run("models", refresh)}>刷新可用模型</button>
    </div>
    <div className="model-panel__oauth-actions">
      <label>模型 <select aria-label="ChatGPT OAuth 模型" disabled={!!busy || !status?.planEnabled} value={model} onChange={e => setModel(e.target.value)}>
        <option value="">请选择模型</option>{models.map(m => <option key={m.id} value={m.id}>{m.name}</option>)}
      </select></label>
      <label>显示名称 <input aria-label="ChatGPT OAuth 显示名称" maxLength={80} placeholder="可选" value={name} onChange={e => setName(e.target.value)} /></label>
      <button type="button" disabled={!!busy || !model || !status?.planEnabled} onClick={() => void run("save", async () => {
        const result = await api.chatGptOAuthSave({ model, displayName: name }); await onSaved();
        setMessage(result.added ? "OAuth 档案已保存，当前主模型未改变。" : "该模型已在列表中，当前主模型未改变。");
      })}>保存 OAuth 档案</button>
    </div>
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
  </section>;
}
