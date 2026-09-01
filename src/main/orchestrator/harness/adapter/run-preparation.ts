import { createHash } from "node:crypto";
import type { ChatMessage, VendorConfig } from "../../vendors/types";
import type { ToolDefinition } from "../../tools/registry/tool-registry";
import { toolRegistry } from "../../tools/registry/tool-registry";
import { prepareHarnessRecovery } from "../run-recovery";
import { getHarnessRunStore, type HarnessRequestSnapshot } from "../run-store";
import type { CyreneRunOptions } from "../../cyrene-agent";
import type { PromptLayers } from "../../prompt-layers";
import type { ConversationMode } from "../../../../shared/chat-types";
import {
  buildHarnessPromptLayers,
  materializeHarnessStartTranscript,
} from "./prompt-builder";
import { preparePlanRunContext } from "./plan-lifecycle";
import { app } from "electron";

const CODE_ONLY_GIT_TOOL_IDS = new Set([
  "git_status",
  "git_init",
  "git_commit",
  "git_switch_branch",
  "git_push",
  "git_revert",
]);

export function filterToolsForConversationMode(
  mode: ConversationMode | undefined,
  tools: ToolDefinition[],
): ToolDefinition[] {
  if (mode === "code") return tools;
  return tools.filter((tool) => !CODE_ONLY_GIT_TOOL_IDS.has(tool.id));
}

function fingerprint(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function snapshotHarnessRequest(
  options: CyreneRunOptions,
  promptLayers: PromptLayers,
  tools: ToolDefinition[],
): HarnessRequestSnapshot {
  return {
    provider: options.settings.provider,
    model: options.settings.model,
    contextWindowTokens: options.settings.contextWindowTokens,
    ...(options.settings.reasoning ? { reasoning: JSON.stringify(options.settings.reasoning) } : {}),
    ...(options.conversationMode ? { mode: options.conversationMode } : {}),
    promptFingerprint: fingerprint(promptLayers.stablePrefix),
    toolSchemaFingerprint: fingerprint(tools.map((tool) => ({
      id: tool.id,
      description: tool.description,
      schema: tool.inputSchema,
    })).sort((left, right) => left.id.localeCompare(right.id))),
    enabledToolIds: tools.map((tool) => tool.id).sort(),
    ...(options.resolvedWorkspaceRoot ? { workspaceRoot: options.resolvedWorkspaceRoot } : {}),
  };
}

export interface PreparedHarnessRun {
  threadId: string;
  runId: string;
  messageId: string;
  planState: Awaited<ReturnType<typeof preparePlanRunContext>>["planState"];
  vendorConfig: VendorConfig;
  tools: ToolDefinition[];
  promptLayers: ReturnType<typeof buildHarnessPromptLayers>;
  harnessPromptLayers: PromptLayers;
  systemPrompt: string;
  runMessages: ChatMessage[];
  recovered?: ReturnType<typeof prepareHarnessRecovery>;
  runStore: ReturnType<typeof getHarnessRunStore>;
}

export async function prepareHarnessRun(
  options: CyreneRunOptions,
  signal: AbortSignal,
): Promise<PreparedHarnessRun> {
  const messageId = `msg-${Date.now()}`;
  const runId = options.runId;
  if (!runId) {
    throw new Error(
      "[HarnessAdapter] options.runId is required. CyreneAgent.runWithEvents must populate it before invoking the adapter.",
    );
  }
  const threadId = options.conversationId ?? "default";
  const { planState, planContextBlock } = await preparePlanRunContext({
    mode: options.conversationMode,
    threadId,
  });

  console.log(`${"[HarnessAdapter]"} starting harness run, mode=${options.conversationMode ?? "work"}${planState ? ` plan=${planState}` : ""}`);

  const vendorConfig: VendorConfig = {
    provider: options.settings.provider,
    baseUrl: options.settings.baseUrl,
    model: options.settings.model,
    apiKey: options.settings.apiKey,
    explicitTransport: options.settings.explicitTransport,
    reasoning: options.settings.reasoning,
  };

  const tools = [...(options.capabilities?.tools ?? options.tools ?? toolRegistry.getEnabledTools())];
  const runStore = getHarnessRunStore(app.getPath("userData"));
  const recovered = options.resumeFromRunId
    ? (() => {
      const previous = runStore.get(options.resumeFromRunId!);
      if (!previous || previous.conversationId !== threadId) throw new Error("HARNESS_RECOVERY_NOT_FOUND");
      return prepareHarnessRecovery(previous, {
        workspaceRoot: options.resolvedWorkspaceRoot,
        provider: options.settings.provider,
        model: options.settings.model,
        enabledToolIds: tools.map((tool) => tool.id),
      });
    })()
    : undefined;

  const latestIncomingMessage = options.messages.at(-1);
  const baseRunMessages = recovered
    ? [
      ...recovered.messages,
      ...(latestIncomingMessage?.role === "user" ? [{ ...latestIncomingMessage }] : []),
    ]
    : options.messages;
  const recoveryContext = [options.recoveryContext, recovered?.recoveryContext, planContextBlock]
    .filter(Boolean).join("\n\n");
  const promptLayers = buildHarnessPromptLayers(
    recoveryContext ? { ...options, recoveryContext } : options,
  );
  const runMessages = materializeHarnessStartTranscript({
    messages: baseRunMessages,
    runId,
    runtimeContext: promptLayers.runtimeContext,
    initialState: recovered?.state,
    kind: recovered ? "recovery" : "run_start",
  });
  const harnessPromptLayers: PromptLayers = {
    stablePrefix: promptLayers.stablePrefix,
    ...(promptLayers.sessionPrefix ? { sessionPrefix: promptLayers.sessionPrefix } : {}),
    ...(promptLayers.mode ? { mode: promptLayers.mode } : {}),
  };
  const systemPrompt = harnessPromptLayers.stablePrefix;
  runStore.create({
    conversationId: threadId,
    runId,
    messages: runMessages,
    request: snapshotHarnessRequest(options, harnessPromptLayers, tools),
    ...(recovered ? { state: recovered.state, cache: recovered.cache } : {}),
    ...(options.resumeFromRunId ? { resumedFromRunId: options.resumeFromRunId } : {}),
  });

  return {
    threadId,
    runId,
    messageId,
    planState,
    vendorConfig,
    tools,
    promptLayers,
    harnessPromptLayers,
    systemPrompt,
    runMessages,
    ...(recovered ? { recovered } : {}),
    runStore,
  };
}
