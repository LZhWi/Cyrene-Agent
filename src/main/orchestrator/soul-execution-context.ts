/**
 * Soul Execution Context -- 通用执行投影层。
 *
 * 将 ToolCallResult 投影为 Soul 可安全使用的结构化上下文。
 * 优先使用 toolRegistry 中显式声明的 soulProjection；未声明的工具会走自动 fallback，
 * 提取关键字段或安全摘要，避免“执行成功但无话可说”。
 *
 * 核心原则：
 * - actions 只证明某个工具调用真实发生过
 * - projections 是工具返回中允许 Soul 直接引用或总结的信息
 * - executionStatus=succeeded ≠ 业务动作完成 ≠ 用户目标完成
 */

import type { ToolCallResult } from "./types";
import type { ToolDefinition } from "./tool-registry";

// ── 尺寸限制 ──────────────────────────────────────────────

const MAX_PROJECTION_ITEMS = 10;
const MAX_ATTRIBUTES_PER_ITEM = 8;
const MAX_STRING_LENGTH = 500;
const MAX_ARRAY_ITEMS = 10;
const MAX_TOTAL_PROJECTION_LENGTH = 12_000;

// ── 控制标签转义 ──────────────────────────────────────────

const CONTROL_TAGS = [
  "SOUL_PHASE_RULES",
  "SOUL_EXECUTION_CONTEXT",
  "ACTION_DECISION",
  "CLARIFICATION_ANSWERS",
  "TOOL_EXECUTION_CONTEXT",
  "FAILURE_SOUL_POLICY",
  "RESPONSE_CONTEXT",
];

const controlTagPattern = new RegExp(
  `\\[/?(?:${CONTROL_TAGS.join("|")})\\]`,
  "g",
);

function escapeControlTags(text: string): string {
  return text.replace(controlTagPattern, (match) =>
    match.replace(/\[/g, "［").replace(/\]/g, "］"),
  );
}

// ── 路径安全 ──────────────────────────────────────────────

const FORBIDDEN_SEGMENTS = new Set(["__proto__", "prototype", "constructor"]);

function getValueByPath(obj: unknown, path: string): unknown {
  if (!path) return obj;
  const segments = path.split(".");
  let current: unknown = obj;
  for (const segment of segments) {
    if (FORBIDDEN_SEGMENTS.has(segment)) return undefined;
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current;
}

// ── 值清洗 ────────────────────────────────────────────────

type ProjectionValue = string | number | boolean | string[];

function sanitizeString(value: string): string {
  const escaped = escapeControlTags(value);
  return escaped.length > MAX_STRING_LENGTH ? escaped.slice(0, MAX_STRING_LENGTH) : escaped;
}

function sanitizeValue(value: unknown): ProjectionValue | undefined {
  if (typeof value === "string") return sanitizeString(value);
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
    const escaped = value.map(sanitizeString);
    return escaped.length > MAX_ARRAY_ITEMS
      ? escaped.slice(0, MAX_ARRAY_ITEMS)
      : escaped;
  }
  return undefined;
}

// ── 类型定义 ──────────────────────────────────────────────

export type ProjectionSource = "trusted_internal" | "external_untrusted";

export type SoulClaimKind =
  | "request_dispatched"
  | "browser_opened"
  | "file_created"
  | "message_sent"
  | "action_completed";

export type SoulClaim =
  | { kind: "request_dispatched" }
  | { kind: "browser_opened" }
  | { kind: "file_created" }
  | { kind: "message_sent" }
  | { kind: "action_completed"; action: string };

export type SoulProjectionConfig =
  | {
      projector: "entity_list";
      source: ProjectionSource;
      itemsPath: string;
      fields: Record<string, string>;
      maxItems?: number;
    }
  | {
      projector: "entity_detail";
      source: ProjectionSource;
      entityPath?: string;
      fields: Record<string, string>;
    }
  | {
      projector: "action_dispatch";
      source: ProjectionSource;
      statePath: string;
      stateClaims: Record<string, SoulClaim>;
    }
  | {
      projector: "action_completed";
      source: ProjectionSource;
      claim: SoulClaim;
      confirmation: { kind: "tool_status" };
    }
  | {
      projector: "action_completed";
      source: ProjectionSource;
      claim: SoulClaim;
      confirmation: { kind: "output_field"; path: string; values: Array<string | number | boolean> };
    }
  | {
      /** Extracts the established local "已生成：<absolute path>" document-tool contract. */
      projector: "artifact_path";
      source: "trusted_internal";
      kind?: string;
    };

