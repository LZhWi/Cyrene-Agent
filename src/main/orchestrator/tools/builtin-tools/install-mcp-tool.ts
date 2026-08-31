// ── 工具 3：install_mcp_server ────────────────────────────
// 把一个 {command, args, env} 注册成新的 MCP server。
// agent 读完 README 的 mcpServers 配置后，调这个工具一次性写盘 + 启动 + 发现工具
//
// 原样迁自 built-in-tools.ts（纯搬移，逻辑未改）。注册方式调整：本模块导出
// installMcpServerTool 常量，由 built-in-tools.ts facade 在原注册位置统一
// toolRegistry.register，显式保证 registry 插入顺序（= 工具目录 prompt 生成顺序，
// 门禁见 built-in-tools.snapshot.test.ts）。

import type { ToolDefinition } from "../registry/tool-registry";
import { addMcpServer } from "../../mcp-manager";

const LOG_PREFIX = "[BuiltinTools]";

// ── 工具 3：install_mcp_server ────────────────────────────
// 把一个 {command, args, env} 注册成新的 MCP server。
// agent 读完 README 的 mcpServers 配置后，调这个工具一次性写盘 + 启动 + 发现工具

async function executeInstallMcp(args: Record<string, unknown>): Promise<string> {
  const id = (String(args.id || "").trim()) || ("mcp-" + Date.now());
  const name = String(args.name || "").trim() || id;
  const command = String(args.command || "").trim();
  if (!command) return "[错误] command 不能为空";

  const cmdArgs = Array.isArray(args.args) ? (args.args as unknown[]).map((x) => String(x)) : [];
  let env: Record<string, string> | undefined;
  if (args.env && typeof args.env === "object") {
    env = {};
    for (const [k, v] of Object.entries(args.env as Record<string, unknown>)) {
      env[k] = String(v);
    }
  }
  const cwd = args.cwd ? String(args.cwd) : undefined;

  console.log(LOG_PREFIX, "install_mcp_server:", id, name, command, JSON.stringify(cmdArgs).slice(0, 200));
  if (env) console.log(LOG_PREFIX, "  env keys:", Object.keys(env).join(","));
  if (cwd) console.log(LOG_PREFIX, "  cwd:", cwd);

  try {
    const result = await addMcpServer({
      id,
      name,
      transport: "stdio",
      command,
      args: cmdArgs,
      env,
      cwd,
    });
    if (!result.ok) {
      return "[错误] 安装失败: " + (result.error || "未知错误");
    }
    const tools = result.toolIds || [];
    return (
      "✅ MCP server \"" + name + "\" 已连接\n" +
      "id: " + id + "\n" +
      "command: " + command + (cmdArgs.length ? " " + cmdArgs.join(" ") : "") + "\n" +
      "发现 " + tools.length + " 个工具" + (tools.length ? "：\n  - " + tools.join("\n  - ") : "") + "\n" +
      "你现在可以让我用这些工具帮你做事。"
    );
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[错误] 安装异常: " + msg;
  }
}

export const installMcpServerTool: ToolDefinition = {
  id: "install_mcp_server",
  name: "安装 MCP",
  description:
    "把一个 MCP server 加到昔涟的工具盘里：写入配置 → 启动 → 发现工具。\n\n" +
    "何时用：\n" +
    "- 用户明确要装某个 MCP server（'帮我装 xxx mcp'）\n" +
    "- 用户给了 MCP 的 GitHub 仓库或配置\n\n" +
    "推荐流程：先用 fetch_url 读 README，找到 mcpServers 配置块" +
    "（command/args/env），再用本工具一次性安装。\n\n" +
    "不要用于：\n" +
    "- 日常工具调用（已注册的工具直接用）\n" +
    "- 系统软件安装（那是 run_shell 的活）\n\n" +
    "参数：id (可选，唯一标识，留空则用时间戳)，name (展示名)，command (可执行命令)，" +
    "args (字符串数组)，env (键值对，环境变量)，cwd (可选工作目录)。",
  enabled: true,
  risk: "fs-write",
  modes: ["code", "work"],
  effectKind: "mutation" as const,
  verificationPolicy: "artifact" as const,
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: "唯一标识，留空则自动生成" },
      name: { type: "string", description: "展示名，比如 'mail-mcp'" },
      command: { type: "string", description: "可执行命令，例如 'node' / 'pythonw' / 'npx'" },
      args: { type: "array", description: "命令行参数数组，例如 ['C:/.../bridging_mail_mcp.py']" },
      env: { type: "object", description: "环境变量键值对" },
      cwd: { type: "string", description: "工作目录绝对路径，可选" },
    },
    required: ["command"],
  },
  execute: executeInstallMcp,
};

