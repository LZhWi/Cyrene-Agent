import { isChatGptOAuth } from "../../shared/chatgpt-oauth";

let endpoint: { baseUrl: string; apiKey: string } | undefined;
export function setChatGptEndpoint(value: typeof endpoint): void { endpoint = value; }
export function resolveChatGptEndpoint<T extends { baseUrl: string; apiKey: string }>(config: T): T {
  if (!isChatGptOAuth(config)) return config;
  if (!endpoint) throw new Error("ChatGPT OAuth 尚未就绪，请打开模型面板重新连接");
  return { ...config, ...endpoint };
}
