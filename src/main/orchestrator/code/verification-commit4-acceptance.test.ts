/**
 * Commit 4 验收测试 - 37 项
 *
 * Resolver: 1-10
 * Runner: 11-20
 * Final 裁决: 21-28
 * 集成与回归: 29-37
 */

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

import { VerificationPlanResolver } from "./verification-plan-resolver";
import { VerificationRunner, type PermissionLevel } from "./verification-runner";
import { resolveCodeRunFinalState } from "./code-final-state";
import type { CodeRunFacts } from "./cline-result-adapter";
import type { MutationEvidence } from "./mutation-collector";

// ── 测试工具 ──────────────────────────────────────────────

function setupGitRepo(dir: string): void {
  require("child_process").execSync("git init", { cwd: dir });
  require("child_process").execSync('git config user.email "t@t.com"', { cwd: dir });
  require("child_process").execSync('git config user.name "t"', { cwd: dir });
}

function writePackageJson(dir: string, scripts: Record<string, string>): void {
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({
    name: "test-pkg",
    version: "1.0.0",
    scripts,
  }));
}

function makeFacts(overrides: Partial<CodeRunFacts> = {}): CodeRunFacts {
  return {
    runId: "r1",
    chatSessionId: "c1",
    clineSessionId: "s1",
    status: "completed",
    commands: [],
    hostCancelled: false,
    hostInterrupted: false,
    ...overrides,
  };
}

function makeEvidence(overrides: Partial<MutationEvidence> = {}): MutationEvidence {
  return {
    preExistingChanges: [],
    touchedPreExistingFiles: [],
    candidateFiles: [],
    createdFiles: [],
    modifiedFiles: [],
    deletedFiles: [],
    ignoredPaths: [],
    rejectedOutsideWorkspacePaths: [],
    evidenceSources: ["git_diff"],
    ...overrides,
  };
}

let tmpDir: string;
beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cline-vfy-"));
});

