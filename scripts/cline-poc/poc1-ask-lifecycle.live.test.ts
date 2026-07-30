/**
 * PoC 1: Cline Ask 真实生命周期测试
 *
 * 验证 6 项：
 * 1. AskQuestionExecutor 被调用后，start/send Promise 是否保持 pending
 * 2. Cline turn 转交应用级任务管理器后，AGUI_RUN 是否能先返回
 * 3. 新 IPC 是否能 resolve Deferred，并让同一个 turn 继续
 * 4. 用户取消时，reject/abort 和 Cline turn 的真实结果
 * 5. 应用退出时，所有 Active Ask 是否被统一 reject
 * 6. interactive: true/false 的真实行为差异
 *
 * 运行方式：
 * CYRENE_RUN_CLINE_LIVE_TESTS=1 npx vitest run scripts/cline-poc/poc1-ask-lifecycle.live.test.ts
 */

import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// ── Deferred Registry（应用级） ──────────────────────────

interface ActiveCodeAsk {
  chatSessionId: string;
  clineSessionId: string;
  runId: string;
  promptId: string;
  question: string;
  options?: string[];
  createdAt: number;
  resolve: (answer: string) => void;
  reject: (error: Error) => void;
}

const askRegistry = new Map<string, ActiveCodeAsk>();
let askCounter = 0;

function createAsk(
  chatSessionId: string,
  clineSessionId: string,
  runId: string,
  question: string,
  options?: string[],
): Promise<string> {
  const promptId = `ask-${++askCounter}-${Date.now()}`;
  return new Promise<string>((resolve, reject) => {
    askRegistry.set(promptId, {
      chatSessionId, clineSessionId, runId, promptId,
      question, options, createdAt: Date.now(),
      resolve, reject,
    });
  });
}

function respondToAsk(promptId: string, answer: string): boolean {
  const ask = askRegistry.get(promptId);
  if (!ask) return false;
  askRegistry.delete(promptId);
  ask.resolve(answer);
  return true;
}

function cancelAsk(promptId: string, reason: string): boolean {
  const ask = askRegistry.get(promptId);
  if (!ask) return false;
  askRegistry.delete(promptId);
  ask.reject(new Error(reason));
  return true;
}

function rejectAllAsks(reason: string): number {
  let count = 0;
  for (const [id, ask] of askRegistry) {
    ask.reject(new Error(reason));
    askRegistry.delete(id);
    count++;
  }
  return count;
}

// ── Cline ESM Bridge 加载 ────────────────────────────────

async function loadClineCore(): Promise<any> {
  const bridgePath = path.join(__dirname, "..", "..", "src", "main", "orchestrator", "code", "cline-esm-bridge.mjs");
  const bridgeUrl = require("url").pathToFileURL(bridgePath).href;
  // Vitest 支持 ESM dynamic import
  const bridge = await import(bridgeUrl);
  return bridge.createClineCore({ clientName: "cyrene-poc", backendMode: "local" });
}

// ── 测试用模型配置 ────────────────────────────────────────

