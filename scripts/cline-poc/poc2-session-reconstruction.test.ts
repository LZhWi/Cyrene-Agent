/**
 * PoC 2: Session 重建尾部清理测试
 *
 * 验证 readMessages + start({ initialMessages }) 不会产生悬空工具历史。
 *
 * 场景：
 * 1. 创建 Session，执行一轮带工具调用的 turn
 * 2. 读取消息，检查完整性
 * 3. 模拟中断场景（未配对的 ToolUse）
 * 4. 验证尾部清理逻辑
 * 5. 用清理后的消息创建新 Session
 * 6. 验证新 Session 可以正常 send
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ── 类型 ──────────────────────────────────────────────────

interface Message {
  role: "user" | "assistant";
  content: string | unknown[];
}

interface SessionReconstructionResult {
  messages: Message[];
  droppedTrailingMessages: number;
  interruptedTurnDetected: boolean;
  unresolvedToolCalls: string[];
}

// ── 尾部清理逻辑 ──────────────────────────────────────────

/**
 * 检查消息尾部是否存在不完整的内容。
 * 截断到最后一个完整边界。
 */
function reconstructSession(rawMessages: Message[]): SessionReconstructionResult {
  if (rawMessages.length === 0) {
    return { messages: [], droppedTrailingMessages: 0, interruptedTurnDetected: false, unresolvedToolCalls: [] };
  }

  const messages = [...rawMessages];
  let droppedTrailingMessages = 0;
  let interruptedTurnDetected = false;
  const unresolvedToolCalls: string[] = [];

  // 从尾部向前扫描，找到最后一个完整边界
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const content = msg.content;

    // 字符串 content 直接完整
    if (typeof content === "string") {
      // 最后一条 user 消息是完整的
      if (msg.role === "user" && i === messages.length - 1) break;
      // 最后一条 assistant 消息如果是字符串也完整
      if (msg.role === "assistant" && i === messages.length - 1) break;
      // 非末尾消息默认完整
      if (i < messages.length - 1) break;
    }

    // 数组 content 需要检查每个 block
    if (Array.isArray(content)) {
      const toolUses: { id: string; name: string }[] = [];
      const toolResults: { toolUseId: string }[] = [];
      let hasIncompleteBlock = false;

      for (const block of content) {
        const b = block as { type?: string; id?: string; name?: string; tool_use_id?: string };
        if (b.type === "tool_use") {
          toolUses.push({ id: b.id!, name: b.name! });
        } else if (b.type === "tool_result") {
          toolResults.push({ toolUseId: b.tool_use_id! });
        } else if (b.type === "text" && typeof (b as { text?: unknown }).text === "string") {
          // text block 完整
        } else if (b.type === "thinking") {
          // thinking block 完整
        } else {
          hasIncompleteBlock = true;
        }
      }

      // 检查是否有未配对的 tool_use
      const resultIds = new Set(toolResults.map(r => r.toolUseId));
      const unmatched = toolUses.filter(tu => !resultIds.has(tu.id));

      if (hasIncompleteBlock || unmatched.length > 0) {
        // 这条消息不完整，需要截断
        interruptedTurnDetected = true;
        unresolvedToolCalls.push(...unmatched.map(u => u.id));

        // 从这里截断：丢弃这条及之后所有消息
        const cutIndex = i;
        droppedTrailingMessages = messages.length - cutIndex;
        messages.length = cutIndex;
        break;
      }

      // 这条消息完整
      if (i === messages.length - 1) break;
    }
  }

  return { messages, droppedTrailingMessages, interruptedTurnDetected, unresolvedToolCalls };
}

// ── Cline ESM Bridge 加载 ────────────────────────────────

async function loadClineCore(): Promise<any> {
  const bridgePath = path.join(__dirname, "..", "..", "src", "main", "orchestrator", "cline", "cline-esm-bridge.mjs");
  const bridgeUrl = require("url").pathToFileURL(bridgePath).href;
  const bridge = await import(bridgeUrl);
  return bridge.createClineCore({ clientName: "cyrene-poc2", backendMode: "local" });
}

function getModelConfig() {
  const candidates = [
    path.join(os.homedir(), "AppData", "Roaming", "live2d-cyrene", "model-settings.json"),
    path.join(os.homedir(), "AppData", "Roaming", "Cyrene", "model-settings.json"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const raw = JSON.parse(fs.readFileSync(p, "utf8"));
      const provider = raw.provider ?? "MiniMax（稀宇科技）";
      const profile = raw.perProvider?.[provider] ?? {};
      return {
        providerId: "openai-compatible",
        modelId: profile.model || raw.model || "MiniMax-M3",
        apiKey: profile.apiKey || raw.apiKey || "",
        baseUrl: profile.baseUrl || raw.baseUrl || "https://api.minimaxi.com/v1",
      };
    }
  }
  return null;
}

// ── 测试 ──────────────────────────────────────────────────

