import type {
  PluginPromptBuildInput,
  PluginPromptProvider,
  PluginPromptSource,
  PluginStablePromptProvider,
  PluginStablePromptProviderInput,
} from "./types";

const PROMPT_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export const PLUGIN_PROMPT_PROVIDER_TIMEOUT_MS = 120_000;
export const MAX_PLUGIN_PROMPT_CHARS = 16_000;
export const MAX_PLUGIN_PROMPT_TOTAL_CHARS = 32_000;
export interface PluginPromptReceipt {
  providerId: string;
  acceptedChars: number;
  complete: boolean;
}

export interface PluginPromptBuildResult {
  content: string;
  receipts: PluginPromptReceipt[];
}

/** 未声明 sources 的 Provider 视为只参与既有场景，与旧版注册行为保持一致（向后兼容）。 */
const LEGACY_PROMPT_SOURCES: readonly PluginPromptSource[] = ["conversation", "scheduler"];

interface PromptEntry {
  ownerId: string;
  provider: PluginPromptProvider;
  signal: AbortSignal;
}

interface StablePromptEntry {
  ownerId: string;
  provider: PluginStablePromptProvider;
  signal: AbortSignal;
}

export interface PluginPromptRegistry {
  register(ownerId: string, provider: PluginPromptProvider, signal: AbortSignal): void;
  unregister(ownerId: string, providerId: string): boolean;
  build(input: PluginPromptBuildInput): Promise<string>;
  buildDetailed(input: PluginPromptBuildInput): Promise<PluginPromptBuildResult>;
  registerStable(ownerId: string, provider: PluginStablePromptProvider, signal: AbortSignal): void;
  unregisterStable(ownerId: string, providerId: string): boolean;
  buildStable(input: Omit<PluginStablePromptProviderInput, "signal">): Promise<string>;
  clear(): void;
}

function fullProviderId(ownerId: string, providerId: string): string {
  return `plugin:${ownerId}:${providerId}`;
}

function usesLocalCompanionPromptContract(entry: PromptEntry, input: PluginPromptBuildInput): boolean {
  const chatBackend = (input as PluginPromptBuildInput & { chatBackend?: string }).chatBackend;
  return input.source === "conversation"
    && input.mode === "chat"
    && chatBackend === "companion"
    && (entry.ownerId === "companion-chat" || entry.ownerId === "companion-memory");
}

/** 单个 Provider 失败或超时时返回空内容，避免第三方插件阻塞整轮对话。 */
interface ResolvedPromptContribution {
  content: string;
  complete: boolean;
}

async function resolveProvider(entry: PromptEntry, input: PluginPromptBuildInput): Promise<ResolvedPromptContribution> {
  const fullId = fullProviderId(entry.ownerId, entry.provider.id);
  let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
  try {
    const content = await Promise.race([
      Promise.resolve(entry.provider.provide({ ...input, signal: entry.signal })),
      new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`提示词 Provider 超时（${PLUGIN_PROMPT_PROVIDER_TIMEOUT_MS}ms）`));
        }, PLUGIN_PROMPT_PROVIDER_TIMEOUT_MS);
      }),
    ]);
    if (typeof content !== "string") throw new Error("提示词 Provider 必须返回字符串");
    const normalized = content.trim();
    if (!normalized) return { content: "", complete: true };
    if (!usesLocalCompanionPromptContract(entry, input) && normalized.length > MAX_PLUGIN_PROMPT_CHARS) {
      console.warn(`[plugins] ${fullId} 提示词超过 ${MAX_PLUGIN_PROMPT_CHARS} 字符，已截断`);
      return {
        content: normalized.slice(0, MAX_PLUGIN_PROMPT_CHARS),
        complete: false,
      };
    }
    return {
      content: normalized,
      complete: true,
    };
  } catch (error) {
    console.warn(`[plugins] ${fullId} 提示词生成失败，已跳过`, error);
    return { content: "", complete: false };
  } finally {
    if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
  }
}

