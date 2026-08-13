import { useEffect, useState } from "react";
import workingIcon from "../../../assets/status-moods/工作中.png";
import "./ModelModePanel.css";

interface ModelProfile { id: string; provider: string; displayName?: string; model: string; }
interface ModelCatalogApi {
  listModelProfiles?: () => Promise<{ profiles: ModelProfile[]; defaultModelProfileId?: string }>;
  setDefaultModelProfile?: (id: string) => Promise<unknown>;
  deleteModelProfile?: (id: string) => Promise<unknown>;
}

export function ModelModePanel() {
  const [profiles, setProfiles] = useState<ModelProfile[]>([]);
  const [defaultId, setDefaultId] = useState<string>();
  const api = () => (window as typeof window & { settings?: ModelCatalogApi }).settings;
  const reload = async () => {
    const catalog = await api()?.listModelProfiles?.();
    setProfiles(catalog?.profiles ?? []); setDefaultId(catalog?.defaultModelProfileId);
  };
  useEffect(() => { void reload(); }, []);
  return <section className="cy-model-mode-panel"><header><h2>模型列表</h2><p>默认模型用于新对话；当前对话可在输入框中单独切换。</p></header>
    {profiles.length === 0 ? <p className="cy-model-mode-panel__empty">请先到 API 设置保存模型。</p> : profiles.map((profile) => <article key={profile.id} className="cy-model-mode-panel__item"><img src={workingIcon} alt="" aria-hidden="true" className="cy-model-mode-panel__icon" /><div><strong>{profile.displayName || profile.provider}</strong><small>{profile.model} · {profile.provider}</small></div><div className="cy-model-mode-panel__actions"><button type="button" disabled={profile.id === defaultId} onClick={() => void api()?.setDefaultModelProfile?.(profile.id).then(reload)}>{profile.id === defaultId ? "默认" : "设为默认"}</button><button type="button" onClick={() => void api()?.deleteModelProfile?.(profile.id).then(reload)}>删除</button></div></article>)}</section>;
}
