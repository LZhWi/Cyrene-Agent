import { randomUUID } from "crypto";
import * as fs from "fs";
import type { WorkMessage, WorkPlan, WorkPlanStep, WorkRunEvent, WorkSession } from "../../shared/work-types";
import { checkPermission, type ToolRiskLevel } from "../permission";
import type { ToolContext } from "../orchestrator/tool-context";
import type { ToolDefinition } from "../orchestrator/tool-registry";
import { getAdapterForConfig, type ChatMessage, type VendorConfig } from "../orchestrator/vendors";
import { searchWorkMemory, saveWorkMemory } from "./work-memory-store";
import { callWorkTextModel, runWorkStructuredOutput } from "./work-structured-output";
import { WorkExecutionLedger, type WorkExecutionOutcome } from "./work-execution-ledger";
import { workContextRefs } from "./work-context-ref";
import { buildWorkFinalSystemPrompt } from "./work-final-prompt";
import { validateWorkToolArguments } from "./work-tool-validator";
import { appendWorkMessage, getWorkSession, updateWorkExecutionState } from "./work-store";

interface WorkPrompts {
  system: string;
  style: string;
  router: string;
  plan: string;
  actionGate: string;
}

export interface WorkAgentInput {
  session: WorkSession;
  userText: string;
  attachmentContext?: string;
  config: VendorConfig;
  tools: ToolDefinition[];
  prompts: WorkPrompts;
  onEvent?: (event: WorkRunEvent) => void;
  signal?: AbortSignal;
  approvalWebContentsId?: number;
}

interface WorkRouteDecision {
  mode: "direct" | "plan";
  reason: string;
}

interface WorkActionDecision {
  decision: "act" | "respond" | "ask_user";
  toolId: string | null;
  args: Record<string, unknown>;
  message: string | null;
  reason: string;
}

interface ExecutedToolSummary {
  toolId: string;
  ok: boolean;
  summary: string;
  contextRef?: string;
}

const MAX_DIRECT_ACTIONS = 6;
const MAX_PLAN_STEPS = 8;

function assertObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("expected object");
  return value as Record<string, unknown>;
}

function parseRoute(value: unknown): WorkRouteDecision {
  const object = assertObject(value);
  if (object.mode !== "direct" && object.mode !== "plan") throw new Error("mode must be direct or plan");
  return { mode: object.mode, reason: typeof object.reason === "string" ? object.reason : "" };
}

function parsePlan(value: unknown): { goal: string; steps: string[] } {
  const object = assertObject(value);
  const steps = Array.isArray(object.steps)
    ? object.steps.filter((step): step is string => typeof step === "string" && Boolean(step.trim())).slice(0, MAX_PLAN_STEPS)
    : [];
  if (steps.length === 0) throw new Error("plan requires at least one step");
  return {
    goal: typeof object.goal === "string" && object.goal.trim() ? object.goal.trim() : "完成用户任务",
    steps,
  };
}

function parseAction(value: unknown): WorkActionDecision {
  const object = assertObject(value);
  if (object.decision !== "act" && object.decision !== "respond" && object.decision !== "ask_user") {
    throw new Error("invalid action decision");
  }
  return {
    decision: object.decision,
    toolId: typeof object.toolId === "string" ? object.toolId : null,
    args: object.args && typeof object.args === "object" && !Array.isArray(object.args)
      ? object.args as Record<string, unknown>
      : {},
    message: typeof object.message === "string" ? object.message : null,
    reason: typeof object.reason === "string" ? object.reason : "",
  };
}

function buildHistory(session: WorkSession): ChatMessage[] {
  return session.messages.slice(-30).map((message) => ({
    role: message.role === "assistant" ? "assistant" : message.role === "system" ? "system" : "user",
    content: message.content,
  }));
}

function buildDecisionHistory(session: WorkSession): Array<{ role: WorkMessage["role"]; content: string }> {
  return session.messages.slice(-20).map((message) => ({ role: message.role, content: message.content }));
}

function makeMessage(role: WorkMessage["role"], content: string): WorkMessage {
  return { id: randomUUID(), role, content, createdAt: Date.now() };
}

function toolCatalog(tools: ToolDefinition[]): Array<Record<string, unknown>> {
  return [
    ...tools.map((tool) => ({
      id: tool.id,
      description: tool.description,
      inputSchema: tool.inputSchema,
    })),
    {
      id: "work_memory_save",
      description: "仅在用户明确要求长期记住某项工作信息时，将其保存到 Work 专用记忆。",
      inputSchema: {
        type: "object",
        properties: { content: { type: "string" } },
        required: ["content"],
      },
    },
  ];
}

function outputSummary(output: string): string {
  const clean = output.replace(/\s+/g, " ").trim();
  return clean.length > 500 ? `${clean.slice(0, 500)}…` : clean;
}