export type SoulProjection =
  | {
      kind: "entity_list";
      source: ProjectionSource;
      items: Array<{
        title?: string;
        attributes?: Record<string, ProjectionValue>;
      }>;
      truncated?: boolean;
    }
  | {
      kind: "entity_detail";
      source: ProjectionSource;
      title?: string;
      attributes: Record<string, ProjectionValue>;
    }
  | {
      kind: "action_dispatch";
      source: ProjectionSource;
      state: string;
      claim: SoulClaim;
    }
  | {
      kind: "action_completed";
      source: ProjectionSource;
      claim: SoulClaim;
    };

export interface SoulAction {
  /** 安全语义名称；未配置 soulActionLabel 时不输出此字段 */
  actionLabel?: string;
  executionStatus: "succeeded" | "failed" | "denied" | "cancelled" | "timed_out";
  terminal: boolean;
  errorCode?: string;
  userSafeMessage?: string;
}

export interface SoulExecutionContext {
  actions: SoulAction[];
  projections: SoulProjection[];
}

// ── 通用错误消息 ──────────────────────────────────────────

const COMMON_ERROR_MESSAGES: Record<string, string> = {
  E_PERMISSION_DENIED: "权限不足，需要用户授权",
};

function resolveUserSafeMessage(
  errorCode: string | undefined,
  tool: ToolDefinition | undefined,
): string | undefined {
  if (!errorCode) return undefined;
  return (
    tool?.soulErrorMessages?.[errorCode] ??
    COMMON_ERROR_MESSAGES[errorCode] ??
    "执行失败"
  );
}

function mapExecutionStatus(
  result: ToolCallResult,
): SoulAction["executionStatus"] {
  if (result.status === "succeeded") return "succeeded";
  if (result.errorCode === "E_PERMISSION_DENIED") return "denied";
  return "failed";
}

// ── 投影器 ────────────────────────────────────────────────

function projectEntityList(
  parsed: unknown,
  config: Extract<SoulProjectionConfig, { projector: "entity_list" }>,
): SoulProjection | undefined {
  const rawItems = getValueByPath(parsed, config.itemsPath);
  if (!Array.isArray(rawItems)) return undefined;

  const limit = Math.min(config.maxItems ?? MAX_PROJECTION_ITEMS, MAX_PROJECTION_ITEMS);
  const truncated = rawItems.length > limit;
  const items = rawItems.slice(0, limit).map((item): {
    title?: string;
    attributes?: Record<string, ProjectionValue>;
  } | undefined => {
    const titleRaw = config.fields["title"]
      ? getValueByPath(item, config.fields["title"])
      : undefined;
    const title = typeof titleRaw === "string" ? sanitizeString(titleRaw) : undefined;

    const attributes: Record<string, ProjectionValue> = {};
    let attrCount = 0;
    for (const [projName, srcPath] of Object.entries(config.fields)) {
      if (projName === "title") continue;
      if (attrCount >= MAX_ATTRIBUTES_PER_ITEM) break;
      const value = sanitizeValue(getValueByPath(item, srcPath));
      if (value !== undefined) {
        attributes[projName] = value;
        attrCount++;
      }
    }

    if (title === undefined && attrCount === 0) return undefined;
    return {
      ...(title !== undefined ? { title } : {}),
      ...(attrCount > 0 ? { attributes } : {}),
    };
  }).filter((item): item is NonNullable<typeof item> => item !== undefined);

  if (items.length === 0) return undefined;
  return {
    kind: "entity_list",
    source: config.source,
    items,
    ...(truncated ? { truncated: true } : {}),
  };
}

