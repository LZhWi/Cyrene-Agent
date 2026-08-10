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

export function buildSystemPrompt(styleFile: string, includeStyle = true): string {
  const parts: string[] = [];

  // Chat 模式使用独立基础规则；仍兼容旧调用方传入的 "talk"。
  const isChatMode = styleFile.startsWith("chat") || styleFile.startsWith("talk");
  const isLearnMode = styleFile.startsWith("learn");

  let systemFile: string;
  let identityFile: string;
  if (isChatMode) {
    systemFile = "chat_system.md";
    identityFile = "chat_identity.md";
  } else if (isLearnMode) {
    systemFile = "learn_system.md";
    identityFile = "learn_identity.md";
  } else {
    systemFile = "work_system.md";
    identityFile = "work_identity.md";
  }

  const system = loadPromptFile(systemFile);
  if (system) parts.push(system);

  // Code 模式（work 分支）额外加载 work_remark.md + code_system.md + code_remark.md
  if (!isChatMode && !isLearnMode) {
    const workRemark = loadPromptFile("work_remark.md");
    if (workRemark) parts.push(workRemark);
    const codeSystem = loadPromptFile("code_system.md");
    if (codeSystem) parts.push(codeSystem);
    const codeRemark = loadPromptFile("code_remark.md");
    if (codeRemark) parts.push(codeRemark);
  }

  const identity = loadPromptFile(identityFile);
  if (identity) parts.push(identity);

  const soul = loadPromptFile("soul.md");
  if (soul) parts.push(soul);

  const canon = loadPromptFile("canon_quotes.md");
  if (canon) parts.push(canon);

  // 新链路由 build-options 独立注入 style Prompt；旧调用方仍可选择在这里附加 style 文件。
  // Learn 模式使用独立的身份与人格体系，不附加 work 风格文件。
  if (includeStyle && !isChatMode && !isLearnMode) {
    const style = loadPromptFile("styles/" + styleFile);
    if (style) parts.push(style);
  }

  return parts.join("\n\n---\n\n");
}

/**
 * 工具阶段使用的 system prompt。
 * 第一期：固定 tools_system.md 规则 + 运行时生成的工具目录。
 * 不放任何人格 / 环境 / 记忆，避免人设污染工具决策。
 */
export function buildToolSystemPrompt(enabledTools: ReadonlyArray<ToolDefinition>, isOptimizedFirstRound?: boolean): string {
  const base = loadPromptFile(isOptimizedFirstRound ? "tools_system_optimized_first.md" : "tools_system.md");
  const codeSystem = loadPromptFile("code_system.md");
  const codeRemark = loadPromptFile("code_remark.md");
  const catalog = buildToolCatalog(enabledTools as ToolDefinition[]);
  return [
    base,
    codeSystem,
    codeRemark,
    "## 当前可用工具",
    catalog,
  ].filter(Boolean).join("\n\n");
}

/**
 * Soul 阶段使用的基础 system prompt。
 * 包含：人设（work_system.md/chat_system.md + work_identity.md/chat_identity.md + soul.md + canon + style）+ 后续可追加的环境/记忆等。
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