function findArtifactPaths(output: string): string[] {
  const matches = output.match(/[A-Za-z]:\\[^\r\n"<>|]+/g) ?? [];
  return [...new Set(matches.map((item) => item.trim().replace(/[.,;:]+$/, "")))]
    .filter((filePath) => {
      try { return fs.existsSync(filePath) && fs.statSync(filePath).isFile(); } catch { return false; }
    });
}

async function executeTool(input: {
  sessionId: string;
  userText: string;
  toolId: string;
  args: Record<string, unknown>;
  tools: ToolDefinition[];
  approvalWebContentsId?: number;
}): Promise<WorkExecutionOutcome> {
  if (input.toolId === "work_memory_save") {
    const content = typeof input.args.content === "string" ? input.args.content.trim() : "";
    if (!content) return { status: "failed", toolId: input.toolId, output: "content is required" };
    const entry = saveWorkMemory(content, input.sessionId);
    const output = `Work memory saved: ${entry.id}`;
    const contextRef = workContextRefs.register(input.sessionId, "tool_result", output);
    return { status: "succeeded", toolId: input.toolId, output, contextRef };
  }

  const tool = input.tools.find((candidate) => candidate.id === input.toolId && candidate.enabled);
  if (!tool) return { status: "failed", toolId: input.toolId, output: `Tool unavailable: ${input.toolId}` };
  const validation = validateWorkToolArguments(tool, input.args);
  if (!validation.ok) {
    return {
      status: "failed",
      toolId: input.toolId,
      output: `E_TOOL_ARGUMENT_SCHEMA: ${validation.errors.join("; ")}`,
    };
  }
  const risk: ToolRiskLevel = tool.risk ?? "safe";
  const permission = await checkPermission({
    toolId: tool.id,
    toolName: tool.name,
    toolDescription: tool.description,
    args: input.args,
    risk,
    targetWebContentsId: input.approvalWebContentsId,
  });
  if (!permission.allowed) {
    return { status: "failed", toolId: input.toolId, output: permission.reason || "Permission denied" };
  }
  try {
    const context: ToolContext = {
      userQuery: input.userText,
      conversationId: `work:${input.sessionId}`,
      metadata: { runtime: "work" },
    };
    const output = await tool.execute(input.args, tool.needsContext ? context : undefined);
    const contextRef = workContextRefs.register(input.sessionId, "tool_result", output);
    return {
      status: output.startsWith("[错误]") || output.startsWith("[工具执行失败]") ? "failed" : "succeeded",
      toolId: input.toolId,
      output,
      contextRef,
    };
  } catch (error) {
    return {
      status: "failed",
      toolId: input.toolId,
      output: error instanceof Error ? error.message : String(error),
    };
  }
}

function newPlan(route: WorkRouteDecision, userText: string, steps?: string[]): WorkPlan {
  const now = Date.now();
  const objectives = route.mode === "plan" && steps?.length ? steps : [userText];
  return {
    id: randomUUID(),
    goal: userText,
    mode: route.mode,
    status: "running",
    steps: objectives.map((objective, index): WorkPlanStep => ({
      id: `step-${index + 1}`,
      objective,
      status: "pending",
      toolCallCount: 0,
    })),
    createdAt: now,
    updatedAt: now,
  };
}

export async function runWorkAgent(input: WorkAgentInput): Promise<WorkSession> {
  const adapter = getAdapterForConfig(input.config);
  const ledger = new WorkExecutionLedger();
  const memories = searchWorkMemory(input.userText, 6);
  const emit = input.onEvent ?? (() => {});
  const enabledTools = input.tools.filter((tool) => tool.enabled);
  const workHistory = buildDecisionHistory(input.session);
  let session = input.session;
  let route: WorkRouteDecision = { mode: "direct", reason: "router fallback" };

  emit({ type: "status", status: "running", text: "正在分析任务" });
  session = updateWorkExecutionState(session.id, { status: "running" }) ?? session;

  try {
    route = await runWorkStructuredOutput({
      adapter,
      config: input.config,
      systemPrompt: input.prompts.router,
      userPayload: {
        request: input.userText,
        attachmentContext: input.attachmentContext,
        workHistory,
        availableTools: toolCatalog(enabledTools).map((tool) => tool.id),
      },
      validate: parseRoute,
      signal: input.signal,
    });
  } catch (error) {
    console.warn("[WorkAgent] router failed, using direct:", error);
  }

  let plannedSteps: string[] | undefined;
  if (route.mode === "plan") {
    try {
      const planned = await runWorkStructuredOutput({
        adapter,
        config: input.config,
        systemPrompt: input.prompts.plan,
        userPayload: { request: input.userText, attachmentContext: input.attachmentContext, workHistory, availableTools: toolCatalog(enabledTools) },
        validate: parsePlan,
        signal: input.signal,
      });
      plannedSteps = planned.steps;
    } catch (error) {
      console.warn("[WorkAgent] plan creation failed, using direct:", error);
      route = { mode: "direct", reason: "plan creation failed" };
    }
  }

  const plan = newPlan(route, input.userText, plannedSteps);
  session = updateWorkExecutionState(session.id, { plan, status: "running" }) ?? session;
  emit({ type: "plan", plan });
  const results: ExecutedToolSummary[] = [];
  let shouldRespond = false;

  for (const step of plan.steps) {
    if (input.signal?.aborted) {
      plan.status = "cancelled";
      break;
    }
    step.status = "running";
    plan.updatedAt = Date.now();
    emit({ type: "plan", plan: structuredClone(plan) });
    const maxActions = plan.mode === "direct" ? MAX_DIRECT_ACTIONS : 4;

    for (let actionIndex = 0; actionIndex < maxActions; actionIndex += 1) {
      const action = await runWorkStructuredOutput({
        adapter,
        config: input.config,
        systemPrompt: input.prompts.actionGate,
        userPayload: {
          request: input.userText,
          attachmentContext: input.attachmentContext,
          workHistory,
          currentStep: step.objective,
          tools: toolCatalog(enabledTools),
          priorResults: results,
          workMemory: memories.map((memory) => memory.content),
        },
        validate: parseAction,
        signal: input.signal,
      });

      if (action.decision === "ask_user") {
        const content = action.message?.trim() || "继续执行前还需要你补充一些信息。";
        const message = makeMessage("assistant", content);
        appendWorkMessage(session.id, message);
        plan.status = "awaiting_user";
        plan.updatedAt = Date.now();
        updateWorkExecutionState(session.id, { plan, status: "awaiting_user" });
        emit({ type: "message", message });
        emit({ type: "plan", plan });
        emit({ type: "done", sessionId: session.id });
        return getLatestSession(session);
      }

      if (action.decision === "respond") {
        step.status = "completed";
        shouldRespond = true;
        break;
      }

      if (!action.toolId) {
        results.push({ toolId: "unknown", ok: false, summary: "Action Gate omitted toolId" });
        continue;
      }

      step.toolCallCount += 1;
      emit({ type: "tool_start", toolId: action.toolId, label: action.reason || action.toolId });
      const execution = await ledger.execute(action.toolId, action.args, () => executeTool({
        sessionId: session.id,
        userText: input.userText,
        toolId: action.toolId!,
        args: action.args,
        tools: enabledTools,
        approvalWebContentsId: input.approvalWebContentsId,
      }));
      const outcome = execution.outcome;
      const summary = `${execution.cached ? "[cached] " : ""}${outputSummary(outcome.output)}`;
      results.push({
        toolId: outcome.toolId,
        ok: outcome.status === "succeeded",
        summary,
        contextRef: outcome.contextRef,
      });
      emit({ type: "tool_end", toolId: outcome.toolId, ok: outcome.status === "succeeded", summary });

      if (outcome.status === "succeeded") {
        for (const filePath of findArtifactPaths(outcome.output)) {
          if (!session.artifacts.some((artifact) => artifact.path === filePath)) {
            session.artifacts.push({
              id: randomUUID(),
              name: filePath.split(/[\\/]/).pop() || filePath,
              path: filePath,
              createdAt: Date.now(),
            });
          }
        }
        if (plan.mode === "plan") {
          step.status = "completed";
          break;
        }
      }
    }

    if (step.status === "running") step.status = shouldRespond ? "completed" : "failed";
    plan.updatedAt = Date.now();
    emit({ type: "plan", plan: structuredClone(plan) });
    if (plan.mode === "direct" || shouldRespond) break;
  }

  const trustedResults = results.map((result) => {
    if (!result.contextRef) return result;
    try {
      return {
        ...result,
        trustedOutput: workContextRefs.resolve<string>(result.contextRef, session.id, "tool_result"),
      };
    } catch {
      return result;
    }
  });
  emit({ type: "status", status: "running", text: "正在整理结果" });
  const finalMessages: ChatMessage[] = [
    { role: "system", content: buildWorkFinalSystemPrompt(input.prompts.system, input.prompts.style) },
    ...buildHistory(session),
    {
      role: "system",
      content: `Work execution context:\n${JSON.stringify({
        plan,
        results: trustedResults,
        artifacts: session.artifacts,
        workMemory: memories.map((memory) => memory.content),
        attachmentContext: input.attachmentContext,
      })}`,
    },
    { role: "user", content: "请依据以上 Work 执行状态完成本轮答复。" },
  ];
  const reply = await callWorkTextModel({
    adapter,
    config: input.config,
    messages: finalMessages,
    signal: input.signal,
  });
  const message = makeMessage("assistant", reply);
  appendWorkMessage(session.id, message);
  plan.status = plan.steps.some((step) => step.status === "failed") ? "failed" : "completed";
  plan.updatedAt = Date.now();
  session = updateWorkExecutionState(session.id, {
    plan,
    status: plan.status === "completed" ? "completed" : "failed",
    artifacts: session.artifacts,
  }) ?? session;
  emit({ type: "message", message });
  emit({ type: "plan", plan });
  emit({ type: "done", sessionId: session.id });
  return getLatestSession(session);
}

function getLatestSession(session: WorkSession): WorkSession {
  return getWorkSession(session.id) ?? session;
}