function projectEntityDetail(
  parsed: unknown,
  config: Extract<SoulProjectionConfig, { projector: "entity_detail" }>,
): SoulProjection | undefined {
  const entity = config.entityPath ? getValueByPath(parsed, config.entityPath) : parsed;
  if (entity === null || entity === undefined || typeof entity !== "object") return undefined;

  const titleRaw = config.fields["title"]
    ? getValueByPath(entity, config.fields["title"])
    : undefined;
  const title = typeof titleRaw === "string" ? sanitizeString(titleRaw) : undefined;

  const attributes: Record<string, ProjectionValue> = {};
  let attrCount = 0;
  for (const [projName, srcPath] of Object.entries(config.fields)) {
    if (projName === "title") continue;
    if (attrCount >= MAX_ATTRIBUTES_PER_ITEM) break;
    const value = sanitizeValue(getValueByPath(entity, srcPath));
    if (value !== undefined) {
      attributes[projName] = value;
      attrCount++;
    }
  }

  if (title === undefined && attrCount === 0) return undefined;
  return {
    kind: "entity_detail",
    source: config.source,
    ...(title !== undefined ? { title } : {}),
    attributes,
  };
}

function projectActionDispatch(
  parsed: unknown,
  config: Extract<SoulProjectionConfig, { projector: "action_dispatch" }>,
): SoulProjection | undefined {
  const state = getValueByPath(parsed, config.statePath);
  if (typeof state !== "string") return undefined;
  const claim = config.stateClaims[state];
  if (!claim) return undefined;
  return {
    kind: "action_dispatch",
    source: config.source,
    state,
    claim,
  };
}

function projectActionCompleted(
  result: ToolCallResult,
  parsed: unknown | undefined,
  config: Extract<SoulProjectionConfig, { projector: "action_completed" }>,
): SoulProjection | undefined {
  if (config.confirmation.kind === "tool_status") {
    if (result.status !== "succeeded") return undefined;
  } else {
    if (parsed === undefined) return undefined;
    const value = getValueByPath(parsed, config.confirmation.path);
    if (!config.confirmation.values.includes(value as string | number | boolean)) return undefined;
  }
  return {
    kind: "action_completed",
    source: config.source,
    claim: config.claim,
  };
}

function projectArtifactPath(
  result: ToolCallResult,
  config: Extract<SoulProjectionConfig, { projector: "artifact_path" }>,
): SoulProjection | undefined {
  const match = result.output.match(/^\[[\w-]+\]\s*已生成[：:]\s*(.+?)\s*$/);
  const path = match?.[1]?.trim();
  if (!path) return undefined;

  const safePath = sanitizeString(path);
  const filename = safePath.split(/[\\/]/).filter(Boolean).at(-1);
  const attributes: Record<string, ProjectionValue> = { path: safePath };
  if (config.kind) attributes.kind = config.kind;
  return {
    kind: "entity_detail",
    source: config.source,
    ...(filename ? { title: filename } : {}),
    attributes,
  };
}

function projectResult(
  result: ToolCallResult,
  config: SoulProjectionConfig,
): SoulProjection | undefined {
  if (config.projector === "artifact_path") {
    return projectArtifactPath(result, config);
  }
  // action_completed with tool_status 不需要解析 output
  if (config.projector === "action_completed" && config.confirmation.kind === "tool_status") {
    return projectActionCompleted(result, undefined, config);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(result.output);
  } catch {
    return undefined;
  }

  switch (config.projector) {
    case "entity_list":
      return projectEntityList(parsed, config);
    case "entity_detail":
      return projectEntityDetail(parsed, config);
    case "action_dispatch":
      return projectActionDispatch(parsed, config);
    case "action_completed":
      return projectActionCompleted(result, parsed, config);
  }
}

// ── 自动 fallback 投影器 ──────────────────────────────────

/** 匹配常见“已生成：/path/to/file”工具输出契约 */
function matchArtifactPath(output: string): string | undefined {
  const match = output.match(/^\[[\w-]+\]\s*已生成[：:]\s*(.+?)\s*$/);
  return match?.[1]?.trim();
}