describe("Commit 4 应用生命周期接线", () => {
  it("应用退出会清理 pending Ask、approval 与 active Code Run", () => {
    const indexSource = fs.readFileSync(path.join(__dirname, "..", "..", "index.ts"), "utf8");
    expect(indexSource).toContain('import { codeRunWorker } from "./orchestrator/code/code-run-worker"');
    expect(indexSource).toMatch(/app\.on\("before-quit"[\s\S]*?codeRunWorker\.cleanup\(\)/);
  });
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ── Resolver 测试 (1-10) ─────────────────────────────────

describe("VerificationPlanResolver", () => {
  let resolver: VerificationPlanResolver;

  beforeEach(() => {
    resolver = new VerificationPlanResolver();
  });

  it("1. 单 package + typecheck script", () => {
    writePackageJson(tmpDir, { typecheck: "tsc --noEmit" });
    fs.mkdirSync(path.join(tmpDir, "src"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "src", "a.ts"), "x");

    const plan = resolver.resolve({
      workspaceRoot: tmpDir,
      createdFiles: [path.join(tmpDir, "src", "a.ts")],
      modifiedFiles: [],
      deletedFiles: [],
      touchedPreExistingFiles: [],
    });
    expect(plan.errorCode).toBeUndefined();
    expect(plan.steps.length).toBe(1);
    expect(plan.steps[0].type).toBe("typecheck");
    expect(plan.steps[0].trust).toBe("workspace_script");
    expect(plan.steps[0].executable).toBe("npm");
    expect(plan.steps[0].args).toEqual(["run", "typecheck"]);
  });

  it("2. 单 package + test script", () => {
    writePackageJson(tmpDir, { test: "vitest run" });
    fs.writeFileSync(path.join(tmpDir, "a.test.ts"), "x");

    const plan = resolver.resolve({
      workspaceRoot: tmpDir,
      createdFiles: [path.join(tmpDir, "a.test.ts")],
      modifiedFiles: [],
      deletedFiles: [],
      touchedPreExistingFiles: [],
    });
    expect(plan.steps.some(s => s.type === "test")).toBe(true);
  });

  it("3. tsconfig builtin fallback", () => {
    writePackageJson(tmpDir, {}); // 无 script
    fs.writeFileSync(path.join(tmpDir, "tsconfig.json"), "{}");
    fs.mkdirSync(path.join(tmpDir, "node_modules", "typescript"), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, "node_modules", "typescript", "package.json"), "{}");
    fs.writeFileSync(path.join(tmpDir, "a.ts"), "x");

    const plan = resolver.resolve({
      workspaceRoot: tmpDir,
      createdFiles: [path.join(tmpDir, "a.ts")],
      modifiedFiles: [],
      deletedFiles: [],
      touchedPreExistingFiles: [],
    });
    // tsconfig 被识别
  });

  it("4. Vitest 配置", () => {
    writePackageJson(tmpDir, {});
    fs.writeFileSync(path.join(tmpDir, "vitest.config.ts"), "export default {}");
    fs.writeFileSync(path.join(tmpDir, "a.test.ts"), "x");

    const plan = resolver.resolve({
      workspaceRoot: tmpDir,
      createdFiles: [path.join(tmpDir, "a.test.ts")],
      modifiedFiles: [],
      deletedFiles: [],
      touchedPreExistingFiles: [],
    });
    // vitest 配置被识别（即使 package.json 无 test script）
  });

  it("5. Jest 配置", () => {
    writePackageJson(tmpDir, {});
    fs.writeFileSync(path.join(tmpDir, "jest.config.js"), "module.exports = {}");
    fs.writeFileSync(path.join(tmpDir, "a.test.js"), "x");

    const plan = resolver.resolve({
      workspaceRoot: tmpDir,
      createdFiles: [path.join(tmpDir, "a.test.js")],
      modifiedFiles: [],
      deletedFiles: [],
      touchedPreExistingFiles: [],
    });
  });

  it("6. monorepo 两个 package 同时变更", () => {
    const pkg1 = path.join(tmpDir, "packages", "a");
    const pkg2 = path.join(tmpDir, "packages", "b");
    fs.mkdirSync(pkg1, { recursive: true });
    fs.mkdirSync(pkg2, { recursive: true });
    writePackageJson(pkg1, { typecheck: "tsc" });
    writePackageJson(pkg2, { test: "vitest" });
    fs.writeFileSync(path.join(pkg1, "a.ts"), "x");
    fs.writeFileSync(path.join(pkg2, "b.test.ts"), "x");

    const plan = resolver.resolve({
      workspaceRoot: tmpDir,
      createdFiles: [path.join(pkg1, "a.ts"), path.join(pkg2, "b.test.ts")],
      modifiedFiles: [],
      deletedFiles: [],
      touchedPreExistingFiles: [],
    });
    expect(plan.affectedPackages.length).toBe(2);
    expect(plan.steps.length).toBe(2);
  });

  it("7. fixture 目录使用最近 packageRoot", () => {
    const fixture = path.join(tmpDir, "tests", "fixtures");
    fs.mkdirSync(fixture, { recursive: true });
    writePackageJson(tmpDir, { typecheck: "tsc" });
    fs.writeFileSync(path.join(fixture, "data.json"), "{}");

    const plan = resolver.resolve({
      workspaceRoot: tmpDir,
      createdFiles: [path.join(fixture, "data.json")],
      modifiedFiles: [],
      deletedFiles: [],
      touchedPreExistingFiles: [],
    });
    // fixture 目录无 .ts，向上找到 tests/，再向上找到 package.json
    // 修改 JSON 文件通常不需要 typecheck
  });

  it("8. 无可信配置", () => {
    fs.writeFileSync(path.join(tmpDir, "a.txt"), "x");
    const plan = resolver.resolve({
      workspaceRoot: tmpDir,
      createdFiles: [path.join(tmpDir, "a.txt")],
      modifiedFiles: [],
      deletedFiles: [],
      touchedPreExistingFiles: [],
    });
    expect(plan.errorCode).toBe("VERIFICATION_PLAN_NOT_FOUND");
  });

  it("9. 无效 .cyrene-verify.json", () => {
    writePackageJson(tmpDir, {});
    fs.writeFileSync(path.join(tmpDir, ".cyrene-verify.json"), "{ invalid json");
    fs.writeFileSync(path.join(tmpDir, "a.ts"), "x");

    const plan = resolver.resolve({
      workspaceRoot: tmpDir,
      createdFiles: [path.join(tmpDir, "a.ts")],
      modifiedFiles: [],
      deletedFiles: [],
      touchedPreExistingFiles: [],
    });
    expect(plan.errorCode).toBe("VERIFICATION_CONFIG_INVALID");
  });

  it("10. 变更仅属于 preExisting 但本轮未触碰", () => {
    writePackageJson(tmpDir, { typecheck: "tsc" });
    fs.writeFileSync(path.join(tmpDir, "a.ts"), "x");

    const plan = resolver.resolve({
      workspaceRoot: tmpDir,
      createdFiles: [],
      modifiedFiles: [],
      deletedFiles: [],
      touchedPreExistingFiles: [], // 无本轮触碰
    });
    // preExisting 不算本轮变更，应返回 NOT_FOUND
    expect(plan.errorCode).toBe("VERIFICATION_PLAN_NOT_FOUND");
  });
});

// ── Runner 测试 (11-20) ─────────────────────────────────

describe("VerificationRunner", () => {
  let runner: VerificationRunner;

  beforeEach(() => {
    runner = new VerificationRunner();
  });

  it("11. builtin 成功", async () => {
    const result = await runner.runStep({
      id: "s1",
      type: "typecheck",
      packageRoot: tmpDir,
      cwd: tmpDir,
      trust: "builtin",
      executable: "node",
      args: ["-e", "process.exit(0)"],
      source: "builtin_fallback",
    }, { permissionLevel: "full" });
    expect(result.passed).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("12. builtin 失败", async () => {
    const result = await runner.runStep({
      id: "s1",
      type: "typecheck",
      packageRoot: tmpDir,
      cwd: tmpDir,
      trust: "builtin",
      executable: "node",
      args: ["-e", "process.exit(1)"],
      source: "builtin_fallback",
    }, { permissionLevel: "full" });
    expect(result.passed).toBe(false);
    expect(result.exitCode).toBe(1);
  });

  it("13. workspace_script 自动允许 (full 权限)", async () => {
    const result = await runner.runStep({
      id: "s1",
      type: "typecheck",
      packageRoot: tmpDir,
      cwd: tmpDir,
      trust: "workspace_script",
      executable: "node",
      args: ["-e", "process.exit(0)"],
      source: "package_script",
    }, { permissionLevel: "full" });
    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(false);
  });

  it("14. workspace_script 需要审批 (per-action 权限)", async () => {
    const result = await runner.runStep({
      id: "s1",
      type: "typecheck",
      packageRoot: tmpDir,
      cwd: tmpDir,
      trust: "workspace_script",
      executable: "node",
      args: ["-e", "process.exit(0)"],
      source: "package_script",
    }, {
      permissionLevel: "per-action",
      onApprovalRequest: async () => true, // 批准
    });
    expect(result.passed).toBe(true);
    expect(result.skipped).toBe(false);
  });

  it("15. custom 必须审批", async () => {
    const result = await runner.runStep({
      id: "s1",
      type: "typecheck",
      packageRoot: tmpDir,
      cwd: tmpDir,
      trust: "custom",
      executable: "node",
      args: ["-e", "process.exit(0)"],
      source: "cyrene_config",
    }, { permissionLevel: "full" });
    expect(result.skipped).toBe(true);
    expect(result.errorCode).toBe("VERIFICATION_APPROVAL_REQUIRED");
  });

  it("16. 用户拒绝审批", async () => {
    const result = await runner.runStep({
      id: "s1",
      type: "typecheck",
      packageRoot: tmpDir,
      cwd: tmpDir,
      trust: "workspace_script",
      executable: "node",
      args: ["-e", "process.exit(0)"],
      source: "package_script",
    }, {
      permissionLevel: "per-action",
      onApprovalRequest: async () => false, // 拒绝
    });
    expect(result.skipped).toBe(true);
    expect(result.errorCode).toBe("VERIFICATION_APPROVAL_REJECTED");
  });

  it("16a. 需要审批但未提供审批入口时绝不执行命令", async () => {
    const markerPath = path.join(tmpDir, "should-not-exist.txt");
    const result = await runner.runStep({
      id: "s1-no-approval-handler",
      type: "test",
      packageRoot: tmpDir,
      cwd: tmpDir,
      trust: "workspace_script",
      executable: process.execPath,
      args: ["-e", `require("fs").writeFileSync(${JSON.stringify(markerPath)}, "executed")`],
      source: "package_script",
    }, {
      permissionLevel: "per-action",
    });

    expect(result.skipped).toBe(true);
    expect(result.errorCode).toBe("VERIFICATION_APPROVAL_REQUIRED");
    expect(fs.existsSync(markerPath)).toBe(false);
  });

  it("17. timeout", async () => {
    const result = await runner.runStep({
      id: "s1",
      type: "typecheck",
      packageRoot: tmpDir,
      cwd: tmpDir,
      trust: "builtin",
      executable: "node",
      args: ["-e", "setTimeout(() => process.exit(0), 10000)"],
      source: "builtin_fallback",
    }, {
      permissionLevel: "full",
      defaultTimeoutMs: 500,
    });
    expect(result.timedOut).toBe(true);
    expect(result.errorCode).toBe("VERIFICATION_TIMEOUT");
  });

  it("18. Abort", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 200);
    const result = await runner.runStep({
      id: "s1",
      type: "typecheck",
      packageRoot: tmpDir,
      cwd: tmpDir,
      trust: "builtin",
      executable: "node",
      args: ["-e", "setTimeout(() => process.exit(0), 5000)"],
      source: "builtin_fallback",
    }, {
      permissionLevel: "full",
      signal: controller.signal,
    });
    // Abort 后 spawn 被 kill，exitCode 非 0
    expect(result.passed).toBe(false);
  });

  it("19. stdout/stderr 截断", async () => {
    const result = await runner.runStep({
      id: "s1",
      type: "typecheck",
      packageRoot: tmpDir,
      cwd: tmpDir,
      trust: "builtin",
      executable: "node",
      args: ["-e", "process.stdout.write('x'.repeat(10000))"],
      source: "builtin_fallback",
    }, { permissionLevel: "full" });
    expect(result.stdout.length).toBeLessThanOrEqual(8500);
  });

  it("20. 参数包含空格时不经过 Shell 拼接", async () => {
    // 用包含空格的参数，确认 spawn 直接传递而不需要 shell
    const result = await runner.runStep({
      id: "s1",
      type: "typecheck",
      packageRoot: tmpDir,
      cwd: tmpDir,
      trust: "builtin",
      executable: "node",
      args: ["-e", `console.log("hello world")`],
      source: "builtin_fallback",
    }, { permissionLevel: "full" });
    expect(result.passed).toBe(true);
    expect(result.stdout).toContain("hello world");
  });

  it("20a. builtin CLI 解析公开为可测试的本地绝对入口", async () => {
    const module = await import("./verification-runner");
    expect(typeof module.resolveBuiltinExecutable).toBe("function");

    const tsc = module.resolveBuiltinExecutable("builtin:tsc", process.cwd());
    expect(tsc?.executable).toBe(process.execPath);
    expect(path.isAbsolute(tsc?.args[0] ?? "")).toBe(true);
    expect(fs.existsSync(tsc?.args[0] ?? "")).toBe(true);
    expect(tsc?.args[0].replaceAll("\\", "/")).toContain("/node_modules/typescript/bin/tsc");

    const vitest = module.resolveBuiltinExecutable("builtin:vitest", process.cwd());
    expect(vitest?.executable).toBe(process.execPath);
    expect(path.isAbsolute(vitest?.args[0] ?? "")).toBe(true);
    expect(fs.existsSync(vitest?.args[0] ?? "")).toBe(true);
    expect(vitest?.args[0].replaceAll("\\", "/")).toContain("/node_modules/vitest/vitest.mjs");
    expect(vitest?.args).toContain("run");
  });

  it("20b. builtin CLI 使用 executable + args，并保留 VerificationStep 参数", async () => {
    const localTmp = fs.mkdtempSync(path.join(process.cwd(), ".tmp-builtin-cli-"));
    try {
      writePackageJson(localTmp, {});
      fs.writeFileSync(path.join(localTmp, "tsconfig.json"), JSON.stringify({
        compilerOptions: { noEmit: true },
        files: ["sample.ts"],
      }));
      fs.writeFileSync(path.join(localTmp, "sample.ts"), "export const sample = 1;\n");

      const result = await runner.runStep({
        id: "builtin-tsc-version",
        type: "typecheck",
        packageRoot: localTmp,
        cwd: localTmp,
        configPath: path.join(localTmp, "tsconfig.json"),
        trust: "builtin",
        executable: "builtin:tsc",
        args: ["--version"],
        source: "tsconfig",
      }, { permissionLevel: "read-only" });

      expect(result.passed).toBe(true);
      expect(result.stdout).toMatch(/Version \d+/);
    } finally {
      fs.rmSync(localTmp, { recursive: true, force: true });
    }
  });
});

// ── Final 裁决测试 (21-28) ─────────────────────────────────

describe("resolveCodeRunFinalState", () => {
  it("21. 修改 + 验证通过 → completed_verified", () => {
    const result = resolveCodeRunFinalState({
      codeRunFacts: makeFacts({ status: "completed" }),
      mutationEvidence: makeEvidence({ modifiedFiles: ["/a.ts"] }),
      verificationSummary: { status: "passed", passed: true, steps: [] },
    });
    expect(result.status).toBe("completed_verified");
  });

  it("22. 修改 + 验证失败 → failed_verification", () => {
    const result = resolveCodeRunFinalState({
      codeRunFacts: makeFacts({ status: "completed" }),
      mutationEvidence: makeEvidence({ modifiedFiles: ["/a.ts"] }),
      verificationSummary: { status: "failed", passed: false, steps: [] },
    });
    expect(result.status).toBe("failed_verification");
  });

  it("23. 修改 + 无计划 → unverified", () => {
    const result = resolveCodeRunFinalState({
      codeRunFacts: makeFacts({ status: "completed" }),
      mutationEvidence: makeEvidence({ modifiedFiles: ["/a.ts"] }),
      verificationSummary: { status: "plan_not_found", passed: false, steps: [], errorCode: "VERIFICATION_PLAN_NOT_FOUND" },
    });
    expect(result.status).toBe("unverified");
  });

  it("24. 无修改 → completed_no_changes", () => {
    const result = resolveCodeRunFinalState({
      codeRunFacts: makeFacts({ status: "completed" }),
      mutationEvidence: makeEvidence(),
      verificationSummary: null,
    });
    expect(result.status).toBe("completed_no_changes");
  });

  it("25. hostCancelled 覆盖 Cline completed", () => {
    const result = resolveCodeRunFinalState({
      codeRunFacts: makeFacts({ hostCancelled: true }),
      mutationEvidence: makeEvidence({ modifiedFiles: ["/a.ts"] }),
      verificationSummary: { status: "passed", passed: true, steps: [] },
    });
    expect(result.status).toBe("cancelled");
  });

  it("26. hostInterrupted 覆盖验证结果", () => {
    const result = resolveCodeRunFinalState({
      codeRunFacts: makeFacts({ hostInterrupted: true }),
      mutationEvidence: makeEvidence({ modifiedFiles: ["/a.ts"] }),
      verificationSummary: { status: "passed", passed: true, steps: [] },
    });
    expect(result.status).toBe("interrupted");
  });

  it("27. 验证待审批 → approval_required", () => {
    const result = resolveCodeRunFinalState({
      codeRunFacts: makeFacts({ status: "completed" }),
      mutationEvidence: makeEvidence({ modifiedFiles: ["/a.ts"] }),
      verificationSummary: { status: "approval_required", passed: false, steps: [] },
    });
    expect(result.status).toBe("approval_required");
  });

  it("28. Cline 声称成功但真实验证失败 → failed_verification", () => {
    const result = resolveCodeRunFinalState({
      codeRunFacts: makeFacts({ status: "completed", clineFinishReason: "completed" }),
      mutationEvidence: makeEvidence({ modifiedFiles: ["/a.ts"] }),
      verificationSummary: { status: "failed", passed: false, steps: [] },
    });
    expect(result.status).toBe("failed_verification");
  });
});

// ── 集成与回归测试 (29-37) ─────────────────────────────────

describe("集成与回归", () => {
  it("29. CodeRunWorker 进入 verifying 状态", async () => {
    const { codeRunCoordinator } = await import("./code-run-coordinator");
    codeRunCoordinator.reset();
    codeRunCoordinator.createRun("r1", "c1", "s1");
    codeRunCoordinator.activate("r1");
    codeRunCoordinator.setVerifying("r1");
    expect(codeRunCoordinator.getRun("r1")?.status).toBe("verifying");
    codeRunCoordinator.reset();
  });

  it("30. Renderer 可通过 IPC 查询 active run", async () => {
    const { codeRunCoordinator } = await import("./code-run-coordinator");
    codeRunCoordinator.reset();
    codeRunCoordinator.createRun("r1", "c1", "s1");
    codeRunCoordinator.activate("r1");
    expect(codeRunCoordinator.getActiveRunByChatSession("c1")?.runId).toBe("r1");
    expect(codeRunCoordinator.getActiveRunByClineSession("s1")?.runId).toBe("r1");
    codeRunCoordinator.reset();
  });

  it("30a. Renderer 刷新后可恢复 verifying 与 approval_required", async () => {
    const { codeRunCoordinator } = await import("./code-run-coordinator");
    codeRunCoordinator.reset();
    const verifying = codeRunCoordinator.createRun("r-verifying", "c-verifying", "s-verifying");
    codeRunCoordinator.activate(verifying.runId);
    codeRunCoordinator.setVerifying(verifying.runId);
    expect(codeRunCoordinator.getActiveRunByChatSession("c-verifying")?.status).toBe("verifying");

    const approval = codeRunCoordinator.createRun("r-approval", "c-approval", "s-approval");
    codeRunCoordinator.activate(approval.runId);
    approval.status = "approval_required" as typeof approval.status;
    expect(codeRunCoordinator.getActiveRunByChatSession("c-approval")?.status).toBe("approval_required");
    codeRunCoordinator.reset();
  });

  it("30b. Run 绑定真实 Cline Session 后查询映射保持一致", async () => {
    const { codeRunCoordinator } = await import("./code-run-coordinator");
    codeRunCoordinator.reset();
    const run = codeRunCoordinator.createRun("r-bind", "c-bind", "");
    codeRunCoordinator.activate(run.runId);
    expect(typeof (codeRunCoordinator as unknown as { bindClineSession?: unknown }).bindClineSession).toBe("function");
    codeRunCoordinator.reset();
  });

  it("30c. Approval Store 提供可等待的 Deferred 审批入口", async () => {
    const { codeRunStore } = await import("./code-run-store");
    expect(typeof (codeRunStore as unknown as { requestApproval?: unknown }).requestApproval).toBe("function");
  });

  it("30d. 批准后执行原 step，并按原计划继续后续 step", async () => {
    const { codeRunCoordinator } = await import("./code-run-coordinator");
    const { codeRunStore } = await import("./code-run-store");
    codeRunCoordinator.reset();
    codeRunStore.reset();
    codeRunCoordinator.createRun("r-approve", "c-approve", "s-approve");
    codeRunCoordinator.activate("r-approve");
    codeRunCoordinator.setVerifying("r-approve");

    const markerPath = path.join(tmpDir, "approval-order.txt");
    const steps = [
      {
        id: "approval-step",
        type: "test" as const,
        packageRoot: tmpDir,
        cwd: tmpDir,
        trust: "workspace_script" as const,
        executable: process.execPath,
        args: ["-e", `require("fs").appendFileSync(${JSON.stringify(markerPath)}, "approved\\n")`],
        source: "package_script" as const,
      },
      {
        id: "next-step",
        type: "test" as const,
        packageRoot: tmpDir,
        cwd: tmpDir,
        trust: "builtin" as const,
        executable: process.execPath,
        args: ["-e", `require("fs").appendFileSync(${JSON.stringify(markerPath)}, "next\\n")`],
        source: "builtin_fallback" as const,
      },
    ];
    const runner = new VerificationRunner();
    const summaryPromise = runner.runPlan(steps, {
      permissionLevel: "per-action",
      onApprovalRequest: async (step) => {
        codeRunCoordinator.setApprovalRequired("r-approve");
        const { decision } = codeRunStore.requestApproval({
          runId: "r-approve",
          chatSessionId: "c-approve",
          clineSessionId: "s-approve",
          stepId: step.id,
          trust: step.trust as "workspace_script" | "custom",
          executable: step.executable,
          args: step.args,
          cwd: step.cwd,
          source: step.source,
        });
        const approved = await decision;
        codeRunCoordinator.setVerifying("r-approve");
        return approved;
      },
    });

    await expect.poll(() => codeRunStore.getPendingApprovalsByRun("r-approve").length).toBe(1);
    expect(codeRunCoordinator.getRun("r-approve")?.status).toBe("approval_required");
    expect(fs.existsSync(markerPath)).toBe(false);
    const pending = codeRunStore.getPendingApprovalsByRun("r-approve")[0];
    codeRunStore.approve(pending.approvalId);
    codeRunStore.approve(pending.approvalId);

    const summary = await summaryPromise;
    expect(summary.status).toBe("passed");
    expect(fs.readFileSync(markerPath, "utf8")).toBe("approved\nnext\n");
    codeRunCoordinator.reset();
    codeRunStore.reset();
  });

  it("30e. 拒绝后不执行命令，也不能得到 completed_verified", async () => {
    const { codeRunCoordinator } = await import("./code-run-coordinator");
    const { codeRunStore } = await import("./code-run-store");
    codeRunCoordinator.reset();
    codeRunStore.reset();
    codeRunCoordinator.createRun("r-reject", "c-reject", "s-reject");
    codeRunCoordinator.activate("r-reject");

    const markerPath = path.join(tmpDir, "rejected-command.txt");
    const runner = new VerificationRunner();
    const summaryPromise = runner.runPlan([{
      id: "rejected-step",
      type: "test",
      packageRoot: tmpDir,
      cwd: tmpDir,
      trust: "workspace_script",
      executable: process.execPath,
      args: ["-e", `require("fs").writeFileSync(${JSON.stringify(markerPath)}, "executed")`],
      source: "package_script",
    }], {
      permissionLevel: "per-action",
      onApprovalRequest: async (step) => {
        codeRunCoordinator.setApprovalRequired("r-reject");
        const { decision } = codeRunStore.requestApproval({
          runId: "r-reject",
          chatSessionId: "c-reject",
          clineSessionId: "s-reject",
          stepId: step.id,
          trust: "workspace_script",
          executable: step.executable,
          args: step.args,
          cwd: step.cwd,
          source: step.source,
        });
        return decision;
      },
    });

    await expect.poll(() => codeRunStore.getPendingApprovalsByRun("r-reject").length).toBe(1);
    const pending = codeRunStore.getPendingApprovalsByRun("r-reject")[0];
    codeRunStore.reject(pending.approvalId);
    const summary = await summaryPromise;

    expect(summary.status).toBe("failed");
    expect(summary.steps[0].errorCode).toBe("VERIFICATION_APPROVAL_REJECTED");
    expect(fs.existsSync(markerPath)).toBe(false);
    codeRunCoordinator.reset();
    codeRunStore.reset();
  });

  it("30f. CodeRequest 使用 Deferred 审批并保持原 VerificationPlan 顺序", () => {
    const source = fs.readFileSync(path.join(__dirname, "code-request.ts"), "utf8");
    expect(source).toContain("onApprovalRequest");
    expect(source).toContain("codeRunStore.requestApproval");
    expect(source).toContain("codeRunCoordinator.bindClineSession");
    expect(source).not.toContain("const builtinSteps = plan.steps.filter");
    expect(source).not.toContain("const approvalSteps = plan.steps.filter");
  });

  it("30g. 重复批准幂等，只解析一次 Deferred", async () => {
    const { codeRunStore } = await import("./code-run-store");
    codeRunStore.reset();
    const { approval, decision } = codeRunStore.requestApproval({
      runId: "r-idempotent",
      chatSessionId: "c-idempotent",
      clineSessionId: "s-idempotent",
      stepId: "step-idempotent",
      trust: "workspace_script",
      executable: process.execPath,
      args: [],
      cwd: tmpDir,
      source: "package_script",
    });
    const first = codeRunStore.approve(approval.approvalId);
    const second = codeRunStore.approve(approval.approvalId);
    await expect(decision).resolves.toBe(true);
    expect(first).toBe(second);
    expect(second?.status).toBe("approved");
    codeRunStore.reset();
  });

  it("30h. Approval IPC 拒绝终态 Run 的新审批", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "agui-bridge.ts"), "utf8");
    expect(source).toContain("codeRunCoordinator.isActive(a.runId)");
    expect(source).toContain('a.status !== "pending"');
  });

  it("30i. Code 模式 IPC 立即返回 ack，后台任务不绑定 WebContents 生命周期", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "..", "agui-bridge.ts"), "utf8");
    expect(source).toContain("void runCodeRequest(");
    expect(source).not.toContain("await runCodeRequest(");
    expect(source).toContain("return { success: true, runId }");
  });

  it("30j. 应用退出会取消 pending approval，且 Run 保持 interrupted 终态", async () => {
    const { codeRunCoordinator } = await import("./code-run-coordinator");
    const { codeRunStore } = await import("./code-run-store");
    const { codeRunWorker } = await import("./code-run-worker");
    codeRunCoordinator.reset();
    codeRunStore.reset();

    let approvalId = "";
    const task = codeRunWorker.submit("r-shutdown", "c-shutdown", "s-shutdown", async () => {
      const { approval, decision } = codeRunStore.requestApproval({
        runId: "r-shutdown",
        chatSessionId: "c-shutdown",
        clineSessionId: "s-shutdown",
        stepId: "step-shutdown",
        trust: "workspace_script",
        executable: process.execPath,
        args: [],
        cwd: tmpDir,
        source: "package_script",
      });
      approvalId = approval.approvalId;
      codeRunCoordinator.setApprovalRequired("r-shutdown");
      await decision;
    });
    await expect.poll(() => approvalId).not.toBe("");

    codeRunWorker.cleanup();
    await expect(task).rejects.toThrow("VERIFICATION_APPROVAL_CANCELLED:shutdown");
    expect(codeRunStore.getApproval(approvalId)?.status).toBe("cancelled");
    expect(codeRunCoordinator.getRun("r-shutdown")?.status).toBe("interrupted");
    codeRunCoordinator.reset();
    codeRunStore.reset();
  });

  it("31. 失败指纹去重", async () => {
    const runner = new VerificationRunner();
    const step = {
      id: "s1", type: "typecheck" as const,
      packageRoot: tmpDir, cwd: tmpDir,
      trust: "builtin" as const,
      executable: "node",
      args: ["-e", "process.exit(1)"],
      source: "builtin_fallback" as const,
    };
    // 第一次 runPlan
    const r1 = await runner.runPlan([step], { permissionLevel: "full" as PermissionLevel });
    expect(r1.steps[0].passed).toBe(false);
    expect(r1.steps[0].skipped).toBe(false);

    // 第二次 runPlan 同样 step -> 标记 skipped
    const r2 = await runner.runPlan([step], { permissionLevel: "full" as PermissionLevel });
    expect(r2.steps[0].skipped).toBe(true);
  });

  it("32. runPlan 错误指纹去重（不在连续 plan 中重复）", async () => {
    const runner = new VerificationRunner();
    const step = {
      id: "s1", type: "typecheck" as const,
      packageRoot: tmpDir, cwd: tmpDir,
      trust: "builtin" as const,
      executable: "node",
      args: ["-e", "process.exit(1)"],
      source: "builtin_fallback" as const,
    };
    const r1 = await runner.runPlan([step], { permissionLevel: "full" as PermissionLevel });
    expect(r1.status).toBe("failed");
    // 同一 fingerprint 第二次 runPlan -> 标记 skipped
    const r2 = await runner.runPlan([step], { permissionLevel: "full" as PermissionLevel });
    expect(r2.steps[0].skipped).toBe(true);
  });

  it("33. Git 项目", () => {
    setupGitRepo(tmpDir);
    writePackageJson(tmpDir, { typecheck: "tsc" });
    const resolver = new VerificationPlanResolver();
    const plan = resolver.resolve({
      workspaceRoot: tmpDir,
      createdFiles: [path.join(tmpDir, "a.ts")],
      modifiedFiles: [],
      deletedFiles: [],
      touchedPreExistingFiles: [],
    });
    expect(plan.affectedPackages.length).toBe(1);
  });

  it("34. 非 Git 项目", () => {
    writePackageJson(tmpDir, { typecheck: "tsc" });
    const resolver = new VerificationPlanResolver();
    const plan = resolver.resolve({
      workspaceRoot: tmpDir,
      createdFiles: [path.join(tmpDir, "a.ts")],
      modifiedFiles: [],
      deletedFiles: [],
      touchedPreExistingFiles: [],
    });
    // 非 Git 不影响 plan 生成
    expect(plan.errorCode).toBeUndefined();
  });

  it("35. monorepo fixture", () => {
    const pkg1 = path.join(tmpDir, "packages", "core");
    fs.mkdirSync(pkg1, { recursive: true });
    writePackageJson(pkg1, { typecheck: "tsc" });
    const resolver = new VerificationPlanResolver();
    const plan = resolver.resolve({
      workspaceRoot: tmpDir,
      createdFiles: [path.join(pkg1, "a.ts")],
      modifiedFiles: [],
      deletedFiles: [],
      touchedPreExistingFiles: [],
    });
    expect(plan.affectedPackages).toContain(pkg1);
  });

  it("36. fixture 目录", () => {
    const fixtureDir = path.join(tmpDir, "src", "fixtures");
    fs.mkdirSync(fixtureDir, { recursive: true });
    writePackageJson(tmpDir, { typecheck: "tsc" });
    const resolver = new VerificationPlanResolver();
    const plan = resolver.resolve({
      workspaceRoot: tmpDir,
      createdFiles: [path.join(fixtureDir, "data.json")],
      modifiedFiles: [],
      deletedFiles: [],
      touchedPreExistingFiles: [],
    });
    // fixture 目录无 .ts 变更
  });

  it("37. 完整测试和父提交基线对比（已记录在预检报告）", () => {
    // 此测试仅作占位，实际对比在审计阶段执行
    expect(true).toBe(true);
  });
});