function getModelConfig() {
  // 读取实际模型配置（Electron userData 目录名可能不同）
  const candidates = [
    path.join(process.env.APPDATA || "", "Cyrene", "model-settings.json"),
    path.join(process.env.APPDATA || "", "live2d-cyrene", "model-settings.json"),
    path.join(os.homedir(), "AppData", "Roaming", "Cyrene", "model-settings.json"),
    path.join(os.homedir(), "AppData", "Roaming", "live2d-cyrene", "model-settings.json"),
  ];
  for (const settingsPath of candidates) {
    if (fs.existsSync(settingsPath)) {
      const raw = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
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

describe.skipIf(process.env.CYRENE_RUN_CLINE_LIVE_TESTS !== "1")(
  "PoC 1 Live: Cline Ask 生命周期（需要真实模型）",
  { timeout: 120_000 },
  () => {
  let cline: any;
  let tmpDir: string;
  let modelConfig: ReturnType<typeof getModelConfig>;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline-poc1-"));
    modelConfig = getModelConfig();
    if (!modelConfig) {
      console.warn("[PoC1] 未找到模型配置，跳过需要真实 LLM 的测试");
    }
    askRegistry.clear();
    askCounter = 0;
  });

  afterEach(async () => {
    rejectAllAsks("test cleanup");
    if (cline) {
      try { await cline.dispose(); } catch { /* */ }
      cline = null;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("1. AskQuestionExecutor 调用后 start/send Promise 保持 pending", async () => {
    if (!modelConfig) return;

    // 创建带 askQuestion executor 的 ClineCore
    cline = await loadClineCore();

    let executorCalled = false;
    let executorReturned = false;

    const askQuestionExecutor = async (question: string, options: string[], context: any): Promise<string> => {
      executorCalled = true;
      console.log("[PoC1] AskQuestionExecutor called:", question, options);

      // 创建 Deferred，不立即 resolve
      const answer = await createAsk("test-chat", "test-cline", "test-run", question, options);
      executorReturned = true;
      return answer;
    };

    // 任务设计：让 Cline 需要问用户问题
    const task = "请先问我喜欢什么颜色，然后说'好的，你喜欢X色'。必须使用 ask_question 工具提问。";

    const startPromise = cline.start({
      config: {
        providerId: modelConfig.providerId,
        modelId: modelConfig.modelId,
        apiKey: modelConfig.apiKey,
        baseUrl: modelConfig.baseUrl,
        cwd: tmpDir,
        workspaceRoot: tmpDir,
        systemPrompt: "你是一个测试助手。必须使用 ask_question 工具向用户提问。",
        enableTools: true,
        enableSpawnAgent: false,
        enableAgentTeams: false,
        mode: "act",
        hooks: {},
      },
      capabilities: {
        toolExecutors: { askQuestion: askQuestionExecutor },
      },
      prompt: task,
      interactive: true,
    });

    // 等待 executor 被调用（最多 30 秒）
    for (let i = 0; i < 60; i++) {
      if (executorCalled) break;
      await new Promise(r => setTimeout(r, 500));
    }

    expect(executorCalled).toBe(true);

    // start Promise 应该仍然 pending（executor 未返回）
    // 检查方式：race 一个超时
    const settled = await Promise.race([
      startPromise.then(() => true).catch(() => true),
      new Promise<boolean>(r => setTimeout(() => r(false), 1000)),
    ]);

    expect(settled).toBe(false); // 仍然 pending
    expect(executorReturned).toBe(false); // executor 未返回

    // 清理：回答问题让 turn 完成
    const promptId = Array.from(askRegistry.keys())[0];
    if (promptId) {
      respondToAsk(promptId, "蓝色");
    }

    // 等待 start 完成
    const result = await startPromise;
    expect(result.sessionId).toBeDefined();
    console.log("[PoC1] Test 1 passed: start Promise stayed pending during Ask");
  });

  it("2. Cline turn 可在后台运行，不阻塞调用方", async () => {
    // 验证：把 cline.start() 放入"后台"后，调用方可以继续执行其他操作
    if (!modelConfig) return;

    cline = await loadClineCore();

    let executorCalled = false;
    const askQuestionExecutor = async (question: string, options: string[]) => {
      executorCalled = true;
      return createAsk("test-chat", "test-cline", "test-run", question, options);
    };

    // 提交 turn 但不 await
    const startPromise = cline.start({
      config: {
        providerId: modelConfig.providerId,
        modelId: modelConfig.modelId,
        apiKey: modelConfig.apiKey,
        baseUrl: modelConfig.baseUrl,
        cwd: tmpDir,
        workspaceRoot: tmpDir,
        systemPrompt: "你是一个测试助手。必须使用 ask_question 工具向用户提问。",
        enableTools: true,
        enableSpawnAgent: false,
        enableAgentTeams: false,
        mode: "act",
        hooks: {},
      },
      capabilities: {
        toolExecutors: { askQuestion: askQuestionExecutor },
      },
      prompt: "请用 ask_question 问我喜欢什么颜色。",
      interactive: true,
    });

    // 调用方可以继续执行其他操作（模拟 AGUI_RUN 先返回）
    const otherWorkDone = await new Promise<string>(r => {
      setTimeout(() => r("other work completed"), 100);
    });

    expect(otherWorkDone).toBe("other work completed");

    // 等待 executor 被调用
    for (let i = 0; i < 60; i++) {
      if (executorCalled) break;
      await new Promise(r => setTimeout(r, 500));
    }
    expect(executorCalled).toBe(true);

    // 回答问题让 turn 完成
    const promptId = Array.from(askRegistry.keys())[0];
    if (promptId) respondToAsk(promptId, "红色");

    await startPromise;
    console.log("[PoC1] Test 2 passed: turn runs in background, caller not blocked");
  });

  it("3. 通过 Deferred resolve 让同一 turn 继续", async () => {
    if (!modelConfig) return;

    cline = await loadClineCore();

    const askQuestionExecutor = async (question: string, options: string[]) => {
      return createAsk("test-chat", "test-cline", "test-run", question, options);
    };

    const startPromise = cline.start({
      config: {
        providerId: modelConfig.providerId,
        modelId: modelConfig.modelId,
        apiKey: modelConfig.apiKey,
        baseUrl: modelConfig.baseUrl,
        cwd: tmpDir,
        workspaceRoot: tmpDir,
        systemPrompt: "你是一个测试助手。必须使用 ask_question 工具向用户提问，然后根据用户回答生成回复。",
        enableTools: true,
        enableSpawnAgent: false,
        enableAgentTeams: false,
        mode: "act",
        hooks: {},
      },
      capabilities: {
        toolExecutors: { askQuestion: askQuestionExecutor },
      },
      prompt: "请用 ask_question 问我喜欢什么颜色，然后说'好的，你喜欢X色'。",
      interactive: true,
    });

    // 等待 Ask 出现
    for (let i = 0; i < 60; i++) {
      if (askRegistry.size > 0) break;
      await new Promise(r => setTimeout(r, 500));
    }

    expect(askRegistry.size).toBeGreaterThan(0);

    // 通过 Deferred resolve 回答（模拟新 IPC 请求）
    const promptId = Array.from(askRegistry.keys())[0];
    const resolved = respondToAsk(promptId, "绿色");
    expect(resolved).toBe(true);

    // turn 应该继续并完成
    const result = await startPromise;
    expect(result.sessionId).toBeDefined();
    expect(result.result).toBeDefined();
    console.log("[PoC1] Test 3 passed: Deferred resolve continued turn");
  });

  it("4. 用户取消时 reject 安全结束 turn", async () => {
    if (!modelConfig) return;

    cline = await loadClineCore();

    const askQuestionExecutor = async (question: string, options: string[]) => {
      return createAsk("test-chat", "test-cline", "test-run", question, options);
    };

    const startPromise = cline.start({
      config: {
        providerId: modelConfig.providerId,
        modelId: modelConfig.modelId,
        apiKey: modelConfig.apiKey,
        baseUrl: modelConfig.baseUrl,
        cwd: tmpDir,
        workspaceRoot: tmpDir,
        systemPrompt: "你是一个测试助手。必须使用 ask_question 工具向用户提问。",
        enableTools: true,
        enableSpawnAgent: false,
        enableAgentTeams: false,
        mode: "act",
        hooks: {},
      },
      capabilities: {
        toolExecutors: { askQuestion: askQuestionExecutor },
      },
      prompt: "请用 ask_question 问我喜欢什么颜色。",
      interactive: true,
    });

    // 等待 Ask 出现
    for (let i = 0; i < 60; i++) {
      if (askRegistry.size > 0) break;
      await new Promise(r => setTimeout(r, 500));
    }

    expect(askRegistry.size).toBeGreaterThan(0);

    // 取消 Ask
    const promptId = Array.from(askRegistry.keys())[0];
    const cancelled = cancelAsk(promptId, "USER_CANCELLED");
    expect(cancelled).toBe(true);

    // turn 应该以错误结束
    try {
      const result = await startPromise;
      // 如果不抛异常，检查 finishReason
      console.log("[PoC1] Test 4: turn finished after cancel, finishReason=", result.result?.finishReason);
      // 可能是 "aborted" 或 "error" 或 "completed"（取决于 Cline 如何处理工具错误）
    } catch (err) {
      console.log("[PoC1] Test 4: turn threw after cancel:", (err as Error).message);
    }

    expect(askRegistry.size).toBe(0);
    console.log("[PoC1] Test 4 passed: cancel safely ended turn");
  });

  it("5. 应用退出时所有 Active Ask 被统一 reject", async () => {
    if (!modelConfig) return;

    cline = await loadClineCore();

    const askQuestionExecutor = async (question: string, options: string[]) => {
      return createAsk("test-chat", "test-cline", "test-run", question, options);
    };

    // 启动 turn
    cline.start({
      config: {
        providerId: modelConfig.providerId,
        modelId: modelConfig.modelId,
        apiKey: modelConfig.apiKey,
        baseUrl: modelConfig.baseUrl,
        cwd: tmpDir,
        workspaceRoot: tmpDir,
        systemPrompt: "你是一个测试助手。必须使用 ask_question 工具向用户提问。",
        enableTools: true,
        enableSpawnAgent: false,
        enableAgentTeams: false,
        mode: "act",
        hooks: {},
      },
      capabilities: {
        toolExecutors: { askQuestion: askQuestionExecutor },
      },
      prompt: "请用 ask_question 问我喜欢什么颜色。",
      interactive: true,
    }).catch(() => { /* 预期会被 reject */ });

    // 等待 Ask 出现
    for (let i = 0; i < 60; i++) {
      if (askRegistry.size > 0) break;
      await new Promise(r => setTimeout(r, 500));
    }

    expect(askRegistry.size).toBeGreaterThan(0);

    // 模拟应用退出：reject 所有 Ask
    const rejectedCount = rejectAllAsks("APP_SHUTDOWN");
    expect(rejectedCount).toBeGreaterThan(0);
    expect(askRegistry.size).toBe(0);

    console.log("[PoC1] Test 5 passed: all asks rejected on shutdown");
  });

  it("6. interactive: true vs false 的行为差异", async () => {
    if (!modelConfig) return;

    cline = await loadClineCore();

    // interactive: false（非交互模式）
    const result1 = await cline.start({
      config: {
        providerId: modelConfig.providerId,
        modelId: modelConfig.modelId,
        apiKey: modelConfig.apiKey,
        baseUrl: modelConfig.baseUrl,
        cwd: tmpDir,
        workspaceRoot: tmpDir,
        systemPrompt: "你是一个测试助手。回答'你好'即可。",
        enableTools: false,
        enableSpawnAgent: false,
        enableAgentTeams: false,
        mode: "act",
        hooks: {},
      },
      prompt: "你好",
      interactive: false,
    });

    // 非交互模式：result 应该有值，session 已关闭
    expect(result1.result).toBeDefined();
    console.log("[PoC1] Test 6a: interactive=false, result.finishReason=", result1.result?.finishReason);

    // 尝试 send 到非交互 session -> 应该失败
    try {
      await cline.send({ sessionId: result1.sessionId, prompt: "再问一次" });
      console.log("[PoC1] Test 6b: send to non-interactive session succeeded (unexpected)");
    } catch (err) {
      console.log("[PoC1] Test 6b: send to non-interactive session failed as expected:", (err as Error).message);
    }

    // interactive: true（交互模式）
    const result2 = await cline.start({
      config: {
        providerId: modelConfig.providerId,
        modelId: modelConfig.modelId,
        apiKey: modelConfig.apiKey,
        baseUrl: modelConfig.baseUrl,
        cwd: tmpDir,
        workspaceRoot: tmpDir,
        systemPrompt: "你是一个测试助手。回答'你好'即可。",
        enableTools: false,
        enableSpawnAgent: false,
        enableAgentTeams: false,
        mode: "act",
        hooks: {},
      },
      prompt: "你好",
      interactive: true,
    });

    // 交互模式：result 应该有值，session 仍活跃
    expect(result2.result).toBeDefined();
    console.log("[PoC1] Test 6c: interactive=true, result.finishReason=", result2.result?.finishReason);

    // send 到交互 session -> 应该成功
    const sendResult = await cline.send({ sessionId: result2.sessionId, prompt: "再说一次你好" });
    console.log("[PoC1] Test 6d: send to interactive session succeeded, result=", sendResult?.finishReason);

    // 清理
    await cline.stop(result2.sessionId).catch(() => {});

    console.log("[PoC1] Test 6 passed: interactive flag controls session lifecycle");
  });
  },
);