export function createPluginPromptRegistry(): PluginPromptRegistry {
  const entries = new Map<string, PromptEntry>();
  const stableEntries = new Map<string, StablePromptEntry>();

  const buildDetailed = async (input: PluginPromptBuildInput): Promise<PluginPromptBuildResult> => {
    // 先拍快照再并行执行：显式 priority 跨插件排序，同值保持注册顺序。
    const snapshot = [...entries.values()]
      .filter((entry) => {
        if (entry.signal.aborted) return false;
        if ((entry.provider.target ?? "soul") !== (input.target ?? "soul")) return false;
        if (!(entry.provider.sources ?? LEGACY_PROMPT_SOURCES).includes(input.source)) return false;
        if (input.source === "moments-post") return true;
        return !entry.provider.modes || entry.provider.modes.includes(input.mode);
      })
      .sort((left, right) => (left.provider.priority ?? 0) - (right.provider.priority ?? 0));
    const contributions = await Promise.all(snapshot.map((entry) => resolveProvider(entry, input)));
    const blocks: string[] = [];
    const receipts: PluginPromptReceipt[] = [];
    let limitedChars = 0;
    for (let index = 0; index < snapshot.length; index += 1) {
      const contribution = contributions[index];
      if (!contribution.content) continue;
      const entry = snapshot[index];
      const fullId = fullProviderId(entry.ownerId, entry.provider.id);
      const localCompanion = usesLocalCompanionPromptContract(entry, input);
      const separator = blocks.length > 0 ? (localCompanion ? "\n\n" : "\n\n---\n\n") : "";
      if (localCompanion) {
        blocks.push(separator + contribution.content);
        if (entry.provider.consumptionReceipt && input.runId) {
          receipts.push({
            providerId: fullId,
            acceptedChars: contribution.content.length,
            complete: contribution.complete,
          });
        }
        continue;
      }
      const header = `[插件上下文：${fullId}]\n`;
      const remaining = MAX_PLUGIN_PROMPT_TOTAL_CHARS - limitedChars - separator.length - header.length;
      if (remaining <= 0) {
        console.warn(`[plugins] 插件提示词总长度超过 ${MAX_PLUGIN_PROMPT_TOTAL_CHARS} 字符，已忽略后续内容`);
        break;
      }
      const accepted = contribution.content.slice(0, remaining);
      blocks.push(separator + header + accepted);
      limitedChars += separator.length + header.length + accepted.length;
      if (entry.provider.consumptionReceipt && input.runId) {
        receipts.push({
          providerId: fullId,
          acceptedChars: accepted.length,
          complete: contribution.complete && accepted.length === contribution.content.length,
        });
      }
      if (accepted.length < contribution.content.length) {
        console.warn(`[plugins] 插件提示词总长度超过 ${MAX_PLUGIN_PROMPT_TOTAL_CHARS} 字符，已截断`);
        break;
      }
    }
    return { content: blocks.join(""), receipts };
  };

  return {
    register(ownerId, provider, signal) {
      if (!provider || typeof provider !== "object") {
        throw new Error("插件提示词 Provider 必须是对象");
      }
      if (!PROMPT_ID_RE.test(provider.id)) {
        throw new Error(`非法插件提示词 Provider id: ${provider.id}`);
      }
      if (typeof provider.provide !== "function") {
        throw new Error("插件提示词 Provider 必须提供 provide() 函数");
      }
      if (provider.priority !== undefined && (!Number.isSafeInteger(provider.priority)
        || provider.priority < -1_000 || provider.priority > 1_000)) {
        throw new Error("提示词 Provider priority 必须是 -1000 至 1000 的安全整数");
      }
      if (provider.consumptionReceipt !== undefined && typeof provider.consumptionReceipt !== "boolean") {
        throw new Error("提示词 Provider consumptionReceipt 必须为布尔值");
      }
      if (provider.target !== undefined && provider.target !== "soul" && provider.target !== "tool") {
        throw new Error("提示词 Provider target 非法");
      }
      if (provider.modes && (
        !Array.isArray(provider.modes)
        || provider.modes.some((mode) => !["chat", "work", "learn", "code"].includes(mode))
      )) {
        throw new Error("插件提示词 Provider modes 含未知模式");
      }
      // sources 是显式场景声明：必须为非空数组且只含合法场景字面量，
      // 否则拼写错误会静默失效，插件作者难以排查。
      // 用存在性判断而非真值判断：false/0 等假值同样非法，必须在注册时拒绝，
      // 而不是留到构建过滤的 includes() 处抛 TypeError 炸掉整个 registry。
      if (provider.sources !== undefined && (
        !Array.isArray(provider.sources)
        || provider.sources.length === 0
        || provider.sources.some((source) => !["conversation", "scheduler", "moments-post", "plugin-agent"].includes(source))
      )) {
        throw new Error(`插件提示词 Provider sources 非法: ${JSON.stringify(provider.sources)}`);
      }
      const fullId = fullProviderId(ownerId, provider.id);
      if (entries.has(fullId)) {
        throw new Error(`插件提示词 Provider 已注册: ${provider.id}`);
      }
      entries.set(fullId, { ownerId, provider, signal });
    },

    unregister(ownerId, providerId) {
      return entries.delete(fullProviderId(ownerId, providerId));
    },

    async build(input) { return (await buildDetailed(input)).content; },

    buildDetailed,

    registerStable(ownerId, provider, signal) {
      if (!provider || typeof provider !== "object" || !PROMPT_ID_RE.test(provider.id)) {
        throw new Error(`非法插件稳定提示词 Provider id: ${provider?.id}`);
      }
      if (typeof provider.provide !== "function") {
        throw new Error("插件稳定提示词 Provider 必须提供 provide() 函数");
      }
      if (provider.modes && (
        !Array.isArray(provider.modes)
        || provider.modes.some((mode) => !["chat", "work", "learn", "code"].includes(mode))
      )) {
        throw new Error("插件稳定提示词 Provider modes 含未知模式");
      }
      if (provider.target !== undefined
        && provider.target !== "soul"
        && provider.target !== "tool"
        && provider.target !== "tone"
        && provider.target !== "soul-tail") {
        throw new Error("插件稳定提示词 Provider target 非法");
      }
      const fullId = fullProviderId(ownerId, provider.id);
      if (stableEntries.has(fullId)) throw new Error(`插件稳定提示词 Provider 已注册: ${provider.id}`);
      stableEntries.set(fullId, { ownerId, provider, signal });
    },

    unregisterStable(ownerId, providerId) {
      return stableEntries.delete(fullProviderId(ownerId, providerId));
    },

    async buildStable(input) {
      const snapshot = [...stableEntries.values()].filter((entry) => (
        !entry.signal.aborted
        && (!entry.provider.modes || entry.provider.modes.includes(input.mode))
        && (entry.provider.target ?? "soul") === (input.target ?? "soul")
      ));
      const contents = await Promise.all(snapshot.map(async (entry) => {
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        try {
          const content = await Promise.race([
            Promise.resolve(entry.provider.provide({ ...input, signal: entry.signal })),
            new Promise<never>((_, reject) => {
              timeoutHandle = setTimeout(
                () => reject(new Error(`稳定提示词 Provider 超时（${PLUGIN_PROMPT_PROVIDER_TIMEOUT_MS}ms）`)),
                PLUGIN_PROMPT_PROVIDER_TIMEOUT_MS,
              );
            }),
          ]);
          return typeof content === "string" ? content.trim().slice(0, MAX_PLUGIN_PROMPT_CHARS) : "";
        } catch (error) {
          console.warn(`[plugins] ${fullProviderId(entry.ownerId, entry.provider.id)} 稳定提示词生成失败，已跳过`, error);
          return "";
        } finally {
          if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        }
      }));
      return contents.filter(Boolean).join("\n\n---\n\n").slice(0, MAX_PLUGIN_PROMPT_TOTAL_CHARS);
    },

    clear() {
      entries.clear();
      stableEntries.clear();
    },
  };
}

export const pluginPromptRegistry = createPluginPromptRegistry();
