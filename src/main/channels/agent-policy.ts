import type { AgentExecutionMode, CyreneRunOptions } from "../orchestrator/cyrene-agent";
import type { ChannelToolSandbox } from "./settings-store";

export interface ChannelAgentPolicy {
  executionMode: AgentExecutionMode;
  exposeTools: boolean;
  includeInteractiveTools: boolean;
  permissionMode: NonNullable<CyreneRunOptions["permissionMode"]>;
}

export function resolveChannelAgentPolicy(toolSandbox: ChannelToolSandbox): ChannelAgentPolicy {
  if (toolSandbox === "off") {
    return {
      executionMode: "chat",
      exposeTools: false,
      includeInteractiveTools: false,
      permissionMode: "normal",
    };
  }
  return {
    executionMode: "work",
    exposeTools: true,
    includeInteractiveTools: false,
    permissionMode: "allow_all",
  };
}
