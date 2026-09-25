import { lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { PluginContext, PluginLlmMessage } from "@playa0v0/cyrene-plugin-sdk";

export interface ModelConfig {
  mode: "host" | "custom";
  reuse: "current" | "file";
  sourcePath: string;
  baseUrl: string;
  model: string;
  systemPrompt: string;
}
export const DEFAULT_MODEL_CONFIG: ModelConfig = {
  mode: "host", reuse: "current", sourcePath: "", baseUrl: "", model: "",
  systemPrompt: "",
};
interface DirectConfig { baseUrl: string; model: string; apiKey: string }

export function endpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  if (url.username || url.password || url.search || url.hash ||
    (url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)))) {
    throw new Error("模型地址必须为 HTTPS，或本机 HTTP；不得含凭据、查询参数或片段");
  }
  url.pathname = `${url.pathname.replace(/\/$/, "").replace(/\/chat\/completions$/, "")}/chat/completions`;
  return url.toString();
}

/** 只读原配置，不加载原程序模块、不写回文件、不向 renderer 返回 API Key。 */
export function readReferencedConfig(file: string): DirectConfig {
  if (!path.isAbsolute(file) || path.basename(file) !== "model-settings.json") throw new Error("请选择 model-settings.json 的绝对路径");
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 2 * 1024 * 1024) throw new Error("模型配置文件类型或大小不符合要求");
  if (path.normalize(realpathSync(file)).toLowerCase() !== path.normalize(file).toLowerCase()) throw new Error("配置文件不可通过链接间接引用");
  let raw: any;
  try { raw = JSON.parse(readFileSync(file, "utf8")); } catch { throw new Error("无法解析模型配置文件"); }
  // 已确认当前原项目采用顶层配置。未知档案结构不猜测，避免请求错误服务。
  if (raw.profiles) throw new Error("此档案格式尚未支持，请选复用当前宿主或自定义模型");
  if (raw.explicitTransport === "anthropic" || /anthropic|claude|minimax/i.test(String(raw.provider))) {
    throw new Error("只读文件模式当前支持 OpenAI 兼容协议（含 Kimi）；其他协议请使用当前宿主模式");
  }
  if (![raw.baseUrl, raw.model, raw.apiKey].every((v) => typeof v === "string" && v.trim())) throw new Error("原模型配置不完整");
  endpoint(raw.baseUrl);
  return { baseUrl: raw.baseUrl, model: raw.model, apiKey: raw.apiKey };
}

export function parseConfig(raw: any): ModelConfig {
  if (!raw || !["host", "custom"].includes(raw.mode) || !["current", "file"].includes(raw.reuse)) throw new Error("模型来源无效");
  for (const field of ["sourcePath", "baseUrl", "model", "systemPrompt"]) {
    if (typeof raw[field] !== "string" || raw[field].length > (field === "systemPrompt" ? 32000 : 2048)) throw new Error("配置字段无效或过长");
  }
  if (raw.mode === "custom") {
    endpoint(raw.baseUrl);
    if (!raw.model.trim()) throw new Error("请输入模型名称");
  }
  return {
    mode: raw.mode,
    reuse: raw.reuse,
    sourcePath: raw.sourcePath.trim(),
    baseUrl: raw.baseUrl.trim(),
    model: raw.model.trim(),
    systemPrompt: raw.systemPrompt,
  };
}

export function createModelService(ctx: PluginContext, fetcher: typeof fetch = fetch) {
  let config = parseConfig(ctx.storage.get<ModelConfig>("model-config") ?? DEFAULT_MODEL_CONFIG);
  return {
    get config() { return { ...config }; },
    async view() { return { ...config, hasCustomKey: Boolean(await ctx.deps.secrets?.get("model-key")) }; },
    async save(raw: any) {
      const next = parseConfig(raw);
      if (next.mode === "host" && next.reuse === "file") readReferencedConfig(next.sourcePath);
      if (raw.apiKey !== undefined && (typeof raw.apiKey !== "string" || raw.apiKey.length > 8192)) throw new Error("密钥格式无效");
      if (next.mode === "custom" && !raw.apiKey?.trim() && await ctx.deps.secrets?.get("model-key") &&
        (!config.baseUrl || endpoint(config.baseUrl) !== endpoint(next.baseUrl))) {
        throw new Error("模型地址已改变，请重新输入密钥；不会把旧密钥自动发送到新地址");
      }
      if (raw.apiKey?.trim()) {
        if (!ctx.deps.secrets) throw new Error("宿主安全凭据存储不可用");
        // 只有用户在界面点击保存时才写入插件私有安全凭据，不保存到普通 JSON。
        await ctx.deps.secrets.set("model-key", raw.apiKey.trim());
      }
      ctx.storage.set("model-config", next); config = next;
      return this.view();
    },
    async generate(messages: PluginLlmMessage[], signal: AbortSignal, limits: { maxTokens?: number; timeoutMs?: number } = {}): Promise<string> {
      const snapshot = { ...config };
      const maxTokens = limits.maxTokens ?? 4096;
      const timeoutMs = limits.timeoutMs ?? 120000;
      if (signal.aborted || ctx.signal.aborted) throw new Error("请求已取消");
      if (snapshot.mode === "host" && snapshot.reuse === "current") {
        if (!ctx.deps.llm) throw new Error("当前宿主模型服务不可用");
        try { return await ctx.deps.llm.generateText(messages, { signal, maxTokens, timeoutMs, purpose: "companion" }); }
        catch { throw new Error(signal.aborted ? "请求已取消" : "宿主模型请求失败，请检查主程序模型设置"); }
      }
      const resolved: DirectConfig = snapshot.mode === "host"
        ? readReferencedConfig(snapshot.sourcePath)
        : { baseUrl: snapshot.baseUrl, model: snapshot.model, apiKey: await ctx.deps.secrets?.get("model-key") ?? "" };
      if (!resolved.apiKey.trim()) throw new Error("请先保存自定义模型密钥");
      const combined = AbortSignal.any([signal, ctx.signal, AbortSignal.timeout(timeoutMs)]);
      try {
        const response = await fetcher(endpoint(resolved.baseUrl), {
          method: "POST", redirect: "error", signal: combined,
          headers: { "Content-Type": "application/json", Authorization: `Bearer ${resolved.apiKey}` },
          body: JSON.stringify({ model: resolved.model, messages, stream: false, max_tokens: maxTokens }),
        });
        // 不回显服务端错误正文，防止第三方错误内容包含凭据或请求文本。
        if (!response.ok) throw new Error(`HTTP_${response.status}`);
        const data = await response.json() as any;
        const choice = data?.choices?.[0];
        if (choice?.finish_reason !== "stop" || typeof choice?.message?.content !== "string" || !choice.message.content.trim()) throw new Error("模型未返回完整文本");
        return choice.message.content.trim();
      } catch { throw new Error(combined.aborted ? "请求已取消或超时" : "模型请求失败或输出不完整，请检查地址、协议、模型及凭据"); }
    },
  };
}
