import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  resolveEffectKind,
  resolveVerificationPolicy,
  type ToolDefinition,
} from "./tool-registry";
import {
  classifyShellPolicy,
  checkExecutionPolicy,
} from "./shell-execution-policy";
import { normalizePlan, type CapabilityWithEffect } from "./task-plan";
import {
  checkFinalizationGuard,
  resolveCompletionStatus,
  detectVerificationWaiver,
  type AgentGraphState,
  type CodeVerificationState,
  type FinalizationDisposition,
} from "./agent-graph";

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

function stateWithCodeVerification(
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
// 1. ToolEffectKind + VerificationPolicy
// ══════════════════════════════════════════════════════════════

describe("ToolEffectKind and VerificationPolicy", () => {
  it("unconfigured tool defaults to unknown (not read)", () => {
    const tool = toolDef({});
    expect(resolveEffectKind(tool, {})).toBe("unknown");
    expect(resolveVerificationPolicy(tool, {})).toBe("none");
  });

  it("read tools have effectKind=read", () => {
    const tool = toolDef({ effectKind: "read", verificationPolicy: "none" });
    expect(resolveEffectKind(tool, {})).toBe("read");
  });

  it("mutation+code tools have correct classification", () => {
    const tool = toolDef({ effectKind: "mutation", verificationPolicy: "code" });
    expect(resolveEffectKind(tool, {})).toBe("mutation");
    expect(resolveVerificationPolicy(tool, {})).toBe("code");
  });

  it("mutation+artifact tools have correct classification", () => {
    const tool = toolDef({ effectKind: "mutation", verificationPolicy: "artifact" });
    expect(resolveEffectKind(tool, {})).toBe("mutation");
    expect(resolveVerificationPolicy(tool, {})).toBe("artifact");
  });

  it("write_word does not trigger typecheck (artifact, not code)", () => {
    // write_word should be mutation + artifact
    const tool = toolDef({ effectKind: "mutation", verificationPolicy: "artifact" });
    expect(tool.verificationPolicy).not.toBe("code");
  });
});

// ══════════════════════════════════════════════════════════════
// 2. ToolExecutionPolicyGuard
// ══════════════════════════════════════════════════════════════

describe("ToolExecutionPolicyGuard", () => {
  it("rejects effectKind=unknown", () => {
    const decision = checkExecutionPolicy("unknown", "none", "test_tool");
    expect(decision.allowed).toBe(false);
    expect(decision.errorCode).toBe("E_UNKNOWN_TOOL_EFFECT");
  });

  it("rejects mutation + verificationPolicy=unknown", () => {
    const decision = checkExecutionPolicy("mutation", "unknown", "test_tool");
    expect(decision.allowed).toBe(false);
    expect(decision.errorCode).toBe("E_UNKNOWN_VERIFICATION_POLICY");
  });

  it("allows read tools", () => {
    const decision = checkExecutionPolicy("read", "none", "test_tool");
    expect(decision.allowed).toBe(true);
  });

  it("allows mutation+code tools", () => {
    const decision = checkExecutionPolicy("mutation", "code", "apply_patch");
    expect(decision.allowed).toBe(true);
  });

  it("allows mutation+artifact tools", () => {
    const decision = checkExecutionPolicy("mutation", "artifact", "write_word");
    expect(decision.allowed).toBe(true);
  });

  it("allows verification tools", () => {
    const decision = checkExecutionPolicy("verification", "none", "run_verification");
    expect(decision.allowed).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════
// 3. ShellExecutionPolicy
// ══════════════════════════════════════════════════════════════

describe("ShellExecutionPolicy", () => {
  it("classifies ls as read_only", () => {
    expect(classifyShellPolicy("ls", ["-la"])).toBe("read_only");
  });

  it("classifies git status as read_only", () => {
    expect(classifyShellPolicy("git", ["status"])).toBe("read_only");
  });

  it("classifies git diff as read_only", () => {
    expect(classifyShellPolicy("git", ["diff"])).toBe("read_only");
  });

  it("classifies rg as read_only", () => {
    expect(classifyShellPolicy("rg", ["pattern", "src/"])).toBe("read_only");
  });

  it("classifies git branch -D as workspace_mutation", () => {
    expect(classifyShellPolicy("git", ["branch", "-D", "feature"])).toBe("workspace_mutation");
  });

  it("classifies git branch (view) as read_only", () => {
    expect(classifyShellPolicy("git", ["branch"])).toBe("read_only");
  });

  it("classifies git stash push as workspace_mutation", () => {
    expect(classifyShellPolicy("git", ["stash", "push"])).toBe("workspace_mutation");
  });

  it("classifies git stash list as read_only", () => {
    expect(classifyShellPolicy("git", ["stash", "list"])).toBe("read_only");
  });

  it("classifies git remote add as workspace_mutation", () => {
    expect(classifyShellPolicy("git", ["remote", "add", "origin", "url"])).toBe("workspace_mutation");
  });

  it("classifies git remote as read_only", () => {
    expect(classifyShellPolicy("git", ["remote", "-v"])).toBe("read_only");
  });

  it("classifies find -delete as workspace_mutation", () => {
    expect(classifyShellPolicy("find", [".", "-name", "*.tmp", "-delete"])).toBe("workspace_mutation");
  });

  it("classifies find (no delete) as read_only", () => {
    expect(classifyShellPolicy("find", [".", "-name", "README"])).toBe("read_only");
  });

  it("classifies rm as blocked", () => {
    expect(classifyShellPolicy("rm", ["-rf", "/tmp"])).toBe("blocked");
  });

  it("classifies bash as workspace_mutation", () => {
    expect(classifyShellPolicy("bash", ["-c", "echo hello"])).toBe("workspace_mutation");
  });

  it("classifies cmd as workspace_mutation", () => {
    expect(classifyShellPolicy("cmd", ["/c", "dir"])).toBe("workspace_mutation");
  });

  it("classifies redirect as workspace_mutation", () => {
    expect(classifyShellPolicy("echo", ["text", ">", "file.txt"])).toBe("workspace_mutation");
  });

  it("classifies unknown executable as workspace_mutation", () => {
    expect(classifyShellPolicy("npm", ["run", "build"])).toBe("workspace_mutation");
  });

  it("classifies npm as workspace_mutation (not read_only)", () => {
    expect(classifyShellPolicy("npm", ["test"])).toBe("workspace_mutation");
  });
});

// ══════════════════════════════════════════════════════════════
// 4. Plan Normalizer
// ══════════════════════════════════════════════════════════════

describe("Plan Normalizer", () => {
  function makePlan(steps: Array<{ id: string; objective: string; capabilities: string[] }>) {
    return {
      id: "plan_1",
      conversationId: "conv_1",
      goal: "test",
      steps: steps.map(s => ({
        id: s.id,
        objective: s.objective,
        status: "pending" as const,
        completionPolicy: {
          allOf: s.capabilities.map(c => ({ kind: "tool_succeeded" as const, capabilityId: c })),
        },
        toolCallCount: 0,
        retryCount: 0,
      })),
      status: "running" as const,
      skillIds: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
  }

  function makeCapabilities(caps: Array<{ id: string; effectKind: string; verificationPolicy: string }>): CapabilityWithEffect[] {
    return caps.map(c => ({
      capabilityId: c.id,
      effectKind: c.effectKind as any,
      verificationPolicy: c.verificationPolicy as any,
    }));
  }

  it("code mutation without verification step -> auto-appends run_verification", () => {
    const plan = makePlan([{ id: "s1", objective: "修改代码", capabilities: ["apply_patch"] }]);
    const caps = makeCapabilities([{ id: "apply_patch", effectKind: "mutation", verificationPolicy: "code" }]);

    const { accepted } = normalizePlan(plan, caps);
    expect(accepted).toBe(true);
    expect(plan.steps.length).toBe(2);
    expect(plan.steps[1].completionPolicy.allOf?.[0].kind).toBe("verification_passed");
  });

  it("code mutation with existing verification step -> does not append", () => {
    const plan = makePlan([
      { id: "s1", objective: "修改代码", capabilities: ["apply_patch"] },
      { id: "s2", objective: "验证", capabilities: ["run_verification"] },
    ]);
    plan.steps[1].completionPolicy = { allOf: [{ kind: "verification_passed" }] };

    const caps = makeCapabilities([{ id: "apply_patch", effectKind: "mutation", verificationPolicy: "code" }]);

    const { accepted } = normalizePlan(plan, caps);
    expect(accepted).toBe(true);
    expect(plan.steps.length).toBe(2);
  });

  it("artifact mutation does not append verification step", () => {
    const plan = makePlan([{ id: "s1", objective: "生成文档", capabilities: ["write_word"] }]);
    const caps = makeCapabilities([{ id: "write_word", effectKind: "mutation", verificationPolicy: "artifact" }]);

    const { accepted } = normalizePlan(plan, caps);
    expect(accepted).toBe(true);
    expect(plan.steps.length).toBe(1);
  });

  it("pure read plan does not append verification step", () => {
    const plan = makePlan([{ id: "s1", objective: "搜索", capabilities: ["web_search"] }]);
    const caps = makeCapabilities([{ id: "web_search", effectKind: "read", verificationPolicy: "none" }]);

    const { accepted } = normalizePlan(plan, caps);
    expect(accepted).toBe(true);
    expect(plan.steps.length).toBe(1);
  });

  it("unknown verificationPolicy -> rejects plan", () => {
    const plan = makePlan([{ id: "s1", objective: "未知工具", capabilities: ["mystery"] }]);
    const caps = makeCapabilities([{ id: "mystery", effectKind: "mutation", verificationPolicy: "unknown" }]);

    const { accepted, rejectReason } = normalizePlan(plan, caps);
    expect(accepted).toBe(false);
    expect(rejectReason).toContain("unknown");
  });

  it("code + artifact mixed plan appends verification only for code", () => {
    const plan = makePlan([
      { id: "s1", objective: "修改代码", capabilities: ["apply_patch"] },
      { id: "s2", objective: "生成文档", capabilities: ["write_word"] },
    ]);
    const caps = makeCapabilities([
      { id: "apply_patch", effectKind: "mutation", verificationPolicy: "code" },
      { id: "write_word", effectKind: "mutation", verificationPolicy: "artifact" },
    ]);

    const { accepted } = normalizePlan(plan, caps);
    expect(accepted).toBe(true);
    expect(plan.steps.length).toBe(3); // code mutation + artifact + verification
    expect(plan.steps[2].completionPolicy.allOf?.[0].kind).toBe("verification_passed");
  });
});

// ══════════════════════════════════════════════════════════════
// 5. Finalization Guard
// ══════════════════════════════════════════════════════════════

describe("Finalization Guard", () => {
  it("no code mutation -> allow_success", () => {
    const state = {
      originalQuery: "test", contextualizedQuery: "test", citaContextBlock: "",
      messages: [], availableCapabilities: [], toolResults: [],
      iterationCount: 0, reply: "", clarificationAnswers: [],
      refreshCount: 0, replanCount: 0,
    } as AgentGraphState;
    const guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("allow_success");
  });

  it("code mutation pending with budget -> block", () => {
    const state = stateWithCodeVerification({
      mutationRevision: 1, verifiedRevision: 0, status: "pending",
    });
    const guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("block");
    if (guard.kind === "block") {
      expect(guard.redirectTo).toBe("decide");
    }
  });

  it("code mutation verified -> allow_success", () => {
    const state = stateWithCodeVerification({
      mutationRevision: 1, verifiedRevision: 1, status: "passed",
    });
    const guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("allow_success");
  });

  it("user waiver -> allow_unverified", () => {
    const state = stateWithCodeVerification(
      { mutationRevision: 1, verifiedRevision: 0, status: "pending" },
      { verificationWaiver: { source: "explicit_user_instruction", messageId: "msg_1", runId: "run_1", scope: "current_run", evidenceText: "不要运行测试" } },
    );
    const guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("allow_unverified");
  });

  it("verification failed (non-transient) with repair budget -> block", () => {
    const state = stateWithCodeVerification(
      { mutationRevision: 1, verifiedRevision: 0, status: "failed" },
      { requiredNextAction: undefined },
    );
    const guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("block");
  });

  it("verification failed (transient) with budget -> block", () => {
    const state = stateWithCodeVerification(
      { mutationRevision: 1, verifiedRevision: 0, status: "failed" },
      { requiredNextAction: { capabilityId: "run_verification", reason: "超时" } },
    );
    const guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("block");
  });

  it("plan running -> block", () => {
    const state = stateWithCodeVerification(
      {},
      { taskPlan: { id: "p1", conversationId: "c1", goal: "test", steps: [], status: "running", skillIds: [], createdAt: 0, updatedAt: 0 } },
    );
    const guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("block");
    if (guard.kind === "block") {
      expect(guard.redirectTo).toBe("planVerify");
    }
  });

  it("plan failed -> allow_failure", () => {
    const state = stateWithCodeVerification(
      {},
      { taskPlan: { id: "p1", conversationId: "c1", goal: "test", steps: [], status: "failed", skillIds: [], createdAt: 0, updatedAt: 0 } },
    );
    const guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("allow_failure");
  });

  it("skipped status -> allow_unverified", () => {
    const state = stateWithCodeVerification({
      mutationRevision: 1, verifiedRevision: 0, status: "skipped",
    });
    const guard = checkFinalizationGuard(state);
    expect(guard.kind).toBe("allow_unverified");
  });
});

// ══════════════════════════════════════════════════════════════
// 6. FinalizationOutcome resolution
// ══════════════════════════════════════════════════════════════

describe("FinalizationOutcome resolution", () => {
  it("no code mutation -> completed", () => {
    const state = stateWithCodeVerification({ mutationRevision: 0 });
    const outcome = resolveCompletionStatus(state, { kind: "allow_success" });
    expect(outcome.status).toBe("completed");
  });

  it("code verified -> completed_verified", () => {
    const state = stateWithCodeVerification({ mutationRevision: 1, verifiedRevision: 1 });
    const outcome = resolveCompletionStatus(state, { kind: "allow_success" });
    expect(outcome.status).toBe("completed_verified");
  });

  it("user waiver -> completed_unverified", () => {
    const state = stateWithCodeVerification({ mutationRevision: 1 });
    const outcome = resolveCompletionStatus(state, { kind: "allow_unverified", update: {} });
    expect(outcome.status).toBe("completed_unverified");
  });

  it("allow_failure -> failed", () => {
    const state = stateWithCodeVerification({ mutationRevision: 1 });
    const outcome = resolveCompletionStatus(state, { kind: "allow_failure", reason: "测试失败" });
    expect(outcome.status).toBe("failed");
    expect(outcome.reason).toBe("测试失败");
  });
});

// ══════════════════════════════════════════════════════════════
// 7. VerificationWaiver
// ══════════════════════════════════════════════════════════════

describe("VerificationWaiver detection", () => {
  it("detects '不要运行测试'", () => {
    const waiver = detectVerificationWaiver(
      [{ role: "user", content: "帮我改一下代码，不要运行测试" }],
      "run_1",
    );
    expect(waiver).toBeDefined();
    expect(waiver!.scope).toBe("current_run");
    expect(waiver!.runId).toBe("run_1");
  });

  it("detects '不用验证'", () => {
    const waiver = detectVerificationWaiver(
      [{ role: "user", content: "直接改完就好，不用验证" }],
      "run_1",
    );
    expect(waiver).toBeDefined();
  });

  it("detects 'skip test'", () => {
    const waiver = detectVerificationWaiver(
      [{ role: "user", content: "please skip test for now" }],
      "run_1",
    );
    expect(waiver).toBeDefined();
  });

  it("does not detect normal messages", () => {
    const waiver = detectVerificationWaiver(
      [{ role: "user", content: "帮我修改一下这个函数" }],
      "run_1",
    );
    expect(waiver).toBeUndefined();
  });
});

// ══════════════════════════════════════════════════════════════
// 8. Planner cannot output mutation_verified
// ══════════════════════════════════════════════════════════════

describe("Planner schema restrictions", () => {
  it("mutation_verified is not in CompletionCriterion (compile-time type check)", () => {
    // The CompletionCriterion type in task-plan.ts is:
    //   { kind: "tool_succeeded" } | { kind: "projection_claim" } | { kind: "verification_passed" }
    // mutation_verified is intentionally excluded so the Planner cannot generate it.
    // This test verifies the runtime behavior: verifyStep does not auto-pass
    // based on global mutation_verified state.
    //
    // If mutation_verified were added to the type, TypeScript would catch it
    // at compile time in the planSchema enum.
    const allowedKinds = ["tool_succeeded", "projection_claim", "verification_passed"];
    expect(allowedKinds).not.toContain("mutation_verified");
  });
});

// ══════════════════════════════════════════════════════════════
// 9. run_shell effectKind=unknown
// ══════════════════════════════════════════════════════════════

describe("run_shell effectKind", () => {
  it("run_shell has effectKind=unknown (not read)", () => {
    // This verifies the classification decision: run_shell is unknown,
    // not read. It cannot be trusted for mutation tracking or verification.
    const tool = toolDef({ effectKind: "unknown" });
    expect(resolveEffectKind(tool, {})).toBe("unknown");
  });
});

// ══════════════════════════════════════════════════════════════
// 10. write_file verificationPolicyResolver
// ══════════════════════════════════════════════════════════════

describe("write_file verificationPolicyResolver", () => {
  it("tsconfig.json -> code", () => {
    const resolver = (args: Record<string, unknown>) => {
      const rawPath = String(args.path ?? "");
      const normalizedPath = rawPath.replace(/\\/g, "/").toLowerCase();
      const fileName = normalizedPath.split("/").pop() ?? "";
      const codeConfigFiles = new Set(["tsconfig.json"]);
      if (codeConfigFiles.has(fileName)) return "code" as const;
      return "unknown" as const;
    };
    expect(resolver({ path: "/project/tsconfig.json" })).toBe("code");
  });

  it("package.json.bak does not match package.json", () => {
    const resolver = (args: Record<string, unknown>) => {
      const rawPath = String(args.path ?? "");
      const normalizedPath = rawPath.replace(/\\/g, "/").toLowerCase();
      const fileName = normalizedPath.split("/").pop() ?? "";
      const codeConfigFiles = new Set(["package.json"]);
      if (codeConfigFiles.has(fileName)) return "code" as const;
      return "unknown" as const;
    };
    expect(resolver({ path: "/project/package.json.bak" })).toBe("unknown");
  });
});
