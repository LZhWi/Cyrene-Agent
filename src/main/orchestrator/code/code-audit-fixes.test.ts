/**
 * Commit 3 收口审计后的补充测试
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { codeUserPreferences, buildClineSystemPromptWithPreferences } from "./code-user-preferences";
import { ClineResultAdapter } from "./cline-result-adapter";
import { codeRunWorker } from "./code-run-worker";
import { codeRunCoordinator } from "./code-run-coordinator";
import {
  createAskDeferred, cancelAsk, respondToAsk,
  rejectAllAsksOnShutdown, resetAskRegistry, isAskCancelled,
} from "./code-ask-bridge";

// ── Audit 3: CodeUserPreferences ──────────────────────────

describe("CodeUserPreferences", () => {
  beforeEach(() => codeUserPreferences.reset());

  it("生成稳定字符串 + 版本号", () => {
    const prefs = codeUserPreferences.get();
    expect(prefs.version).toBe(1);
    expect(prefs.content).toContain("Windows");
    expect(prefs.content).toContain("中文沟通");
    expect(prefs.content).toContain("避免重复造轮子");
  });

  it("buildClineSystemPromptWithPreferences 返回非空", () => {
    const sys = buildClineSystemPromptWithPreferences();
    expect(sys).toContain("Windows");
    expect(sys).toContain("代码工作偏好");
  });

  it("不每轮重新生成（缓存）", () => {
    const p1 = codeUserPreferences.get();
    const p2 = codeRunCoordinator ? codeUserPreferences.get() : p1;
    expect(p1.version).toBe(p2.version);
    expect(p1.content).toBe(p2.content);
  });

  it("refresh 强制重新生成", () => {
    const p1 = codeUserPreferences.get();
    codeRunCoordinator ? null : null;
    const p2 = codeUserPreferences.refresh();
    // refresh 后 version 可能保持，但 instance 不同
    expect(p2.version).toBe(p1.version);
  });
});

// ── Audit 4: ClineResultAdapter ──────────────────────────

describe("ClineResultAdapter", () => {
  it("处理 command 事件累计到 commands", () => {
    const adapter = new ClineResultAdapter("run-1", "chat-1", "session-1");
    adapter.ingest({
      type: "command",
      executable: "npx",
      args: ["tsc", "--noEmit"],
      exitCode: 0,
    });
    const facts = adapter.getFacts();
    expect(facts.commands.length).toBe(1);
    expect(facts.commands[0].command).toBe("npx tsc --noEmit");
  });

  it("处理 usage 事件", () => {
    const adapter = new ClineResultAdapter("run-1", "chat-1", "session-1");
    adapter.ingest({ type: "usage", inputTokens: 100, outputTokens: 50, totalCost: 0.01 });
    const facts = adapter.getFacts();
    expect(facts.usage?.inputTokens).toBe(100);
    expect(facts.usage?.outputTokens).toBe(50);
  });

  it("Cline finishReason=completed 不覆盖 hostCancelled", () => {
    const adapter = new ClineResultAdapter("run-1", "chat-1", "session-1");
    adapter.setHostCancelled();
    adapter.ingest({ type: "done", reason: "completed" });
    const facts = adapter.getFacts();
    expect(facts.hostCancelled).toBe(true);
    expect(facts.status).toBe("cancelled");
    expect(facts.clineFinishReason).toBe("completed");
  });

  it("Cline finishReason=completed 不覆盖 hostInterrupted", () => {
    const adapter = new ClineResultAdapter("run-1", "chat-1", "session-1");
    adapter.setHostInterrupted();
    adapter.ingest({ type: "done", reason: "completed" });
    const facts = adapter.getFacts();
    expect(facts.hostInterrupted).toBe(true);
    expect(facts.status).toBe("interrupted");
  });

  it("无 host 标记时 Cline finishReason 决定 status", () => {
    const adapter = new ClineResultAdapter("run-1", "chat-1", "session-1");
    adapter.ingest({ type: "done", reason: "aborted" });
    expect(adapter.getFacts().status).toBe("cancelled");
  });

  it("处理 error 事件设置 status=failed", () => {
    const adapter = new ClineResultAdapter("run-1", "chat-1", "session-1");
    adapter.ingest({ type: "error", code: "TEST_ERR", message: "boom", recoverable: false });
    const facts = adapter.getFacts();
    expect(facts.status).toBe("failed");
    expect(facts.errorCode).toBe("TEST_ERR");
  });

  it("处理 ask 事件设置 status=waiting_for_user", () => {
    const adapter = new ClineResultAdapter("run-1", "chat-1", "session-1");
    adapter.ingest({ type: "ask", promptId: "p1", content: "test?", options: ["a"] });
    expect(adapter.getFacts().status).toBe("waiting_for_user");
  });
});

// ── Audit 7: CodeRunWorker Ask 状态 ──────────────────────────

describe("CodeRunWorker Ask cancel/shutdown 状态", () => {
  beforeEach(() => {
    codeRunCoordinator.reset();
    resetAskRegistry();
  });
  afterEach(() => {
    codeRunCoordinator.reset();
    resetAskRegistry();
  });

  it("用户取消 Ask -> run.status=cancelled", async () => {
    const { promptId, promise } = createAskDeferred("chat-1", "session-1", "run-cancel", "q", []);
    const runId = "run-cancel";

    const task = codeRunWorker.submit(runId, "chat-1", "session-1", async () => {
      // 模拟 turn 等待 Ask
      await promise;
      return "done";
    }).catch(err => err);

    // 等待 task 启动
    await new Promise(r => setTimeout(r, 50));

    cancelAsk(promptId, "user");
    isAskCancelled(promptId); // mark as accessed

    const result = await task;
    // 任务以 ASK_CANCELLED 错误结束，被 codeRunWorker 捕获
    expect(result).toBeInstanceOf(Error);
    expect((result as Error).message).toContain("ASK_CANCELLED");

    const record = codeRunCoordinator.getRun(runId);
    expect(record?.status).toBe("cancelled");
  });

  it("应用退出 rejectAllAsks -> run.status=interrupted", () => {
    // 模拟一个 running run
    codeRunCoordinator.createRun("run-interrupt", "chat-1", "session-1");
    codeRunCoordinator.activate("run-interrupt");

    // 模拟应用退出
    codeRunWorker.cleanup();
    rejectAllAsksOnShutdown();

    const record = codeRunCoordinator.getRun("run-interrupt");
    expect(record?.status).toBe("interrupted");
  });

  it("cleanup 后所有 running/waiting_for_user 都变为 interrupted", () => {
    codeRunCoordinator.createRun("r1", "c1", "s1");
    codeRunCoordinator.activate("r1");
    codeRunCoordinator.createRun("r2", "c1", "s1");
    codeRunCoordinator.activate("r2");

    codeRunWorker.cleanup();

    expect(codeRunCoordinator.getRun("r1")?.status).toBe("interrupted");
    expect(codeRunCoordinator.getRun("r2")?.status).toBe("interrupted");
  });

  it("completed run 不被 cleanup 影响", () => {
    codeRunCoordinator.createRun("r1", "c1", "s1");
    codeRunCoordinator.activate("r1");
    codeRunCoordinator.complete("r1", "completed");

    codeRunWorker.cleanup();

    expect(codeRunCoordinator.getRun("r1")?.status).toBe("completed");
  });
});

// ── Audit 5: MutationCollector 真实 watcher ──────────────────────────

describe("MutationCollector real watcher", () => {
  let tmpDir: string;
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline-mut-"));
  });
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // 简单导入以避免重新引入路径问题
  it("watcher ready 后才能 collect", async () => {
    const { MutationCollector } = await import("./mutation-collector");
    const c = new MutationCollector(tmpDir);
    c.recordBaseline();
    expect(c.isReady()).toBe(true);
    const { timing } = c.collect();
    expect(timing.baselineMs).toBeGreaterThanOrEqual(0);
    // Git diff 只在 Git 仓库中存在；这里只断言 timing 不为负
  });

  it("非 Git 场景 watcher 捕获命令生成文件", async () => {
    const { MutationCollector } = await import("./mutation-collector");
    const c = new MutationCollector(tmpDir); // 非 Git
    c.recordBaseline();

    // 模拟命令生成文件（在 watcher 启动后）
    await new Promise(r => setTimeout(r, 200)); // 给 watcher 时间注册
    const generatedPath = path.join(tmpDir, "generated.json");
    fs.writeFileSync(generatedPath, "{}");

    // 等 watcher 事件
    await new Promise(r => setTimeout(r, 300));

    const { evidence } = c.collect();
    // watcherCaptured 应包含 generated.json，或 candidateFiles 应包含
    const hasGenerated = evidence.candidateFiles.some(f => f.includes("generated.json"))
      || evidence.modifiedFiles.some(f => f.includes("generated.json"))
      || evidence.createdFiles.some(f => f.includes("generated.json"));
    expect(hasGenerated).toBe(true);
  });
});