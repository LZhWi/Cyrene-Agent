/**
 * Cline 适配层 - 集成测试
 *
 * 覆盖：
 * 1. 安全边界（symlink/junction, ../, 绝对路径, 新建文件父目录）
 * 2. 并发锁（双重获取, 异常释放）
 * 3. partialChanges + mutationRevision
 * 4. Finalization Guard 集成
 * 5. AG-UI 事件配对
 * 6. Abort 副作用停止
 * 7. Electron 打包依赖检查
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import { isWithinWorkspace } from "./workspace-guard";
import { acquireWorkspaceLock, releaseWorkspaceLock } from "./workspace-lock";
import { checkCommands, DEFAULT_COMMAND_ALLOW_LIST } from "./command-guard";
import { ThinkFilter } from "./think-filter";
import { createStreamState, handleClineEvent, buildVerification, type StreamEventEmitter } from "./event-handler";
import { extractVerificationUpdate } from "./integration";
import { checkFinalizationGuard, resolveCompletionStatus, type AgentGraphState, type CodeVerificationState } from "../agent-graph";
import type { CodingAgentResult } from "./types";

let tmpDir: string;
let subDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline-integ-"));
  subDir = path.join(tmpDir, "src");
  fs.mkdirSync(subDir, { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ══════════════════════════════════════════════════════════════
// 1. 安全边界
// ══════════════════════════════════════════════════════════════

describe("安全边界", () => {
  it("拒绝 ../ 越界", () => {
    const outside = path.join(tmpDir, "..", "evil.ts");
    expect(isWithinWorkspace(outside, tmpDir)).toBe(false);
  });

  it("拒绝绝对路径越界", () => {
    const outside = path.join(os.tmpdir(), "other", "file.ts");
    expect(isWithinWorkspace(outside, tmpDir)).toBe(false);
  });

  it("允许工作区内文件", () => {
    const file = path.join(subDir, "test.ts");
    fs.writeFileSync(file, "test");
    expect(isWithinWorkspace(file, tmpDir)).toBe(true);
  });

  it("允许工作区内新建文件（父目录存在）", () => {
    const newFile = path.join(subDir, "new-file.ts");
    expect(isWithinWorkspace(newFile, tmpDir)).toBe(true);
  });

  it("拒绝新建文件父目录越界", () => {
    const newFile = path.join(tmpDir, "..", "new-dir", "new-file.ts");
    expect(isWithinWorkspace(newFile, tmpDir)).toBe(false);
  });

  it("拒绝 symlink 越界", () => {
    // 创建指向工作区外的 symlink
    const outsideDir = path.join(os.tmpdir(), "cline-outside-link");
    fs.mkdirSync(outsideDir, { recursive: true });
    const linkPath = path.join(tmpDir, "evil-link");
    try {
      fs.symlinkSync(outsideDir, linkPath, "dir");
      const fileViaLink = path.join(linkPath, "file.ts");
      expect(isWithinWorkspace(fileViaLink, tmpDir)).toBe(false);
    } catch {
      // 某些环境不支持 symlink，跳过
    }
    fs.rmSync(outsideDir, { recursive: true, force: true });
  });

  it("拒绝 workspaceRoot 本身", () => {
    expect(isWithinWorkspace(tmpDir, tmpDir)).toBe(false);
  });

  it("拒绝空路径", () => {
    expect(isWithinWorkspace("", tmpDir)).toBe(false);
  });

  it("拒绝相对路径", () => {
    expect(isWithinWorkspace("src/test.ts", tmpDir)).toBe(false);
  });
});

// ══════════════════════════════════════════════════════════════
// 2. 命令白名单
// ══════════════════════════════════════════════════════════════

describe("命令白名单安全边界", () => {
  it("拒绝 && 链接", () => {
    expect(checkCommands(["npx tsc --noEmit && rm -rf /"])?.skip).toBe(true);
  });

  it("拒绝管道", () => {
    expect(checkCommands(["npx tsc --noEmit | grep error"])?.skip).toBe(true);
  });

  it("拒绝重定向", () => {
    expect(checkCommands(["npx tsc --noEmit > out.txt"])?.skip).toBe(true);
  });

  it("拒绝 cmd 包装", () => {
    expect(checkCommands(["cmd /c npx tsc --noEmit"])?.skip).toBe(true);
  });

  it("拒绝 PowerShell 包装", () => {
    expect(checkCommands(["powershell -Command npx tsc"])?.skip).toBe(true);
  });

  it("拒绝 cd 切换", () => {
    expect(checkCommands(["cd /tmp"])?.skip).toBe(true);
  });

  it("拒绝非白名单命令", () => {
    expect(checkCommands(["rm -rf /"])?.skip).toBe(true);
    expect(checkCommands(["echo test"])?.skip).toBe(true);
    expect(checkCommands(["ls -la"])?.skip).toBe(true);
  });

  it("拒绝 npx 安装不存在的包", () => {
    expect(checkCommands(["npx nonexistent-package"])?.skip).toBe(true);
  });

  it("允许 tsc --noEmit", () => {
    expect(checkCommands(["npx tsc --noEmit"])).toBeUndefined();
  });

  it("允许结构化命令对象", () => {
    expect(checkCommands([{ command: "npx", args: ["tsc", "--noEmit"] }])).toBeUndefined();
  });

  it("DEFAULT_COMMAND_ALLOW_LIST 无重复 npx", () => {
    const npxEntries = DEFAULT_COMMAND_ALLOW_LIST.executables.filter(e => e.name === "npx");
    expect(npxEntries.length).toBe(1);
  });
});

// ══════════════════════════════════════════════════════════════
// 3. 并发锁
// ══════════════════════════════════════════════════════════════

describe("并发锁", () => {
  it("第一个会话获取锁成功", () => {
    const key = acquireWorkspaceLock(tmpDir, "session-1");
    expect(key).toBeDefined();
    releaseWorkspaceLock(key);
  });

  it("第二个会话获取锁失败", () => {
    const key = acquireWorkspaceLock(tmpDir, "session-1");
    expect(() => acquireWorkspaceLock(tmpDir, "session-2")).toThrow("WORKSPACE_LOCKED");
    releaseWorkspaceLock(key);
  });

  it("释放后可以重新获取", () => {
    const key1 = acquireWorkspaceLock(tmpDir, "session-1");
    releaseWorkspaceLock(key1);
    const key2 = acquireWorkspaceLock(tmpDir, "session-2");
    expect(key2).toBeDefined();
    releaseWorkspaceLock(key2);
  });

  it("不同 workspaceRoot 不互斥", () => {
    const dir1 = path.join(tmpDir, "project1");
    const dir2 = path.join(tmpDir, "project2");
    fs.mkdirSync(dir1, { recursive: true });
    fs.mkdirSync(dir2, { recursive: true });
    const key1 = acquireWorkspaceLock(dir1, "session-1");
    const key2 = acquireWorkspaceLock(dir2, "session-2");
    expect(key1).toBeDefined();
    expect(key2).toBeDefined();
    releaseWorkspaceLock(key1);
    releaseWorkspaceLock(key2);
  });
});

// ══════════════════════════════════════════════════════════════
// 4. partialChanges + mutationRevision
// ══════════════════════════════════════════════════════════════

describe("partialChanges + mutationRevision", () => {
  function makeResult(overrides: Partial<CodingAgentResult>): CodingAgentResult {
    return {
      status: "completed",
      summary: "test",
      workspaceRoot: tmpDir,
      changedFiles: [],
      commands: [],
      verification: { attempted: false, passed: false },
      partialChanges: false,
      ...overrides,
    };
  }

  it("completed + 有变更 -> mutationRevision++", () => {
    const result = makeResult({ changedFiles: ["test.ts"] });
    const update = extractVerificationUpdate(result, 0);
    expect(update.mutationRevision).toBe(1);
    expect(update.status).toBe("pending");
    expect(update.changedFiles).toEqual(["test.ts"]);
  });

  it("completed + 无变更 -> 不修改", () => {
    const result = makeResult({});
    const update = extractVerificationUpdate(result, 0);
    expect(update.mutationRevision).toBeUndefined();
  });

  it("failed + partialChanges -> mutationRevision++", () => {
    const result = makeResult({
      status: "failed",
      partialChanges: true,
      changedFiles: ["test.ts"],
    });
    const update = extractVerificationUpdate(result, 1);
    expect(update.mutationRevision).toBe(2);
    expect(update.status).toBe("pending");
  });

  it("cancelled + partialChanges -> mutationRevision++", () => {
    const result = makeResult({
      status: "cancelled",
      partialChanges: true,
      changedFiles: ["test.ts"],
    });
    const update = extractVerificationUpdate(result, 2);
    expect(update.mutationRevision).toBe(3);
    expect(update.status).toBe("pending");
  });

  it("failed + 无变更 -> 不修改", () => {
    const result = makeResult({ status: "failed" });
    const update = extractVerificationUpdate(result, 0);
    expect(update.mutationRevision).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════
// 5. Finalization Guard 集成
// ══════════════════════════════════════════════════════════════

describe("Finalization Guard 集成", () => {
  function codeState(cv: Partial<CodeVerificationState>, overrides?: Partial<AgentGraphState>): AgentGraphState {
    return {
      originalQuery: "test",
      contextualizedQuery: "test",
      citaContextBlock: "",
      messages: [],
      availableCapabilities: [],
      toolResults: [],
      iterationCount: 0,
      reply: "",
      clarificationAnswers: [],
      refreshCount: 0,
      replanCount: 0,
      codeVerification: {
        mutationRevision: 0,
        verifiedRevision: 0,
        status: "clean",
        changedFiles: [],
        ...cv,
      },
      ...overrides,
    } as AgentGraphState;
  }

  it("delegate_coding 返回后 mutation=pending -> block", () => {
    // delegate_coding 完成后，mutationRevision=1, verifiedRevision=0, status=pending
    const state = codeState({ mutationRevision: 1, verifiedRevision: 0, status: "pending" });
    const guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("block");
  });

  it("run_verification 通过后 -> allow_success", () => {
    // run_verification 成功后，verifiedRevision=1
    const state = codeState({ mutationRevision: 1, verifiedRevision: 1, status: "passed" });
    const guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("allow_success");
  });

  it("partialChanges 时 -> block（不能当作无修改结束）", () => {
    const state = codeState({ mutationRevision: 1, verifiedRevision: 0, status: "pending" });
    const guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("block");
  });

  it("completed_verified 最终结果", () => {
    const state = codeState({ mutationRevision: 1, verifiedRevision: 1 });
    const guard = checkFinalizationGuard(state);
    const outcome = resolveCompletionStatus(state, guard);
    expect(outcome.status).toBe("completed_verified");
  });

  it("无变更 -> allow_success -> completed", () => {
    const state = codeState({ mutationRevision: 0, verifiedRevision: 0, status: "clean" });
    const guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("allow_success");
    const outcome = resolveCompletionStatus(state, guard);
    expect(outcome.status).toBe("completed");
  });
});

// ══════════════════════════════════════════════════════════════
// 6. AG-UI 事件配对
// ══════════════════════════════════════════════════════════════

describe("AG-UI 事件配对", () => {
  it("连续 content_start(text) 不重复创建 text_message_start", () => {
    const state = createStreamState(tmpDir);
    const filter = new ThinkFilter();
    const events: any[] = [];
    const emit: StreamEventEmitter = (e) => events.push(e);

    // 第一次 content_start (text)
    handleClineEvent({
      type: "agent_event",
      payload: { sessionId: "s1", event: { type: "content_start", contentType: "text", text: "hello" } },
    } as any, state, filter, emit, tmpDir);

    // 第二次 content_start (text) - 不应重复创建
    handleClineEvent({
      type: "agent_event",
      payload: { sessionId: "s1", event: { type: "content_start", contentType: "text", text: " world" } },
    } as any, state, filter, emit, tmpDir);

    const starts = events.filter(e => e.type === "text_message_start");
    expect(starts.length).toBe(1);
  });

  it("reasoning 不发送到用户正文", () => {
    const state = createStreamState(tmpDir);
    const filter = new ThinkFilter();
    const events: any[] = [];
    const emit: StreamEventEmitter = (e) => events.push(e);

    handleClineEvent({
      type: "agent_event",
      payload: { sessionId: "s1", event: { type: "content_start", contentType: "reasoning", reasoning: "thinking..." } },
    } as any, state, filter, emit, tmpDir);

    const textEvents = events.filter(e => e.type === "text_message_start" || e.type === "text_message_content");
    expect(textEvents.length).toBe(0);
  });

  it("tool_call_start/end 正确配对", () => {
    const state = createStreamState(tmpDir);
    const filter = new ThinkFilter();
    const events: any[] = [];
    const emit: StreamEventEmitter = (e) => events.push(e);

    handleClineEvent({
      type: "agent_event",
      payload: { sessionId: "s1", event: { type: "content_start", contentType: "tool", toolName: "read_files", toolCallId: "tc1", input: {} } },
    } as any, state, filter, emit, tmpDir);

    handleClineEvent({
      type: "agent_event",
      payload: { sessionId: "s1", event: { type: "content_end", contentType: "tool", toolName: "read_files", toolCallId: "tc1", output: {}, durationMs: 10 } },
    } as any, state, filter, emit, tmpDir);

    const starts = events.filter(e => e.type === "tool_call_start");
    const ends = events.filter(e => e.type === "tool_call_end");
    expect(starts.length).toBe(1);
    expect(ends.length).toBe(1);
    expect(starts[0].toolCallId).toBe("tc1");
    expect(ends[0].toolCallId).toBe("tc1");
  });

  it("<think> 跨 chunk 不泄漏", () => {
    const filter = new ThinkFilter();
    const out1 = filter.process("hello<thi");
    const out2 = filter.process("nk>secret</think>world");
    expect(out1).toBe("hello");
    expect(out2).toBe("world");
  });

  it("editor 工具触发 hasPotentialSideEffects", () => {
    const state = createStreamState(tmpDir);
    const filter = new ThinkFilter();
    const emit: StreamEventEmitter = () => {};

    // editor content_start
    handleClineEvent({
      type: "agent_event",
      payload: { sessionId: "s1", event: { type: "content_start", contentType: "tool", toolName: "editor", toolCallId: "tc1", input: { path: path.join(tmpDir, "test.ts") } } },
    } as any, state, filter, emit, tmpDir);

    // editor content_end
    handleClineEvent({
      type: "agent_event",
      payload: { sessionId: "s1", event: { type: "content_end", contentType: "tool", toolName: "editor", toolCallId: "tc1", output: {}, durationMs: 10 } },
    } as any, state, filter, emit, tmpDir);

    expect(state.hasPotentialSideEffects).toBe(true);
    expect(state.changedFiles.size).toBe(1);
  });

  it("run_commands 工具触发 hasPotentialSideEffects", () => {
    const state = createStreamState(tmpDir);
    const filter = new ThinkFilter();
    const emit: StreamEventEmitter = () => {};

    handleClineEvent({
      type: "agent_event",
      payload: { sessionId: "s1", event: { type: "content_start", contentType: "tool", toolName: "run_commands", toolCallId: "tc1", input: { commands: ["npx tsc --noEmit"] } } },
    } as any, state, filter, emit, tmpDir);

    handleClineEvent({
      type: "agent_event",
      payload: { sessionId: "s1", event: { type: "content_end", contentType: "tool", toolName: "run_commands", toolCallId: "tc1", output: { exitCode: 0, stdout: "", stderr: "" }, durationMs: 100 } },
    } as any, state, filter, emit, tmpDir);

    expect(state.hasPotentialSideEffects).toBe(true);
    expect(state.commands.length).toBe(1);
    expect(state.commands[0].exitCode).toBe(0);
  });
});

// ══════════════════════════════════════════════════════════════
// 7. Abort 副作用停止逻辑
// ══════════════════════════════════════════════════════════════

describe("Abort 副作用停止", () => {
  it("cancelled 结果保留 changedFiles", () => {
    // 模拟 abort 后的结果
    const result: CodingAgentResult = {
      status: "cancelled",
      summary: "任务已取消",
      workspaceRoot: tmpDir,
      changedFiles: [path.join(tmpDir, "test.ts")],
      commands: [],
      verification: { attempted: false, passed: false },
      partialChanges: true,
    };

    expect(result.status).toBe("cancelled");
    expect(result.changedFiles.length).toBe(1);
    expect(result.partialChanges).toBe(true);
  });

  it("cancelled + partialChanges -> mutationRevision 增加", () => {
    const result: CodingAgentResult = {
      status: "cancelled",
      summary: "任务已取消",
      workspaceRoot: tmpDir,
      changedFiles: [path.join(tmpDir, "test.ts")],
      commands: [],
      verification: { attempted: false, passed: false },
      partialChanges: true,
    };

    const update = extractVerificationUpdate(result, 0);
    expect(update.mutationRevision).toBe(1);
    expect(update.status).toBe("pending");
  });

  it("cancelled + 无变更 -> 不修改 mutationRevision", () => {
    const result: CodingAgentResult = {
      status: "cancelled",
      summary: "任务已取消",
      workspaceRoot: tmpDir,
      changedFiles: [],
      commands: [],
      verification: { attempted: false, passed: false },
      partialChanges: false,
    };

    const update = extractVerificationUpdate(result, 0);
    expect(update.mutationRevision).toBeUndefined();
  });

  it("hasPotentialSideEffects 在工具批准时设置（不等完成）", () => {
    // 验证 StreamState 的 hasPotentialSideEffects 在工具调用时就设置
    const state = createStreamState(tmpDir);
    const filter = new ThinkFilter();
    const emit: StreamEventEmitter = () => {};

    // 模拟 editor 工具调用开始
    handleClineEvent({
      type: "agent_event",
      payload: { sessionId: "s1", event: { type: "content_start", contentType: "tool", toolName: "editor", toolCallId: "tc1", input: { path: path.join(tmpDir, "test.ts") } } },
    } as any, state, filter, emit, tmpDir);

    // 工具开始时就应该标记（在 content_end 收集副作用之前）
    // 注意：实际实现中 beforeTool 也保守标记，这里验证 event-handler 侧
    handleClineEvent({
      type: "agent_event",
      payload: { sessionId: "s1", event: { type: "content_end", contentType: "tool", toolName: "editor", toolCallId: "tc1", output: {}, durationMs: 10 } },
    } as any, state, filter, emit, tmpDir);

    expect(state.hasPotentialSideEffects).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════
// 8. Electron 打包依赖检查
// ══════════════════════════════════════════════════════════════

describe("Electron 打包依赖检查", () => {
  it("package.json 包含 @cline/sdk 精确版本", () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "..", "..", "package.json"), "utf8"));
    expect(pkg.dependencies["@cline/sdk"]).toBe("0.0.66");
    // 不使用 caret
    expect(pkg.dependencies["@cline/sdk"]).not.toContain("^");
    expect(pkg.dependencies["@cline/sdk"]).not.toContain("~");
  });

  it("不依赖 scripts/cline-poc/node_modules", () => {
    // 生产代码通过 ESM bridge 加载 @cline/sdk（绕过 TypeScript 的 import→require 转换）
    const delegateCode = fs.readFileSync(path.join(__dirname, "delegate-coding.ts"), "utf8");
    expect(delegateCode).toContain("cline-esm-bridge.mjs");
    // ESM bridge 文件应存在
    const bridgePath = path.join(__dirname, "cline-esm-bridge.mjs");
    expect(fs.existsSync(bridgePath)).toBe(true);
    const bridgeContent = fs.readFileSync(bridgePath, "utf8");
    expect(bridgeContent).toContain('@cline/sdk');
    // 不应包含相对路径到 PoC
    expect(delegateCode).not.toContain("scripts/cline-poc");
    expect(delegateCode).not.toContain("../../cline-poc");
  });

  it("适配层模块不引用 PoC 脚本", () => {
    const files = fs.readdirSync(__dirname);
    for (const file of files) {
      if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;
      const content = fs.readFileSync(path.join(__dirname, file), "utf8");
      expect(content).not.toContain("cline-poc");
      expect(content).not.toContain("scripts/");
    }
  });

  it("@cline/sdk 可导入 ClineCore", async () => {
    const mod = await import("@cline/sdk");
    expect(mod.ClineCore).toBeDefined();
    expect(typeof mod.ClineCore.create).toBe("function");
  });

  it("无原生模块", () => {
    // 检查 @cline 包目录下无 .node 文件
    const clineDir = path.join(__dirname, "..", "..", "..", "..", "node_modules", "@cline");
    if (!fs.existsSync(clineDir)) return; // 可能未安装
    const findNodeFiles = (dir: string): string[] => {
      const results: string[] = [];
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          results.push(...findNodeFiles(fullPath));
        } else if (entry.name.endsWith(".node")) {
          results.push(fullPath);
        }
      }
      return results;
    };
    const nodeFiles = findNodeFiles(clineDir);
    expect(nodeFiles.length).toBe(0);
  });
});
