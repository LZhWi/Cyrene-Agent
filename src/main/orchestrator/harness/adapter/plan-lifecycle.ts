import * as fs from "fs";
import { EventType, type BaseEvent } from "@ag-ui/core";
import type { ConversationMode } from "../../../../shared/chat-types";
import type { ReviewRunStatus } from "../../../../shared/review-types";
import {
  completeExecution,
  getPlanPath,
  getPlanState,
  supplementPlan,
} from "../../plan-mode";

const LOG_PREFIX = "[HarnessAdapter]";

export async function preparePlanRunContext(input: {
  mode?: ConversationMode;
  threadId: string;
}): Promise<{
  planState: ReturnType<typeof getPlanState> | undefined;
  planContextBlock?: string;
}> {
  const participatesInPlanMode = input.mode === "code" || input.mode === "chat";
  if (participatesInPlanMode && getPlanState(input.threadId) === "PLAN_REVIEW") {
    supplementPlan(input.threadId);
    console.log(`${LOG_PREFIX} [Plan] new message during PLAN_REVIEW, back to PLAN_DISCUSSING`);
  }

  const planState = participatesInPlanMode ? getPlanState(input.threadId) : undefined;
  if (planState !== "EXECUTING") {
    return { planState };
  }

  try {
    const planContent = await fs.promises.readFile(getPlanPath(input.threadId), "utf8");
    return {
      planState,
      planContextBlock: [
        "[PLAN_CONTEXT]",
        "用户已批准以下实施计划。请严格按计划清单顺序执行，用 update_todo 维护任务进度：",
        "",
        planContent.trim(),
      ].join("\n"),
    };
  } catch (err) {
    console.warn(`${LOG_PREFIX} [Plan] read plan.md failed:`, err instanceof Error ? err.message : err);
    return { planState };
  }
}

export function completePlanRun(input: {
  mode?: ConversationMode;
  threadId: string;
  runId: string;
  runStatus: ReviewRunStatus;
  signal: AbortSignal;
  send: (event: BaseEvent) => void;
}): void {
  if (input.mode !== "code" && input.mode !== "chat") return;

  const finishedPlanPath = completeExecution(input.threadId);
  if (!finishedPlanPath) return;

  console.log(`${LOG_PREFIX} [Plan] execution finished, back to NORMAL, plan=${finishedPlanPath}`);
  if (input.signal.aborted) return;

  input.send({
    type: EventType.CUSTOM,
    name: "cyrene.plan.completed",
    value: { planPath: finishedPlanPath, runStatus: input.runStatus },
    threadId: input.threadId,
    runId: input.runId,
  } as BaseEvent);
}
