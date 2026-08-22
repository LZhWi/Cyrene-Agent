// MCP Adapter — 将 MCP server 的工具发现和调用适配到 ToolRegistry
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ToolDefinition, toolRegistry } from "./tool-registry";

const LOG_PREFIX = "[MCP Adapter]";

export const MCP_DEFAULT_CONNECT_TIMEOUT_MS = 15_000;
export const MCP_DEFAULT_TOOL_TIMEOUT_MS = 60_000;

export interface McpServerConfig {
  id: string;
  name: string;
  transport: "stdio" | "sse";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  connectTimeoutMs?: number;
  toolCallTimeoutMs?: number;
}

interface McpServerState {
  config: McpServerConfig;
  client: Client;
  transport: Transport;
  connected: boolean;
  toolIds: string[];
}

function normalizeTimeout(value: number | undefined, fallback: number): number {
  return Number.isFinite(value)
    ? Math.max(10, Math.min(10 * 60_000, Math.trunc(value!)))
    : fallback;
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`E_MCP_TIMEOUT: ${label} exceeded ${timeoutMs}ms`)),
          timeoutMs,
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** 连接一个 MCP server，发现并注册工具。 */
export async function connectMcpServer(config: McpServerConfig): Promise<string[]> {
  console.log(LOG_PREFIX, "连接 MCP server:", config.name, "(" + config.id + ")");

  let transport: Transport;
  if (config.transport === "sse") {
    if (!config.url) throw new Error("sse transport requires url");
    transport = new SSEClientTransport(new URL(config.url));
  } else {
    if (!config.command) throw new Error("stdio transport requires command");
    transport = new StdioClientTransport({
      command: config.command,
      args: config.args,
      env: config.env,
      cwd: config.cwd,
    });
  }

  transport.onerror = (err: Error) => {
    console.error(LOG_PREFIX, "transport 错误 [" + config.name + "]:", err.message);
  };

  const client = new Client(
    { name: "cyrene", version: "0.4.3" },
    { capabilities: {} },
  );
  const connectTimeoutMs = normalizeTimeout(config.connectTimeoutMs, MCP_DEFAULT_CONNECT_TIMEOUT_MS);

  try {
    await withTimeout(client.connect(transport), connectTimeoutMs, `connect ${config.id}`);
    console.log(LOG_PREFIX, "已连接到", config.name);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(LOG_PREFIX, "连接失败 [" + config.name + "]:", msg);
    try { await transport.close(); } catch { /* ignore cleanup error */ }
    throw err;
  }

  let mcpTools: Array<{
    name: string;
    description?: string;
    inputSchema: {
      type: "object";
      properties: Record<string, unknown>;
      required?: string[];
    };
  }> = [];

  try {
    const result = await withTimeout(client.listTools(), connectTimeoutMs, `listTools ${config.id}`);
    mcpTools = result.tools as typeof mcpTools;
    console.log(LOG_PREFIX, "发现 " + mcpTools.length + " 个工具:", mcpTools.map(t => t.name).join(", "));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(LOG_PREFIX, "listTools 失败 [" + config.name + "]:", msg);
    try { await client.close(); } catch { /* ignore cleanup error */ }
    throw err;
  }

  const registeredIds: string[] = [];
  for (const mt of mcpTools) {
    const toolId = config.id + "-" + mt.name;
    if (toolRegistry.getById(toolId)) {
      console.warn(LOG_PREFIX, "工具已存在，跳过:", toolId);
      continue;
    }

    const toolDef: ToolDefinition = {
      id: toolId,
      name: "[" + config.name + "] " + mt.name,
      description: mt.description || mt.name,
      enabled: true,
      inputSchema: {
        type: "object",
        properties: mt.inputSchema?.properties as Record<string, { type: string; description: string }> || {},
        required: mt.inputSchema?.required,
      },
      execute: async (args: Record<string, unknown>, ctx) => {
        console.log(LOG_PREFIX, "调用工具:", toolId, JSON.stringify(args));
        try {
          const result = await withTimeout(
            client.callTool(
              { name: mt.name, arguments: args },
              undefined,
              ctx?.signal ? { signal: ctx.signal } : undefined,
            ),
            normalizeTimeout(config.toolCallTimeoutMs, MCP_DEFAULT_TOOL_TIMEOUT_MS),
            `callTool ${toolId}`,
          );
          const texts: string[] = [];
          if (result.content && Array.isArray(result.content)) {
            for (const block of result.content) {
              if (block && typeof block === "object" && (block as { type: string }).type === "text") {
                texts.push(String((block as { text: string }).text));
              }
            }
          }
          const output = texts.join("\n") || JSON.stringify(result.content);
          if (result.isError === true) {
            throw new Error(`E_MCP_TOOL_FAILED${output ? `: ${output}` : ""}`);
          }
          console.log(LOG_PREFIX, "工具返回 [" + toolId + "]:", output.slice(0, 200));
          return output;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(LOG_PREFIX, "工具调用失败 [" + toolId + "]:", msg);
          if (msg.startsWith("E_MCP_")) throw err;
          throw new Error("E_MCP_TOOL_FAILED: " + msg);
        }
      },
    };

    toolRegistry.register(toolDef);
    registeredIds.push(toolId);
    console.log(LOG_PREFIX, "已注册工具:", toolId);
  }

  mcpServerStates.set(config.id, {
    config,
    client,
    transport,
    connected: true,
    toolIds: registeredIds,
  });
  console.log(LOG_PREFIX, "MCP server 就绪:", config.name, `(${registeredIds.length} 个工具)`);
  return registeredIds;
}

export async function disconnectMcpServer(serverId: string): Promise<boolean> {
  console.log(LOG_PREFIX, "断开 MCP server:", serverId);
  const state = mcpServerStates.get(serverId);
  if (!state) {
    console.warn(LOG_PREFIX, "未找到 MCP server:", serverId);
    return false;
  }
  for (const toolId of state.toolIds) toolRegistry.unregister(toolId);
  try {
    await state.client.close();
  } catch (err) {
    console.error(LOG_PREFIX, "client.close 失败 [" + serverId + "]:", err);
    try { await state.transport.close(); } catch { /* ignore cleanup error */ }
  }
  state.connected = false;
  mcpServerStates.delete(serverId);
  return true;
}

export function getMcpServerStates(): Array<{
  id: string;
  name: string;
  connected: boolean;
  toolCount: number;
  toolIds: string[];
}> {
  return Array.from(mcpServerStates.values()).map(s => ({
    id: s.config.id,
    name: s.config.name,
    connected: s.connected,
    toolCount: s.toolIds.length,
    toolIds: [...s.toolIds],
  }));
}

const mcpServerStates = new Map<string, McpServerState>();