describe("PoC 2: Session 重建尾部清理", { timeout: 120_000 }, () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline-poc2-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("完整历史不需要截断", () => {
    const messages: Message[] = [
      { role: "user", content: "你好" },
      { role: "assistant", content: "你好！有什么可以帮你的？" },
    ];

    const result = reconstructSession(messages);
    expect(result.droppedTrailingMessages).toBe(0);
    expect(result.interruptedTurnDetected).toBe(false);
    expect(result.unresolvedToolCalls).toEqual([]);
    expect(result.messages.length).toBe(2);
  });

  it("悬空 ToolUse 被截断", () => {
    const messages: Message[] = [
      { role: "user", content: "读取文件" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "我来读取文件" },
          { type: "tool_use", id: "tool-1", name: "read_file", input: { path: "test.ts" } },
        ],
      },
      // 缺少对应的 tool_result
    ];

    const result = reconstructSession(messages);
    expect(result.interruptedTurnDetected).toBe(true);
    expect(result.unresolvedToolCalls).toEqual(["tool-1"]);
    expect(result.droppedTrailingMessages).toBe(1);
    expect(result.messages.length).toBe(1); // 只保留 user 消息
  });

  it("配对的 ToolUse/ToolResult 不被截断", () => {
    const messages: Message[] = [
      { role: "user", content: "读取文件" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "我来读取文件" },
          { type: "tool_use", id: "tool-1", name: "read_file", input: { path: "test.ts" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-1", content: "file content here" },
        ],
      },
      {
        role: "assistant",
        content: "文件内容是 file content here",
      },
    ];

    const result = reconstructSession(messages);
    expect(result.interruptedTurnDetected).toBe(false);
    expect(result.unresolvedToolCalls).toEqual([]);
    expect(result.droppedTrailingMessages).toBe(0);
    expect(result.messages.length).toBe(4);
  });

  it("readMessages + start(initialMessages) 创建新 Session", async () => {
    const modelConfig = getModelConfig();
    if (!modelConfig) {
      console.log("[PoC2] 未找到模型配置，跳过");
      return;
    }

    const cline = await loadClineCore();

    // 1. 创建原始 Session 并执行一轮
    const startResult = await cline.start({
      config: {
        providerId: modelConfig.providerId,
        modelId: modelConfig.modelId,
        apiKey: modelConfig.apiKey,
        baseUrl: modelConfig.baseUrl,
        cwd: tmpDir,
        workspaceRoot: tmpDir,
        systemPrompt: "你是一个测试助手。简短回答即可。",
        enableTools: false,
        enableSpawnAgent: false,
        enableAgentTeams: false,
        mode: "act",
        hooks: {},
      },
      prompt: "你好",
      interactive: true,
    });

    const oldSessionId = startResult.sessionId;
    expect(oldSessionId).toBeDefined();

    // 2. 读取消息
    const messages = await cline.readMessages(oldSessionId);
    expect(messages.length).toBeGreaterThan(0);
    console.log("[PoC2] readMessages returned", messages.length, "messages");

    // 3. 尾部清理
    const reconstruction = reconstructSession(messages as Message[]);
    expect(reconstruction.interruptedTurnDetected).toBe(false);
    expect(reconstruction.messages.length).toBe(messages.length);

    // 4. 用清理后的消息创建新 Session（不提交 prompt）
    const newStartResult = await cline.start({
      config: {
        providerId: modelConfig.providerId,
        modelId: modelConfig.modelId,
        apiKey: modelConfig.apiKey,
        baseUrl: modelConfig.baseUrl,
        cwd: tmpDir,
        workspaceRoot: tmpDir,
        systemPrompt: "你是一个测试助手。简短回答即可。",
        enableTools: false,
        enableSpawnAgent: false,
        enableAgentTeams: false,
        mode: "act",
        hooks: {},
      },
      initialMessages: reconstruction.messages,
      interactive: true,
    });

    const newSessionId = newStartResult.sessionId;
    expect(newSessionId).toBeDefined();
    expect(newSessionId).not.toBe(oldSessionId);
    // start 无 prompt 时 result 应为 undefined
    expect(newStartResult.result).toBeUndefined();

    // 5. 在新 Session 上 send（只提交一次）
    const sendResult = await cline.send({
      sessionId: newSessionId,
      prompt: "重复一下我刚才说了什么",
    });

    expect(sendResult).toBeDefined();
    console.log("[PoC2] send result finishReason:", sendResult?.finishReason);

    // 清理
    await cline.stop(newSessionId).catch(() => {});
    await cline.dispose().catch(() => {});
  });

  it("stop() 后 readMessages 仍可用", async () => {
    const modelConfig = getModelConfig();
    if (!modelConfig) {
      console.log("[PoC2] 未找到模型配置，跳过");
      return;
    }

    const cline = await loadClineCore();

    const startResult = await cline.start({
      config: {
        providerId: modelConfig.providerId,
        modelId: modelConfig.modelId,
        apiKey: modelConfig.apiKey,
        baseUrl: modelConfig.baseUrl,
        cwd: tmpDir,
        workspaceRoot: tmpDir,
        systemPrompt: "你是一个测试助手。简短回答即可。",
        enableTools: false,
        enableSpawnAgent: false,
        enableAgentTeams: false,
        mode: "act",
        hooks: {},
      },
      prompt: "你好",
      interactive: true,
    });

    // stop
    await cline.stop(startResult.sessionId);

    // readMessages 仍可用
    const messages = await cline.readMessages(startResult.sessionId);
    expect(messages.length).toBeGreaterThan(0);
    console.log("[PoC2] readMessages after stop:", messages.length, "messages");

    // send 到已 stop 的 session 应该失败
    try {
      await cline.send({ sessionId: startResult.sessionId, prompt: "test" });
      console.log("[PoC2] send to stopped session succeeded (unexpected)");
    } catch (err) {
      console.log("[PoC2] send to stopped session failed as expected:", (err as Error).message);
    }

    await cline.dispose().catch(() => {});
  });

  it("get() 返回 undefined 而非抛异常（未知 session）", async () => {
    const cline = await loadClineCore();

    const result = await cline.get("nonexistent-session-id");
    expect(result).toBeUndefined();

    await cline.dispose().catch(() => {});
  });
});
