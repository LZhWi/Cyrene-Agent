import { describe, it, expect, vi, beforeEach } from "vitest";

// tool-registry 通过 ../rag/index 间接 import electron；这里 stub 掉避免 electron 二进制检查
vi.mock("electron", () => ({
	app: { getPath: vi.fn(() => "/tmp") },
}));

// mock 整个 SDK,在测试里不需要真连
vi.mock("@modelcontextprotocol/sdk/client/index.js", () => ({
	Client: vi.fn(),
}));

const mockStdioConnect = vi.fn().mockResolvedValue(undefined);
const mockSseConnect = vi.fn().mockResolvedValue(undefined);
const mockSseClose = vi.fn().mockResolvedValue(undefined);
const mockStdioClose = vi.fn().mockResolvedValue(undefined);

vi.mock("@modelcontextprotocol/sdk/client/stdio.js", () => ({
	StdioClientTransport: vi.fn().mockImplementation(function (this: unknown, opts: unknown) {
		return {
			close: mockStdioClose,
			_opts: opts,
		};
	}),
}));

vi.mock("@modelcontextprotocol/sdk/client/sse.js", () => ({
	SSEClientTransport: vi.fn().mockImplementation(function (this: unknown, url: unknown) {
		return {
			close: mockSseClose,
			onerror: null as ((err: Error) => void) | null,
			_url: url,
		};
	}),
}));

import { connectMcpServer, disconnectMcpServer, getMcpServerStates, resolveMcpToolPolicy } from "./mcp-adapter";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { toolRegistry } from "./tool-registry";

