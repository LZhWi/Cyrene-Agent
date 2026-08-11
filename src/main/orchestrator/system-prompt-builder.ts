import fs from "node:fs";
import path from "node:path";
import { app } from "electron";
import { loadPromptFile } from "../prompts/prompt-loader";
import {
  STYLE_FILE_BY_ID,
  resolveStylePreference,
  type CustomStyleConfig,
  type StyleId,
} from "../../shared/style-sampling";
import { ensureCustomStylePrompt } from "../style-prompt";
import { getCapabilityOrOpenAI } from "./vendors/capabilities";
import { resolveApprovedStyleSampling } from "./vendors/style-sampling";
import type { ReasoningPreference } from "../../shared/reasoning";
import { buildToolCatalog } from "./tool-catalog";
import type { ToolDefinition } from "./tool-registry";
import type { ConversationMode } from "../../shared/chat-types";
import { buildModePrompt } from "./mode-prompt-profile";

export function readStylePrompt(styleId: StyleId): string {
  if (styleId === "custom") {
    const filePath = ensureCustomStylePrompt();
    return fs.readFileSync(filePath, "utf8").trim();
  }
  return loadPromptFile("styles/" + STYLE_FILE_BY_ID[styleId]);
}

export function resolveSoulSamplingForStyle(input: {
  styleId: StyleId;
  settings: { provider: string; model: string; reasoning?: ReasoningPreference };
  customStyle: CustomStyleConfig;
}) {
  const capability = getCapabilityOrOpenAI(input.settings.provider);
  const preference = resolveStylePreference(input.styleId, input.customStyle);
  return resolveApprovedStyleSampling({
    providerId: capability.id,
    model: input.settings.model,
    reasoning: input.settings.reasoning ?? { mode: "auto" },
    preference,
  });
}

/**
 * @deprecated 新运行链路必须使用 buildModePrompt(mode)。
 * 仅供尚未迁移的调用方兼容，绝不再根据 Work 默认拼接 Code 或 soul。
 */
export function buildSystemPrompt(styleFile: string, includeStyle = true): string {
  const mode: ConversationMode = styleFile.startsWith("chat") || styleFile.startsWith("talk")
    ? "chat"
    : styleFile.startsWith("learn")
      ? "learn"
      : "work";
  const parts = [buildModePrompt(mode)];

  // 风格采样提示词是历史调用方的可选附加项；生产运行链路在 build-options 单独注入。
  if (includeStyle && mode === "work") {
    const style = loadPromptFile("styles/" + styleFile);
    if (style) parts.push(style);
  }

  return parts.filter(Boolean).join("\n\n---\n\n");
}

/**
 * 工具阶段使用的 system prompt。
 * 第一期：固定 tools_system.md 规则 + 运行时生成的工具目录。
 * 不放任何人格 / 环境 / 记忆，避免人设污染工具决策。
 */
export function buildToolSystemPrompt(
  _mode: ConversationMode,
  enabledTools: ReadonlyArray<ToolDefinition>,
  isOptimizedFirstRound?: boolean,
): string {
  const base = loadPromptFile(isOptimizedFirstRound ? "tools_system_optimized_first.md" : "tools_system.md");
  const catalog = buildToolCatalog(enabledTools as ToolDefinition[]);
  return [
    base,
    "## 当前可用工具",
    catalog,
  ].filter(Boolean).join("\n\n");
}

/**
 * Soul 阶段使用的基础 system prompt。
 * 包含：按模式选取的人设基础 + 后续可追加的环境/记忆等。
 * 注意：工具结果（`role: "tool"` 消息）在 conversation 中已携带，本函数不重复注入。
 * 第一期：build-options 会把 environmentContext / skillCatalog / toneInjection /
 * alwaysOnContext / relationshipContext / attachmentContext 等都拼到 baseContent 末尾，
 * 后续第二期再拆分为 toolEnvironmentContext / soulEnvironmentContext。
 */
export function buildSoulSystemBasePrompt(styleFile: string): string {
  return buildSystemPrompt(styleFile, false);
}

export function loadSoulFeelingContext(): string {
  try {
    const soulPath = path.join(app.getAppPath(), "prompts", "soul.md");
    if (!fs.existsSync(soulPath)) return "";
    return fs.readFileSync(soulPath, "utf8");
  } catch {
    return "";
  }
}
