// 工具注册表 — 统一管理所有可被 LLM Router 调度的工具
// Worldbook 不在此注册，它走独立常驻检索路径

import { searchMemory } from "../rag/index";
import type { ToolRiskLevel } from "../permission";
import type { ToolContext } from "./tool-context";
import type { ConversationMode } from "../../shared/chat-types";

/** 工具效果类型：决定工具对系统状态的影响分类。未配置默认 "unknown"。 */
export type ToolEffectKind =
  | "read"
  | "mutation"
  | "verification"
  | "external_side_effect"
  | "unknown";

/** 验证策略：决定 mutation 工具需要何种验证。 */
export type VerificationPolicy = "none" | "artifact" | "code" | "unknown";

/** 动态效果解析器：根据参数判断效果类型（如 run_shell 根据 purpose）。 */
export type ToolEffectResolver = (args: Record<string, unknown>) => ToolEffectKind;

/** 工具并发安全判定：只返回严格 true 时，当前参数才可进入 Harness 并发池。 */
export type ToolConcurrencyClassifier = (args: Record<string, unknown>) => boolean;

/** 动态验证策略解析器：根据参数判断验证策略（如 write_file 根据文件扩展名）。 */
export type VerificationPolicyResolver = (args: Record<string, unknown>) => VerificationPolicy;

/** JSON Schema 片段：参数可以是简单类型，也可以是 array/object（含 items/properties）。 */
export type JsonSchemaProp =
  | { type: string; description?: string; enum?: string[]; default?: unknown; askAliases?: Record<string, unknown> }
  | { type: "array"; description?: string; items: JsonSchemaProp; default?: unknown; askAliases?: Record<string, unknown> }
  | { type: "object"; description?: string; properties: Record<string, JsonSchemaProp>; required?: string[]; default?: unknown; askAliases?: Record<string, unknown> };

/** 控制输入策略：简单字符串或带 kind 的对象形式 */
export type ControlledInputPolicy =
  | "context_ref"
  | "context_ref_array"
  | "tool_result"
  | { type: "context_ref"; kind: string }
  | { type: "context_ref_array"; kind: string }
  | { type: "tool_result" };

/** 从 ControlledInputPolicy 提取底层策略类型字符串 */
export function controlledInputType(policy: ControlledInputPolicy): string {
  return typeof policy === "string" ? policy : policy.type;
}

/** 从 ControlledInputPolicy 提取 expectedKind（如有） */
export function controlledInputKind(policy: ControlledInputPolicy): string | undefined {
  return typeof policy === "object" && "kind" in policy ? policy.kind : undefined;
}

export interface ToolDefinition {
  id: string;           // 工具唯一标识，如 "imported_docs"
  name: string;         // 展示名，如 "导入文档"
  description: string;  // 一句话描述，供 LLM Router 的 Prompt 使用
  /** 工具目录里展示的一句话用途（可选）。未填时回落 description 第一行。
   *  只用于运行时生成的工具目录，完整参数仍走 tools Schema。 */
  catalogHint?: string;
  /** 可选分类标签，第一期暂不强制使用。 */
  category?: string;
  /** 权限审批与执行记账使用的稳定能力标识；未填时回落到工具 id。 */
  capability?: string;
  /** Runtime 校验受控参数来源；这些值不能由模型自由编造。支持带 kind 的对象形式用于类型化引用验证。 */
  controlledInput?: Record<string, ControlledInputPolicy>;
  enabled: boolean;     // 用户是否启用（对应设置面板的开关）
  // 危险等级：决定该工具在哪些权限档位下可调用；不填默认 "safe"
  risk?: ToolRiskLevel;
  /** 工具暴露的会话模式白名单。未设置 = 全模式通用（向后兼容，行为不变）。
   *  仅 learn/code/work 三种模式参与过滤；chat 模式不暴露任何工具。
   *  注意：modes 是"默认推荐"，可被 ToolModeOverrides 覆盖。 */
  modes?: ConversationMode[];
  // MCP 兼容字段：参数 schema，后续接 MCP 时直接复用
  inputSchema: {
    type: "object";
    properties: Record<string, JsonSchemaProp>;
    required?: string[];
  };
  /** 工具若声明 needsContext，调度层执行时会传入 ToolContext。默认不声明=不传。 */
  needsContext?: boolean;
  /** Ledger 策略：success_terminal 缓存终态成功（默认），bypass 不缓存。 */
  ledgerPolicy?: "success_terminal" | "bypass";
  /** 标记为已废弃：从新运行的模型可用工具列表中隐藏，但保留注册用于旧会话兼容。 */
  deprecated?: boolean;
  /** 工具效果类型。未配置默认 "unknown"，不静默放行。 */
  effectKind?: ToolEffectKind;
  /** 动态效果解析器（覆盖 effectKind）。用于 run_shell 等根据参数判断效果的工具。 */
  effectResolver?: ToolEffectResolver;
  /**
   * 当前参数是否可与其他明确安全的调用并发。未声明、抛错或非 true 一律串行。
   * 此元数据仅供 Runtime 使用，不进入模型可见 Tool Schema。
   */
  isConcurrencySafe?: ToolConcurrencyClassifier;
  /** 验证策略。mutation 工具必须显式配置；未配置视为 "unknown"。 */
  verificationPolicy?: VerificationPolicy;
  /** 动态验证策略解析器（覆盖 verificationPolicy）。用于 write_file 根据文件扩展名判断。 */
  verificationPolicyResolver?: VerificationPolicyResolver;
  // 执行器：内置工具指向本地函数，外部 MCP 工具指向 transport 调用
  execute: (args: Record<string, unknown>, ctx?: ToolContext) => Promise<string>;
}