describe("mcp-adapter transport split", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		// 清空 registry,避免互相污染
		for (const t of toolRegistry.getAllTools()) toolRegistry.unregister(t.id);
	});

	it("stdio transport uses StdioClientTransport with command/args", async () => {
		const Client = (await import("@modelcontextprotocol/sdk/client/index.js")).Client as any;
		Client.mockImplementation(function (this: unknown) {
			return {
				connect: vi.fn().mockResolvedValue(undefined),
				listTools: vi.fn().mockResolvedValue({ tools: [] }),
				close: vi.fn().mockResolvedValue(undefined),
			};
		});

		await connectMcpServer({
			id: "test-stdio",
			name: "Test Stdio",
			transport: "stdio",
			command: "node",
			args: ["foo.js"],
		});

		expect(StdioClientTransport).toHaveBeenCalledWith({
			command: "node",
			args: ["foo.js"],
			env: undefined,
			cwd: undefined,
		});
		expect(SSEClientTransport).not.toHaveBeenCalled();
	});

	it("sse transport uses SSEClientTransport with URL", async () => {
		const Client = (await import("@modelcontextprotocol/sdk/client/index.js")).Client as any;
		Client.mockImplementation(function (this: unknown) {
			return {
				connect: vi.fn().mockResolvedValue(undefined),
				listTools: vi.fn().mockResolvedValue({ tools: [] }),
				close: vi.fn().mockResolvedValue(undefined),
			};
		});

		await connectMcpServer({
			id: "test-sse",
			name: "Test SSE",
			transport: "sse",
			url: "https://example.com/sse",
		});

		expect(SSEClientTransport).toHaveBeenCalledWith(new URL("https://example.com/sse"));
		expect(StdioClientTransport).not.toHaveBeenCalled();
	});

	it("sse transport without url throws", async () => {
		await expect(
			connectMcpServer({
				id: "test-sse-bad",
				name: "Bad SSE",
				transport: "sse",
			})
		).rejects.toThrow(/sse transport requires url/);
	});

	it("fails closed for an unannotated tool without a local policy", async () => {
		const Client = (await import("@modelcontextprotocol/sdk/client/index.js")).Client as any;
		Client.mockImplementation(function (this: unknown) {
			return {
				connect: vi.fn().mockResolvedValue(undefined),
				listTools: vi.fn().mockResolvedValue({ tools: [{ name: "mystery", inputSchema: { type: "object", properties: {} } }] }),
				close: vi.fn().mockResolvedValue(undefined),
			};
		});

		const ids = await connectMcpServer({ id: "unclassified", name: "Unclassified", transport: "stdio", command: "node" });

		expect(ids).toEqual([]);
		expect(toolRegistry.getById("unclassified-mystery")).toBeUndefined();
		expect(getMcpServerStates().find((s) => s.id === "unclassified")?.rejectedTools).toEqual([
			expect.objectContaining({ name: "mystery" }),
		]);
	});

	it("does not trust annotations without a local policy and escalates destructive hints", () => {
		expect(resolveMcpToolPolicy({ readOnlyHint: true }, undefined, undefined)).toBeUndefined();
		expect(resolveMcpToolPolicy(
			{ destructiveHint: true },
			undefined,
			{ risk: "network", effectKind: "read" },
		)).toEqual({
			risk: "shell",
			effectKind: "external_side_effect",
		});
	});

	it("uses a local per-tool override before the server default", () => {
		expect(resolveMcpToolPolicy(
			undefined,
			{ risk: "network", effectKind: "read" },
			{ risk: "shell", effectKind: "external_side_effect" },
		)).toEqual({ risk: "network", effectKind: "read" });
	});

	it("registers classified MCP tools with explicit origin, risk and effect", async () => {
		const Client = (await import("@modelcontextprotocol/sdk/client/index.js")).Client as any;
		Client.mockImplementation(function (this: unknown) {
			return {
				connect: vi.fn().mockResolvedValue(undefined),
				listTools: vi.fn().mockResolvedValue({ tools: [{
					name: "lookup",
					annotations: { readOnlyHint: true },
					inputSchema: { type: "object", properties: {} },
				}] }),
				close: vi.fn().mockResolvedValue(undefined),
				callTool: vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] }),
			};
		});

		await connectMcpServer({
			id: "classified",
			name: "Classified",
			transport: "stdio",
			command: "node",
			defaultToolPolicy: { risk: "fs-read", effectKind: "read" },
		});

		expect(toolRegistry.getById("classified-lookup")).toMatchObject({
			origin: "mcp",
			risk: "fs-read",
			effectKind: "read",
		});
	});

	it("times out a hanging connection and closes its transport", async () => {
		const Client = (await import("@modelcontextprotocol/sdk/client/index.js")).Client as any;
		Client.mockImplementation(function (this: unknown) {
			return {
				connect: vi.fn(() => new Promise(() => undefined)),
				listTools: vi.fn(),
				close: vi.fn().mockResolvedValue(undefined),
			};
		});

		await expect(connectMcpServer({
			id: "connect-timeout",
			name: "Connect Timeout",
			transport: "stdio",
			command: "node",
			connectTimeoutMs: 10,
		})).rejects.toThrow(/E_MCP_TIMEOUT: connect connect-timeout/);
		expect(mockStdioClose).toHaveBeenCalled();
	});

	it("times out hanging tool discovery and closes the client", async () => {
		const Client = (await import("@modelcontextprotocol/sdk/client/index.js")).Client as any;
		const close = vi.fn().mockResolvedValue(undefined);
		Client.mockImplementation(function (this: unknown) {
			return {
				connect: vi.fn().mockResolvedValue(undefined),
				listTools: vi.fn(() => new Promise(() => undefined)),
				close,
			};
		});

		await expect(connectMcpServer({
			id: "list-timeout",
			name: "List Timeout",
			transport: "stdio",
			command: "node",
			connectTimeoutMs: 10,
		})).rejects.toThrow(/E_MCP_TIMEOUT: listTools list-timeout/);
		expect(close).toHaveBeenCalled();
	});

	it("times out a hanging tool call instead of returning a successful error string", async () => {
		const Client = (await import("@modelcontextprotocol/sdk/client/index.js")).Client as any;
		Client.mockImplementation(function (this: unknown) {
			return {
				connect: vi.fn().mockResolvedValue(undefined),
				listTools: vi.fn().mockResolvedValue({ tools: [{ name: "hang", inputSchema: { type: "object", properties: {} } }] }),
				close: vi.fn().mockResolvedValue(undefined),
				callTool: vi.fn(() => new Promise(() => undefined)),
			};
		});
		await connectMcpServer({
			id: "call-timeout",
			name: "Call Timeout",
			transport: "stdio",
			command: "node",
			toolCallTimeoutMs: 10,
			defaultToolPolicy: { risk: "shell", effectKind: "external_side_effect" },
		});

		await expect(toolRegistry.getById("call-timeout-hang")!.execute({})).rejects.toThrow(
			/E_MCP_TIMEOUT: callTool call-timeout-hang/,
		);
	});

	it("turns MCP isError responses into failed executions", async () => {
		const Client = (await import("@modelcontextprotocol/sdk/client/index.js")).Client as any;
		Client.mockImplementation(function (this: unknown) {
			return {
				connect: vi.fn().mockResolvedValue(undefined),
				listTools: vi.fn().mockResolvedValue({ tools: [{ name: "bad", inputSchema: { type: "object", properties: {} } }] }),
				close: vi.fn().mockResolvedValue(undefined),
				callTool: vi.fn().mockResolvedValue({ isError: true, content: [{ type: "text", text: "denied" }] }),
			};
		});
		await connectMcpServer({
			id: "tool-error",
			name: "Tool Error",
			transport: "stdio",
			command: "node",
			defaultToolPolicy: { risk: "shell", effectKind: "external_side_effect" },
		});

		await expect(toolRegistry.getById("tool-error-bad")!.execute({})).rejects.toThrow(/E_MCP_TOOL_FAILED: denied/);
	});

	it("passes the run AbortSignal into MCP callTool", async () => {
		const Client = (await import("@modelcontextprotocol/sdk/client/index.js")).Client as any;
		const callTool = vi.fn().mockResolvedValue({ content: [{ type: "text", text: "ok" }] });
		Client.mockImplementation(function (this: unknown) {
			return {
				connect: vi.fn().mockResolvedValue(undefined),
				listTools: vi.fn().mockResolvedValue({ tools: [{ name: "run", inputSchema: { type: "object", properties: {} } }] }),
				close: vi.fn().mockResolvedValue(undefined),
				callTool,
			};
		});
		await connectMcpServer({
			id: "signal",
			name: "Signal",
			transport: "stdio",
			command: "node",
			defaultToolPolicy: { risk: "shell", effectKind: "external_side_effect" },
		});
		const controller = new AbortController();

		await toolRegistry.getById("signal-run")!.execute({}, {
			userQuery: "",
			signal: controller.signal,
		});

		expect(callTool).toHaveBeenCalledWith(
			{ name: "run", arguments: {} },
			undefined,
			{ signal: controller.signal },
		);
	});
});
