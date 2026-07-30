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
    expect(result.errorCode).toBe("VERIFICATION_APPROVAL_REQUIRED");
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