/** 工具-模式覆盖层：用户自定义每个工具在每个会话模式下的可见性。
 *  key = toolId，value = { mode: enabled }。
 *  运行时优先级：覆盖层 > ToolDefinition.modes > 全模式可见。
 *  持久化在 general-settings.toolModeOverrides，由 UI 写入。 */
export type ToolModeOverrides = Record<string, Partial<Record<ConversationMode, boolean>>>;

export class ToolRegistry {
  private tools: Map<string, ToolDefinition> = new Map();

  register(tool: ToolDefinition): void {
    this.tools.set(tool.id, tool);
  }

  unregister(id: string): boolean {
    return this.tools.delete(id);
  }

  setEnabled(id: string, enabled: boolean): void {
    const tool = this.tools.get(id);
    if (tool) {
      tool.enabled = enabled;
    }
  }

  getEnabledTools(): ToolDefinition[] {
    return Array.from(this.tools.values()).filter(t => t.enabled && !t.deprecated);
  }

  /** 按会话模式过滤的启用工具列表。
   *  过滤规则（优先级从高到低）：
   *    1. tool.enabled && !deprecated（总开关 + 废弃过滤）
   *    2. 若 overrides[toolId][mode] 存在：用覆盖值（true=可见，false=隐藏）
   *    3. 否则按 modes 字段：!modes || modes.includes(mode)
   *  未声明 modes 且无覆盖的工具默认全模式可见——保持现有行为不变。 */
  getEnabledToolsForMode(mode: ConversationMode, overrides?: ToolModeOverrides): ToolDefinition[] {
    return Array.from(this.tools.values()).filter((t) => {
      if (!t.enabled || t.deprecated) return false;
      const override = overrides?.[t.id]?.[mode];
      if (override !== undefined) return override;
      return !t.modes || t.modes.includes(mode);
    });
  }

  getAllTools(): ToolDefinition[] {
    return Array.from(this.tools.values());
  }

  getById(id: string): ToolDefinition | undefined {
    return this.tools.get(id);
  }
}

// 全局单例
export const toolRegistry = new ToolRegistry();

// ── 效果与验证策略解析 ────────────────────────────────────

/** 解析工具效果类型：优先使用 effectResolver，其次 effectKind，默认 "unknown"。 */
export function resolveEffectKind(
  tool: ToolDefinition | undefined,
  args: Record<string, unknown>,
): ToolEffectKind {
  if (!tool) return "unknown";
  if (tool.effectResolver) return tool.effectResolver(args);
  return tool.effectKind ?? "unknown";
}

/** 解析验证策略：优先使用 verificationPolicyResolver，其次 verificationPolicy，默认 "none"。 */
export function resolveVerificationPolicy(
  tool: ToolDefinition | undefined,
  args: Record<string, unknown>,
): VerificationPolicy {
  if (!tool) return "none";
  if (tool.verificationPolicyResolver) return tool.verificationPolicyResolver(args);
  return tool.verificationPolicy ?? "none";
}

// ── 注册内置工具 ──────────────────────────────────────────

function formatMemoryResult(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const record = result as { text?: unknown; entry?: { text?: unknown } };
  if (typeof record.entry?.text === "string") return record.entry.text;
  if (typeof record.text === "string") return record.text;
  return "";
}

toolRegistry.register({
  id: 'imported_docs',
  name: '导入文档',
  description:
    '在用户上传导入的文档/小说/文件范围内做语义检索，返回相关片段。\n\n' +
    '何时用：\n' +
    '- 用户提到「文件」「文档」「小说」，或消息包含「已上传文件」标记\n' +
    '- 用户问的内容可能在导入的文档里\n' +
    '- 用户要「在文档里找 xxx」「小说里有没有写到 yyy」\n\n' +
    '不要用于：\n' +
    '- 本机任意路径的文件（那是 read_file）\n' +
    '- 用户的历史对话记忆（那是 user_memory）\n' +
    '- 联网信息（那是 web_search）\n\n' +
    '参数：query (必填，搜索关键词)，topK (可选，返回条数，默认5)。',
  enabled: true,
  effectKind: "read",
  verificationPolicy: "none",
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      topK:  { type: 'number', description: '返回条数，默认5' },
    },
    required: ['query'],
  },
  execute: async (args) => {
    const results = await searchMemory(String(args.query), 'imported_doc', Number(args.topK) || 5);
    return results.map((r: unknown) => String(r)).join('\n');
  },
});

toolRegistry.register({
  id: 'user_memory',
  name: '用户记忆',
  description:
    '查询用户的历史记忆、个人信息、过往对话中提到的事实。\n\n' +
    '何时用：\n' +
    '- 用户说「你还记得」「我之前说过」「以前」「上次」等指代词\n' +
    '- 用户问自己的偏好/习惯/背景（「我喜欢什么」「我是做什么的」）\n' +
    '- 需要确认用户曾经提过的具体信息\n\n' +
    '不要用于：\n' +
    '- 当前对话最近几轮能看到的内容\n' +
    '- 导入文档内容（那是 imported_docs）\n' +
    '- 用户从没提过的信息（查不到就老实说不知道）\n\n' +
    '参数：query (必填，搜索关键词)，topK (可选，返回条数，默认5)。',
  enabled: true,
  effectKind: "read",
  verificationPolicy: "none",
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词' },
      topK:  { type: 'number', description: '返回条数，默认5' },
    },
    required: ['query'],
  },
  execute: async (args) => {
    const results = await searchMemory(String(args.query), 'user_memory', Number(args.topK) || 5);
    return results.map(formatMemoryResult).filter(Boolean).join('\n');
  },
});

