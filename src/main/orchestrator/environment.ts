// Step 1 — 环境注入
//
// 把"今天是几号 / 系统是什么 / 桌面在哪 / 当前权限档位 / 哪些工具可用"
// 这些模型本来要靠猜的事实，直接以 system 段落的形式喂给它。
// 这一层不解决"模型想不想调工具"，但能消掉"模型不知道桌面真实路径"
// 这一类低级幻觉，给后续的意图识别 + tool_choice 兜底打底。
//
// 输出格式刻意选择 Markdown 小节，方便 LLM 抓字段；同时在终端打印
// `[Env]` 日志便于排障。

import * as os from "os";
import { getRuntimePath } from "../runtime/runtime-paths";
import { toolRegistry } from "./tool-registry";
import { listMcpServers } from "./mcp-manager";
import { ACCESS_LEVEL_LABEL, getCurrentLevel, policyFor } from "../permission";
import type { ToolRiskLevel } from "../permission";
import { getCapability } from "./vendors/capabilities";

const LOG_PREFIX = "[Env]";

/** 当前模型信息（用于查 capability 判断视觉等能力），可选。 */
export interface ModelInfo {
  provider: string;
  model: string;
}

/** 用户信息片段（由 index.ts 注入，避免循环依赖）。 */
export interface UserInfoContext {
  nickname?: string;
  callPreference?: string;
  birthday?: string;
  defaultCity?: string;
  timezone?: string;
}

function safeGetPath(name: "desktop" | "documents" | "downloads" | "home"): string {
  try {
    return getRuntimePath(name);
  } catch (err) {
    console.warn(LOG_PREFIX, "getPath 失败:", name, err);
    return "";
  }
}

function formatDate(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const week = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"][d.getDay()];
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd} ${week} ${hh}:${min}`;
}

function platformLabel(): string {
  const p = process.platform;
  if (p === "win32") return `Windows (${os.release()})`;
  if (p === "darwin") return `macOS (${os.release()})`;
  if (p === "linux") return `Linux (${os.release()})`;
  return `${p} (${os.release()})`;
}

/**
 * 构造环境上下文，作为 system prompt 的尾段拼入。
 *
 * 注意：这里只读取既有运行时状态，不做任何副作用；调用方负责 try/catch
 * 拼接失败的情况，避免环境注入炸掉聊天主流程。
 */
export function buildEnvironmentContext(modelInfo?: ModelInfo, userInfo?: UserInfoContext): string {
  const level = getCurrentLevel();
  const levelLabel = ACCESS_LEVEL_LABEL[level];

  const desktop = safeGetPath("desktop");
  const documents = safeGetPath("documents");
  const downloads = safeGetPath("downloads");
  const home = safeGetPath("home");
  const username = os.userInfo().username;
  const dateStr = formatDate(new Date());
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";

  // 工具清单：按"启用 + 当前档位放行"两个维度过滤，让模型只看到当下能用的
  const allEnabled = toolRegistry.getEnabledTools();
  const allowedTools: string[] = [];
  const askTools: string[] = [];
  const deniedTools: string[] = [];
  for (const t of allEnabled) {
    const risk: ToolRiskLevel = t.risk ?? "safe";
    const verdict = policyFor(level, risk);
    if (verdict === "allow") allowedTools.push(`${t.id}(${risk})`);
    else if (verdict === "ask") askTools.push(`${t.id}(${risk})`);
    else deniedTools.push(`${t.id}(${risk})`);
  }

  // MCP server 状态
  let mcpLine = "未连接任何 MCP server";
  try {
    const servers = listMcpServers();
    if (servers.length > 0) {
      mcpLine = servers
        .map((s) => `${s.name}[${s.connected ? "已连接" : "未连接"}, ${s.toolCount} 工具]`)
        .join(", ");
    }
  } catch (err) {
    console.warn(LOG_PREFIX, "列 MCP server 失败:", err);
  }

  const lines: string[] = [];
  lines.push("## 运行环境（机器实际状态，不要再凭印象猜）");
  lines.push("");
  lines.push(`- 当前时间：${dateStr}（时区 ${tz}）`);
  lines.push(`- 操作系统：${platformLabel()}`);
  lines.push(`- 当前用户名：${username}`);
  if (home) lines.push(`- 用户主目录：${home}`);
  if (desktop) lines.push(`- 桌面路径：${desktop}`);
  if (documents) lines.push(`- 文档路径：${documents}`);
  if (downloads) lines.push(`- 下载路径：${downloads}`);
  lines.push("");
  lines.push(`- 文件权限档位：${levelLabel}（${level}）`);
  lines.push(`- 当前档位下可直接调用的工具：${allowedTools.length > 0 ? allowedTools.join(", ") : "（无）"}`);
  if (askTools.length > 0) {
    lines.push(`- 当前档位需先弹审批的工具：${askTools.join(", ")}`);
  }
  if (deniedTools.length > 0) {
    lines.push(`- 当前档位被拒绝的工具（提到也调不出）：${deniedTools.join(", ")}`);
  }
  lines.push(`- MCP 服务：${mcpLine}`);
  lines.push("");

  // 模型能力边界：把"你当前这个模型能不能看图"作为事实告诉模型，
  // 让它遇到图片问题时敢于说"我看不了"，而不是硬编。
  // 没传 modelInfo（比如降级路径）时保守地告诉它"看不了"。
  let supportsVision = false;
  if (modelInfo) {
    const cap = getCapability(modelInfo.provider);
    supportsVision = cap?.supportsVision ?? false;
  }
  lines.push(`- 当前模型是否支持查看图片：${supportsVision ? "支持（可调 read_image 看图）" : "不支持（看不了图片，遇到图片问题必须如实说明，不许编造图片内容）"}`);
  lines.push("");

  // 用户信息：昵称、称呼偏好、生日、默认城市等。让模型知道"在和谁说话、用户在哪"，
  // 避免每次问天气/位置都要反问用户。默认城市尤其重要——天气工具会用到。
  if (userInfo) {
    lines.push("## 用户信息");
    lines.push("");
    if (userInfo.callPreference) {
      lines.push(`- 称呼偏好：${userInfo.callPreference}（称呼用户时优先用这个）`);
    } else if (userInfo.nickname) {
      lines.push(`- 昵称：${userInfo.nickname}（称呼用户时用这个）`);
    }
    if (userInfo.birthday) lines.push(`- 生日：${userInfo.birthday}`);
    if (userInfo.defaultCity) lines.push(`- 默认城市：${userInfo.defaultCity}（用户问天气/位置且没指定其他城市时，默认用这个）`);
    if (userInfo.timezone && userInfo.timezone !== tz) lines.push(`- 用户时区：${userInfo.timezone}`);
    lines.push("");
  }

  lines.push(
    "当用户提到「桌面 / 文档 / 下载」却没给绝对路径时，使用上面这些真实路径拼接，再交给文件类工具；不要写 `~/Desktop` 或硬编码盘符。",
  );

  const text = lines.join("\n");

  console.log(
    LOG_PREFIX,
    `level=${level}`,
    `desktop=${desktop || "?"}`,
    `allowed=${allowedTools.length}`,
    `ask=${askTools.length}`,
    `deny=${deniedTools.length}`,
    `mcp=${mcpLine.startsWith("未连接") ? "none" : "active"}`,
    `vision=${supportsVision}`,
  );

  return text;
}

