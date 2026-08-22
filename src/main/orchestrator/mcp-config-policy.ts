import type { McpServerConfig } from "./mcp-adapter";

export const PRIVILEGED_EXTERNAL_POLICY = {
  risk: "shell",
  effectKind: "external_side_effect",
} as const;

/** IPC 输入不是信任边界；renderer 不能给第三方 MCP 自行声明低风险。 */
export function sanitizeRendererMcpConfig(input: unknown): McpServerConfig {
  const raw = input && typeof input === "object" ? input as Record<string, unknown> : {};
  return {
    id: typeof raw.id === "string" ? raw.id : "",
    name: typeof raw.name === "string" ? raw.name : "",
    transport: raw.transport === "sse" ? "sse" : "stdio",
    command: typeof raw.command === "string" ? raw.command : undefined,
    args: Array.isArray(raw.args) ? raw.args.filter((v): v is string => typeof v === "string") : undefined,
    env: raw.env && typeof raw.env === "object"
      ? Object.fromEntries(
          Object.entries(raw.env as Record<string, unknown>)
            .filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        )
      : undefined,
    cwd: typeof raw.cwd === "string" ? raw.cwd : undefined,
    url: typeof raw.url === "string" ? raw.url : undefined,
    defaultToolPolicy: PRIVILEGED_EXTERNAL_POLICY,
  };
}

/** 兼容升级前已落盘的两个内置 MCP；用户自定义项保持原样并 fail closed。 */
export function applyKnownBuiltinMcpPolicy(config: McpServerConfig): McpServerConfig {
  if (config.defaultToolPolicy) return config;
  if (config.id === "playwright-mcp") {
    return {
      ...config,
      defaultToolPolicy: { risk: "input-control", effectKind: "external_side_effect" },
    };
  }
  if (config.id === "minimax-web-search") {
    return {
      ...config,
      defaultToolPolicy: { risk: "network", effectKind: "read" },
    };
  }
  return config;
}
