import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import * as path from "node:path";
import { app } from "electron";
import { CHAT_MODULES, defaultChatModuleRoutes, validateChatModuleRoutes, type ChatModule, type ChatModuleRoutes } from "../../shared/chat-module-routes";
import { isChatGptOAuth } from "../../shared/chatgpt-oauth";
import { loadModelSettings, resolveModelSettingsProfile } from "./model-settings";
import type { VendorConfig } from "../orchestrator/vendors/types";

export { CHAT_MODULES };
function configPath(): string | undefined {
  return app?.getPath ? path.join(app.getPath("userData"), "chat-module-routes.json") : undefined;
}
export function loadChatModuleRoutes(): ChatModuleRoutes {
  const file = configPath();
  return file && fs.existsSync(file) ? validateChatModuleRoutes(JSON.parse(fs.readFileSync(file, "utf8"))) : defaultChatModuleRoutes();
}
export function saveChatModuleRoutes(value: unknown): ChatModuleRoutes {
  const next = validateChatModuleRoutes(value), file = configPath();
  if (!file) throw new Error("模块配置存储尚未初始化");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + ".tmp", JSON.stringify(next, null, 2));
  fs.renameSync(file + ".tmp", file);
  return next;
}
const context = new AsyncLocalStorage<{ config: ChatModuleRoutes; disabled: boolean; scheduled: boolean }>();
/** A run keeps its routing choices through tool, Soul and nested calls. */
export function withChatModuleRoutes<T>(mode: string, task: () => T, scheduled = false): T {
  const parent = context.getStore();
  if (parent && mode === "chat" && !scheduled) return task();
  return context.run({ config: mode === "chat" ? loadChatModuleRoutes() : defaultChatModuleRoutes(), disabled: mode !== "chat", scheduled }, task);
}
export function chatModuleUsesOAuth(module: ChatModule): boolean {
  const current = context.getStore();
  if (current?.disabled) return false;
  const key = current?.scheduled && (module === "soul" || module === "tools") ? "scheduled" : module;
  return (current?.config ?? loadChatModuleRoutes()).routes[key] === "oauth";
}
export function chatModuleHasOverride(module: ChatModule): boolean {
  const current = context.getStore();
  if (current?.disabled) return false;
  const key = current?.scheduled && (module === "soul" || module === "tools") ? "scheduled" : module;
  const config = current?.config ?? loadChatModuleRoutes();
  return chatModuleUsesOAuth(module) || Boolean(config.models?.[key] || config.reasoning?.[key]);
}
export function getChatModuleOAuthProfile() {
  const settings = loadModelSettings();
  const profiles = settings.modelProfiles?.filter(isChatGptOAuth) ?? [];
  return profiles.find(profile => profile.model === "gpt-6.1-sol") ?? profiles[0];
}
/** Main preserves the caller's existing settings, including its selected profile. */
export function resolveChatModuleModel<T extends VendorConfig>(module: ChatModule, original: T): T {
  if (!chatModuleHasOverride(module)) return original;
  const current = context.getStore();
  const key = current?.scheduled && (module === "soul" || module === "tools") ? "scheduled" : module;
  const config = current?.config ?? loadChatModuleRoutes();
  const selected = config.models?.[key];
  const effort = config.reasoning?.[key];
  const oauth = chatModuleUsesOAuth(module);
  const reasoning = effort ? (effort === "auto" || effort === "off" || effort === "on" ? { mode: effort } as const : { mode: "on", effort } as const) : undefined;
  if (!oauth && !selected) return { ...original, reasoning: reasoning ?? original.reasoning };
  const target = oauth ? getChatModuleOAuthProfile() : loadModelSettings().modelProfiles?.find(profile => profile.id === selected && !isChatGptOAuth(profile));
  if (!target) throw new Error(`${CHAT_MODULES[module]}的${oauth ? "OAuth " : ""}模型档案不可用，请在设置中重新选择`);
  console.info("[ChatModuleRoute]", module, oauth ? "oauth" : "main", oauth && selected ? selected : target.model);
  return { ...original, provider: target.provider, baseUrl: target.baseUrl, model: target.model,
    ...(oauth && selected ? { model: selected } : {}), apiKey: target.apiKey, explicitTransport: target.explicitTransport,
    reasoning: reasoning ?? target.reasoning,
    multimodal: target.multimodal, contextWindowTokens: target.contextWindowTokens };
}
export function getChatModuleRoutesView() {
  return { ...loadChatModuleRoutes(), modules: CHAT_MODULES,
    mainLabel: resolveModelSettingsProfile(loadModelSettings()).model,
    oauthLabel: getChatModuleOAuthProfile()?.model ?? "尚未配置",
    mainProfiles: (loadModelSettings().modelProfiles ?? []).filter(profile => !isChatGptOAuth(profile)).map(profile => ({ id: profile.id, name: profile.displayName ? `${profile.displayName} · ${profile.model}` : `${profile.provider} · ${profile.model}` })) };
}
