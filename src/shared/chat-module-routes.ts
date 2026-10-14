export const MODULE_REASONING = ["auto", "off", "on", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ModuleReasoning = typeof MODULE_REASONING[number];
export const CHAT_MODULES = {
  soul: "Chat 最终回复（Soul）", proactive: "主动消息 · 内容生成", proactiveDecision: "主动消息 · 发送判定", tools: "Chat 工具阶段",
  vision: "图片与屏幕理解", memory: "记忆判定与提炼", reflection: "记忆反思",
  compression: "记忆与历史压缩", resolver: "记忆冲突复核", retrieval: "检索查询理解",
  social: "社交上下文提炼", cita: "CITA 指代理解", moments: "动态生成与回应",
  voice: "语音对话与摘要", translation: "翻译工具", plugin: "插件生成（含自定义线路）",
  scheduled: "后台定时任务",
  observer: "心情观察",
} as const;
export type ChatModule = keyof typeof CHAT_MODULES;
export interface ChatModuleRoutes {
  version: 1;
  routes: Record<ChatModule, "main" | "oauth">;
  models?: Partial<Record<ChatModule, string>>;
  reasoning?: Partial<Record<ChatModule, ModuleReasoning>>;
}
export function defaultChatModuleRoutes(): ChatModuleRoutes {
  return { version: 1, routes: Object.fromEntries(Object.keys(CHAT_MODULES).map(key => [key, "main"])) as ChatModuleRoutes["routes"] };
}
export function validateChatModuleRoutes(value: unknown): ChatModuleRoutes {
  let input = value as ChatModuleRoutes | undefined;
  // Older files used one shared proactive model. Preserve that behavior on read.
  if (input?.version === 1 && input.routes && !Object.hasOwn(input.routes, "proactiveDecision")) {
    input = { ...input, routes: { ...input.routes, proactiveDecision: input.routes.proactive },
      ...(input.models ? { models: { ...input.models, ...(input.models.proactive ? { proactiveDecision: input.models.proactive } : {}) } } : {}),
      ...(input.reasoning ? { reasoning: { ...input.reasoning, ...(input.reasoning.proactive ? { proactiveDecision: input.reasoning.proactive } : {}) } } : {}) };
  }
  if (!input || input.version !== 1 || !input.routes || Object.keys(input.routes).length !== Object.keys(CHAT_MODULES).length
    || Object.entries(input.routes).some(([key, route]) => !Object.hasOwn(CHAT_MODULES, key) || !["main", "oauth"].includes(route))) {
    throw new Error("模块分工配置无效");
  }
  if (input.models !== undefined && (!input.models || typeof input.models !== "object" || Array.isArray(input.models)
    || Object.entries(input.models).some(([key, model]) => !Object.hasOwn(CHAT_MODULES, key) || typeof model !== "string" || !model.trim() || model.length > 256))) throw new Error("模块模型配置无效");
  if (input.reasoning !== undefined && (!input.reasoning || typeof input.reasoning !== "object" || Array.isArray(input.reasoning)
    || Object.entries(input.reasoning).some(([key, value]) => !Object.hasOwn(CHAT_MODULES, key) || !MODULE_REASONING.includes(value)))) throw new Error("模块思考强度配置无效");
  return { version: 1, routes: { ...input.routes }, ...(input.models ? { models: { ...input.models } } : {}), ...(input.reasoning ? { reasoning: { ...input.reasoning } } : {}) };
}
