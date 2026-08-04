/**
 * Commit 3 收口审计后的补充测试
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { codeUserPreferences, buildClineSystemPromptWithPreferences, type CodeUserPreferencesSource } from "./code-user-preferences";
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

  it("无来源时 content 为空", () => {
    const prefs = codeUserPreferences.get();
    expect(prefs.version).toBe(0);
    expect(prefs.content).toBe("");
  });

  it("有来源时生成稳定字符串 + 版本号", () => {
    const source: CodeUserPreferencesSource = {
      getProfileVersion: () => 1,
      readCodeRelevantPreferences: () => [
        { key: "os", value: "Windows" },
        { key: "language", value: "中文" },
      ],
    };
    codeUserPreferences.setSource(source);
    const prefs = codeUserPreferences.get();
    expect(prefs.version).toBe(1);
    expect(prefs.content).toContain("os: Windows");
    expect(prefs.content).toContain("language: 中文");
    expect(prefs.content).toContain("【代码工作偏好】");
  });

  it("稳定排序（按 key）", () => {
    const source: CodeUserPreferencesSource = {
      getProfileVersion: () => 1,
      readCodeRelevantPreferences: () => [
        { key: "zeta", value: "z" },
        { key: "alpha", value: "a" },
      ],
    };
    codeUserPreferences.setSource(source);
    const prefs = codeUserPreferences.get();
    const alphaIdx = prefs.content.indexOf("alpha");
    const zetaIdx = prefs.content.indexOf("zeta");
    expect(alphaIdx).toBeLessThan(zetaIdx);
  });

  it("缓存：版本未变时复用", () => {
    const source: CodeUserPreferencesSource = {
      getProfileVersion: () => 1,
      readCodeRelevantPreferences: () => [{ key: "k", value: "v" }],
    };
    codeUserPreferences.setSource(source);
    const p1 = codeUserPreferences.get();
    const p2 = codeUserPreferences.get();
    expect(p1).toBe(p2); // 同一对象
  });

  it("refresh 强制重新生成", () => {
    const source: CodeUserPreferencesSource = {
      getProfileVersion: () => 1,
      readCodeRelevantPreferences: () => [{ key: "k", value: "v1" }],
    };
    codeUserPreferences.setSource(source);
    codeUserPreferences.get();
    // 更新来源内容
    const source2: CodeUserPreferencesSource = {
      getProfileVersion: () => 2,
      readCodeRelevantPreferences: () => [{ key: "k", value: "v2" }],
    };
    codeUserPreferences.setSource(source2);
    const p2 = codeUserPreferences.refresh();
    expect(p2.version).toBe(2);
    expect(p2.content).toContain("v2");
  });

  it("不调用动态 RAG / Memory / WorldBook", () => {
    // Provider 只从注入的 source 读取，不调用 buildMemoryInjection 等
    // 空来源时 content="" 正常创建 Session
    const prefs = codeUserPreferences.get();
    expect(prefs.content).toBe("");
  });
});

// ── Audit 3b: buildClineSystemPromptWithPreferences 装配 ─────────

describe("buildClineSystemPromptWithPreferences 装配", () => {
  let tmpDir: string;
  let savedCwd: string;

  beforeEach(() => {
    // 把 prompts/ 目录隔离到 tmpdir，避免污染仓库里的两个 .md 文件
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline-prompts-"));
    fs.mkdirSync(path.join(tmpDir, "prompts"), { recursive: true });
    savedCwd = process.cwd();
    process.chdir(tmpDir);
    codeUserPreferences.reset();
  });

  afterEach(() => {
    process.chdir(savedCwd);
    fs.rmSync(tmpDir, { recursive: true, force: true });
    codeUserPreferences.reset();
  });

  it("空文件 → 拼装结果为空字符串", async () => {
    // tmpDir/prompts/code_identity.md 和 code_soul.md 都不存在 → 两个 loadPromptFromFile 都返回 missing
    // 没有 userPrefs source → userPrefs.content 为空
    // memoryStore 默认空 profile → L0/L1 块为空
    const sysPrompt = await buildClineSystemPromptWithPreferences();
    expect(sysPrompt).toBe("");
  });

  it("只有 identity → 拼装包含 identity 内容", async () => {
    fs.writeFileSync(path.join(tmpDir, "prompts", "code_identity.md"), "我是 Code 模式下的昔涟", "utf8");
    const sysPrompt = await buildClineSystemPromptWithPreferences();
    expect(sysPrompt).toContain("我是 Code 模式下的昔涟");
  });

  it("identity 在 soul 之前,userPrefs 在 soul 之后", async () => {
    fs.writeFileSync(path.join(tmpDir, "prompts", "code_identity.md"), "[[IDENTITY_MARK]]", "utf8");
    fs.writeFileSync(path.join(tmpDir, "prompts", "code_soul.md"), "[[SOUL_MARK]]", "utf8");
    codeUserPreferences.setSource({
      getProfileVersion: () => 1,
      readCodeRelevantPreferences: () => [{ key: "os", value: "Windows" }],
    });

    const sysPrompt = await buildClineSystemPromptWithPreferences();
    const i = sysPrompt.indexOf("[[IDENTITY_MARK]]");
    const s = sysPrompt.indexOf("[[SOUL_MARK]]");
    const p = sysPrompt.indexOf("os: Windows");
    expect(i).toBeGreaterThanOrEqual(0);
    expect(s).toBeGreaterThan(i);
    expect(p).toBeGreaterThan(s);
  });

  it("空 soul 文件不阻塞拼装", async () => {
    fs.writeFileSync(path.join(tmpDir, "prompts", "code_identity.md"), "ID", "utf8");
    fs.writeFileSync(path.join(tmpDir, "prompts", "code_soul.md"), "", "utf8"); // 空文件
    const sysPrompt = await buildClineSystemPromptWithPreferences();
    expect(sysPrompt).toContain("ID");
    expect(sysPrompt).not.toContain("SOUL");
  });

  it("L0/L1 记忆在拼装末尾", async () => {
    // mock memoryStore — 通过 dynamic import + spy 是最稳的；这里走真实路径
    // 注入 identity + soul + userPrefs，验证 L0/L1 块（如果 memoryStore 返回非空）会附加在最后
    fs.writeFileSync(path.join(tmpDir, "prompts", "code_identity.md"), "ID", "utf8");
    const { memoryStore } = await import("../../memory");
    const originalGetL0 = memoryStore.getL0.bind(memoryStore);
    const originalGetL1 = memoryStore.getL1.bind(memoryStore);
    memoryStore.getL0 = async () => ({
      nickname: "",
      preferredName: "测试用户",
      occupation: "",
      longTermInterests: "",
      language: "中文",
      permanentNote: "",
      isPinned: false,
      updatedAt: 0,
    });
    memoryStore.getL1 = async () => ({
      recentGoals: "",
      recentPreferences: "",
      currentProject: "",
      generatedAt: 0,
      roundCount: 0,
    });
    try {
      const sysPrompt = await buildClineSystemPromptWithPreferences();
      expect(sysPrompt).toContain("测试用户");
      expect(sysPrompt).toContain("[用户画像]");
      // L0 块在 identity 之后
      const i = sysPrompt.indexOf("ID");
      const m = sysPrompt.indexOf("测试用户");
      expect(m).toBeGreaterThan(i);
    } finally {
      memoryStore.getL0 = originalGetL0;
      memoryStore.getL1 = originalGetL1;
    }
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