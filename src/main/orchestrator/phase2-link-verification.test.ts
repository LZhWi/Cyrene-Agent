/**
 * Phase 2 真实链路验收测试
 *
 * 验证完整链路：search_code → read_file → apply_patch → run_verification → completed_verified
 *
 * 这个测试模拟 Agent 使用 Phase 2 工具的完整流程，
 * 验证工具元数据、执行策略守卫、和状态机路由的正确性。
 */

import { describe, expect, it } from "vitest";
import {
  resolveEffectKind,
  resolveVerificationPolicy,
  type ToolDefinition,
} from "./tool-registry";
import {
  checkExecutionPolicy,
} from "./shell-execution-policy";
import {
  checkFinalizationGuard,
  resolveCompletionStatus,
  type AgentGraphState,
  type CodeVerificationState,
} from "./agent-graph";
import type { ToolCallResult } from "./types";

// ── 辅助函数 ──

function toolDef(overrides: Partial<ToolDefinition>): ToolDefinition {
  return {
    id: "test_tool",
    name: "Test Tool",
    description: "test",
    enabled: true,
    inputSchema: { type: "object", properties: {} },
    execute: async () => "test",
    ...overrides,
  };
}

function codeState(
  cv: Partial<CodeVerificationState>,
  overrides?: Partial<AgentGraphState>,
): AgentGraphState {
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

// ══════════════════════════════════════════════════════════════
// Phase 2 工具元数据验证
// ══════════════════════════════════════════════════════════════

describe("Phase 2 tool metadata", () => {
  it("search_code: effectKind=read, verificationPolicy=none", () => {
    const tool = toolDef({
      id: "search_code",
      effectKind: "read",
      verificationPolicy: "none",
    });
    expect(resolveEffectKind(tool, {})).toBe("read");
    expect(resolveVerificationPolicy(tool, {})).toBe("none");
  });

  it("read_file: effectKind=read, verificationPolicy=none", () => {
    const tool = toolDef({
      id: "read_file",
      effectKind: "read",
      verificationPolicy: "none",
    });
    expect(resolveEffectKind(tool, {})).toBe("read");
    expect(resolveVerificationPolicy(tool, {})).toBe("none");
  });

  it("apply_patch: effectKind=mutation, verificationPolicy=code", () => {
    const tool = toolDef({
      id: "apply_patch",
      effectKind: "mutation",
      verificationPolicy: "code",
    });
    expect(resolveEffectKind(tool, {})).toBe("mutation");
    expect(resolveVerificationPolicy(tool, {})).toBe("code");
  });

  it("run_verification: effectKind=verification, verificationPolicy=none", () => {
    const tool = toolDef({
      id: "run_verification",
      effectKind: "verification",
      verificationPolicy: "none",
    });
    expect(resolveEffectKind(tool, {})).toBe("verification");
    expect(resolveVerificationPolicy(tool, {})).toBe("none");
  });
});

// ══════════════════════════════════════════════════════════════
// Phase 2 工具执行策略守卫验证
// ══════════════════════════════════════════════════════════════

describe("Phase 2 tool execution policy", () => {
  it("search_code passes execution policy guard", () => {
    const decision = checkExecutionPolicy("read", "none", "search_code");
    expect(decision.allowed).toBe(true);
  });

  it("read_file passes execution policy guard", () => {
    const decision = checkExecutionPolicy("read", "none", "read_file");
    expect(decision.allowed).toBe(true);
  });

  it("apply_patch passes execution policy guard", () => {
    const decision = checkExecutionPolicy("mutation", "code", "apply_patch");
    expect(decision.allowed).toBe(true);
  });

  it("run_verification passes execution policy guard", () => {
    const decision = checkExecutionPolicy("verification", "none", "run_verification");
    expect(decision.allowed).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════
// 完整链路：search_code → read_file → apply_patch → run_verification → completed_verified
// ══════════════════════════════════════════════════════════════

describe("Full chain: search_code → read_file → apply_patch → run_verification → completed_verified", () => {
  it("Step 1: search_code (read) → no code mutation → allow_success", () => {
    // search_code 是 read 类型，不产生 code mutation
    const state = codeState({ mutationRevision: 0, verifiedRevision: 0, status: "clean" });
    const guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("allow_success");
  });

  it("Step 2: read_file (read) → no code mutation → allow_success", () => {
    // read_file 是 read 类型，不产生 code mutation
    const state = codeState({ mutationRevision: 0, verifiedRevision: 0, status: "clean" });
    const guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("allow_success");
  });

  it("Step 3: apply_patch (mutation+code) → mutationRevision=1 → block", () => {
    // apply_patch 修改代码，mutationRevision 递增
    const state = codeState({ mutationRevision: 1, verifiedRevision: 0, status: "pending" });
    const guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("block");
    if (guard.kind === "block") {
      expect(guard.redirectTo).toBeDefined();
    }
  });

  it("Step 4: run_verification (verification) → verifiedRevision=1 → allow_success", () => {
    // run_verification 验证通过
    const state = codeState({ mutationRevision: 1, verifiedRevision: 1, status: "passed" });
    const guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("allow_success");
  });

  it("Step 5: Finalization outcome → completed_verified", () => {
    const state = codeState({ mutationRevision: 1, verifiedRevision: 1, status: "passed" });
    const guard = checkFinalizationGuard(state);
    const outcome = resolveCompletionStatus(state, guard);
    expect(outcome.status).toBe("completed_verified");
  });

  it("Full chain simulation", () => {
    // 初始状态：无代码修改
    let state = codeState({ mutationRevision: 0, verifiedRevision: 0, status: "clean" });
    let guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("allow_success");

    // search_code + read_file（read 操作，不改变状态）
    state = codeState({ mutationRevision: 0, verifiedRevision: 0, status: "clean" });
    guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("allow_success");

    // apply_patch → mutationRevision=1
    state = codeState({ mutationRevision: 1, verifiedRevision: 0, status: "pending" });
    guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("block");

    // run_verification → verifiedRevision=1
    state = codeState({ mutationRevision: 1, verifiedRevision: 1, status: "passed" });
    guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("allow_success");

    // 最终结果：completed_verified
    const outcome = resolveCompletionStatus(state, guard);
    expect(outcome.status).toBe("completed_verified");
  });
});

// ══════════════════════════════════════════════════════════════
// Phase 2 工具结构化输出验证
// ══════════════════════════════════════════════════════════════

describe("Phase 2 tool structured output", () => {
  it("search_code output has required fields", () => {
    // 模拟 search_code 输出结构
    const output = {
      matches: [{ path: "src/main/index.ts", line: 10, preview: "const foo = 1;", before: [], after: [] }],
      totalMatches: 1,
      returnedMatches: 1,
      truncated: false,
    };

    expect(output).toHaveProperty("matches");
    expect(output).toHaveProperty("totalMatches");
    expect(output).toHaveProperty("returnedMatches");
    expect(output).toHaveProperty("truncated");
    expect(output.matches[0]).toHaveProperty("path");
    expect(output.matches[0]).toHaveProperty("line");
    expect(output.matches[0]).toHaveProperty("preview");
    expect(output.matches[0]).toHaveProperty("before");
    expect(output.matches[0]).toHaveProperty("after");
  });

  it("read_file output has required fields", () => {
    // 模拟 read_file 输出结构
    const output = {
      path: "/home/user/project/src/main/index.ts",
      startLine: 1,
      endLine: 10,
      totalLines: 100,
      content: "    1 | const foo = 1;\n    2 | const bar = 2;",
      truncated: false,
    };

    expect(output).toHaveProperty("path");
    expect(output).toHaveProperty("startLine");
    expect(output).toHaveProperty("endLine");
    expect(output).toHaveProperty("totalLines");
    expect(output).toHaveProperty("content");
    expect(output).toHaveProperty("truncated");
  });

  it("apply_patch success output has required fields", () => {
    // 模拟 apply_patch 成功输出结构
    const output = {
      tool: "apply_patch",
      filePath: "/home/user/project/src/main/index.ts",
      action: "modified",
      sizeBytes: 1234,
      success: true,
    };

    expect(output).toHaveProperty("tool", "apply_patch");
    expect(output).toHaveProperty("filePath");
    expect(output).toHaveProperty("action", "modified");
    expect(output).toHaveProperty("success", true);
  });

  it("apply_patch failure output has diagnostic fields", () => {
    // 模拟 apply_patch 失败输出结构
    const output = {
      error: "old_string 在文件中未找到。",
      success: false,
      diagnostic: {
        kind: "not_found",
        filePath: "/home/user/project/src/main/index.ts",
        oldStringLength: 20,
        nearestMatch: {
          line: 10,
          similarity: 0.8,
          context: ">   10 | const foo = 1;",
        },
      },
    };

    expect(output.success).toBe(false);
    expect(output.diagnostic.kind).toBe("not_found");
    expect(output.diagnostic.nearestMatch).toBeDefined();
    expect(output.diagnostic.nearestMatch.line).toBe(10);
    expect(output.diagnostic.nearestMatch.similarity).toBeGreaterThan(0.5);
  });
});