/** 从普通对象中安全提取常见字段，作为 entity_detail 属性 */
function extractCommonFields(parsed: Record<string, unknown>): Record<string, ProjectionValue> | undefined {
  const commonFields = [
    "path",
    "filePath",
    "file",
    "url",
    "status",
    "success",
    "result",
    "data",
    "message",
    "count",
    "total",
    "title",
    "name",
  ];
  const attributes: Record<string, ProjectionValue> = {};
  let attrCount = 0;
  for (const field of commonFields) {
    if (attrCount >= MAX_ATTRIBUTES_PER_ITEM) break;
    const value = sanitizeValue(getValueByPath(parsed, field));
    if (value !== undefined) {
      attributes[field] = value;
      attrCount++;
    }
  }
  return attrCount > 0 ? attributes : undefined;
}

/** 当工具未配置 soulProjection 时，自动把结果投影给 Soul */
export function projectToolResultFallback(result: ToolCallResult): SoulProjection | undefined {
  if (result.status !== "succeeded") return undefined;

  const output = result.output;
  if (typeof output !== "string" || output.length === 0) return undefined;

  // 1. 优先匹配“已生成路径”这种内部可信契约
  const artifactPath = matchArtifactPath(output);
  if (artifactPath) {
    const safePath = sanitizeString(artifactPath);
    const filename = safePath.split(/[\\/]/).filter(Boolean).at(-1);
    const attributes: Record<string, ProjectionValue> = { path: safePath };
    return {
      kind: "entity_detail",
      source: "trusted_internal",
      ...(filename ? { title: filename } : {}),
      attributes,
    };
  }

  // 2. 尝试解析 JSON 提取常见字段
  let parsed: unknown;
  try {
    parsed = JSON.parse(output);
  } catch {
    parsed = undefined;
  }

  if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
    const attributes = extractCommonFields(parsed as Record<string, unknown>);
    if (attributes) {
      return {
        kind: "entity_detail",
        source: "external_untrusted",
        attributes,
      };
    }
  }

  // 3. 纯文本 fallback：安全摘要
  const summary = sanitizeString(output).trim();
  if (!summary) return undefined;
  return {
    kind: "entity_detail",
    source: "external_untrusted",
    attributes: {
      summary,
    },
  };
}

// ── 主构建函数 ────────────────────────────────────────────

/**
 * 对单个工具结果执行投影，返回 SoulProjection 或 undefined。
 * 供 Layer 2 (buildSoulExecutionContext) 和 planVerify 共享使用。
 * 优先使用 tool 声明的 soulProjection；无配置时走自动 fallback。
 */
export function projectToolResult(
  result: ToolCallResult,
  tool: ToolDefinition | undefined,
): SoulProjection | undefined {
  if (result.status !== "succeeded") return undefined;
  if (tool?.soulProjection) {
    return projectResult(result, tool.soulProjection);
  }
  return projectToolResultFallback(result);
}

export function buildSoulExecutionContext(
  results: ToolCallResult[],
  tools: ToolDefinition[],
): SoulExecutionContext {
  const toolMap = new Map(tools.map((t) => [t.id, t]));

  const actions: SoulAction[] = results.map((result) => {
    const tool = toolMap.get(result.toolId);
    const action: SoulAction = {
      executionStatus: mapExecutionStatus(result),
      terminal: result.terminal ?? true,
    };
    if (tool?.soulActionLabel) {
      action.actionLabel = tool.soulActionLabel;
    }
    if (result.errorCode) {
      action.errorCode = result.errorCode;
      action.userSafeMessage = resolveUserSafeMessage(result.errorCode, tool);
    }
    return action;
  });

  const projections: SoulProjection[] = [];
  let totalLength = 0;

  for (const result of results) {
    const tool = toolMap.get(result.toolId);
    const projection = projectToolResult(result, tool);
    if (!projection) continue;

    const serialized = JSON.stringify(projection);
    if (totalLength + serialized.length > MAX_TOTAL_PROJECTION_LENGTH) break;
    totalLength += serialized.length;
    projections.push(projection);
  }

  return { actions, projections };
}

// ── 输出格式化 ────────────────────────────────────────────

export function formatSoulExecutionContext(ctx: SoulExecutionContext): string {
  return [
    "[SOUL_EXECUTION_CONTEXT]",
    JSON.stringify(ctx),
    "[/SOUL_EXECUTION_CONTEXT]",
  ].join("\n");
}
