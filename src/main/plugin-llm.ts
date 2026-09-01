import { getAdapterForConfig } from "./orchestrator/vendors";
import type { ChatMessage, Transport, VendorConfig } from "./orchestrator/vendors/types";

export interface PluginLlmSettings {
  provider: string;
  baseUrl: string;
  model: string;
  apiKey: string;
  explicitTransport?: Transport | "auto";
}

export async function pluginGenerateText(
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  settings: PluginLlmSettings,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!settings.apiKey.trim()) {
    throw new Error("未配置 API Key，请先在设置页配置主聊天模型");
  }
  if (!settings.model.trim()) {
    throw new Error("未配置主聊天模型名称");
  }

  const config: VendorConfig = {
    provider: settings.provider,
    baseUrl: settings.baseUrl,
    model: settings.model,
    apiKey: settings.apiKey,
    explicitTransport: settings.explicitTransport,
  };
  const adapter = getAdapterForConfig(config);
  const request = adapter.buildRequest(
    {
      model: config.model,
      messages: messages as ChatMessage[],
      maxTokens: 1024,
      stream: false,
    },
    config,
  );
  const response = await fetchImpl(request.url, {
    method: "POST",
    headers: request.headers,
    body: request.body,
  });
  if (!response.ok) {
    throw new Error(`插件模型请求失败: HTTP ${response.status}`);
  }
  const parsed = adapter.parseResponse(await response.json());
  const text = parsed.text?.trim();
  if (!text) throw new Error("主聊天模型没有返回文本");
  return text;
}
