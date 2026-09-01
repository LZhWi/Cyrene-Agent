import type { ChatMessage } from "../../vendors/types";
import {
  TODO_WORKING_NOTEBOOK_POLICY,
  buildCurrentTodoNotebookContext,
} from "../todo-working-notebook";
import { appendInternalTranscriptMessage, createInternalTranscriptMessage } from "../internal-transcript";
import type { AgentState } from "../types";
import type { PromptLayers } from "../../prompt-layers";
import type { CyreneRunOptions } from "../../cyrene-agent";
import { loadPromptFile } from "../../../prompts/prompt-loader";

export function materializeHarnessStartTranscript(input: {
  messages: readonly ChatMessage[];
  runId: string;
  runtimeContext?: string;
  initialState?: AgentState;
  kind: "run_start" | "recovery";
}): ChatMessage[] {
  const parts = [
    input.runtimeContext,
    input.initialState?.todoItems.length
      ? buildCurrentTodoNotebookContext(input.initialState.todoItems)
      : undefined,
  ].filter((part): part is string => Boolean(part?.trim()));
  if (parts.length === 0) return [...input.messages];

  const revision = input.messages.reduce(
    (current, message) => Math.max(current, message.internal?.revision ?? 0),
    0,
  ) + 1;
  return appendInternalTranscriptMessage(input.messages, createInternalTranscriptMessage({
    kind: input.kind,
    revision,
    runId: input.runId,
    content: parts.join("\n\n---\n\n"),
  }));
}

export function buildHarnessPromptLayers(
  options: CyreneRunOptions,
): PromptLayers & { usageParts?: { personaContent: string; toolLayerContent: string; skillLayerContent?: string } } {
  const personaParts: string[] = [];
  if (options.soulSystemBaseContent) {
    personaParts.push(options.soulSystemBaseContent);
  }

  const harnessPersona = options.conversationMode === "chat"
    ? ""
    : loadPromptFile("cyrene_harness.md");
  if (harnessPersona) {
    personaParts.push(harnessPersona);
  }

  personaParts.push(TODO_WORKING_NOTEBOOK_POLICY);

  const toolParts: string[] = [];
  if (options.toolSystemContent) {
    toolParts.push(options.toolSystemContent);
  }
  if (options.conversationMode !== "chat") {
    const toolUsagePolicy = loadPromptFile("tool_usage.md");
    if (toolUsagePolicy) {
      toolParts.push(toolUsagePolicy);
    }
  }

  const runtimeParts: string[] = [];
  if (options.soulRuntimeContext) runtimeParts.push(options.soulRuntimeContext);
  if (options.planSkillContext) runtimeParts.push(options.planSkillContext);
  if (options.runtimeEnvironmentContext) runtimeParts.push(options.runtimeEnvironmentContext);
  if (options.citaContextBlock) runtimeParts.push(options.citaContextBlock);
  if (options.recoveryContext) runtimeParts.push(`[RECOVERY_CONTEXT]\n${options.recoveryContext}`);
  if (options.responseContext) runtimeParts.push(`[RESPONSE_CONTEXT]\n${options.responseContext}`);

  const stablePrefix = [...personaParts, ...toolParts].join("\n\n---\n\n");
  const uniqueRuntimeParts = runtimeParts.filter((part) => !stablePrefix.includes(part));
  return {
    stablePrefix,
    usageParts: {
      personaContent: personaParts.join("\n\n---\n\n"),
      toolLayerContent: toolParts.join("\n\n---\n\n"),
      ...(options.skillLayerContent ? { skillLayerContent: options.skillLayerContent } : {}),
    },
    ...(options.conversationMode ? { mode: options.conversationMode } : {}),
    ...(uniqueRuntimeParts.length ? { runtimeContext: uniqueRuntimeParts.join("\n\n---\n\n") } : {}),
  };
}

/** @deprecated 兼容外部调用；Harness 主路径改用 buildHarnessPromptLayers。 */
export function buildHarnessSystemPrompt(options: CyreneRunOptions): string {
  const layers = buildHarnessPromptLayers(options);
  return [layers.stablePrefix, layers.runtimeContext].filter(Boolean).join("\n\n---\n\n");
}
