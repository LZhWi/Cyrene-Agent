import type { CyreneRunTerminalResult } from "../../../../shared/run-terminal";

export type HarnessTerminateReason = "max_rounds" | "timeout" | "cancelled" | "error" | undefined;

export function mapTerminateReason(
  reason: HarnessTerminateReason,
): "no_tool" | "timeout" | "max_rounds" | "tool_error" {
  switch (reason) {
    case "max_rounds":
      return "max_rounds";
    case "timeout":
      return "timeout";
    case "error":
      return "tool_error";
    default:
      return "no_tool";
  }
}

export function mapTerminateReasonToTerminal(
  reason: HarnessTerminateReason,
  hasUncertainEffects: boolean = false,
): CyreneRunTerminalResult {
  switch (reason) {
    case "max_rounds":
      return { status: "timeout", reason: "max_rounds", externalEffectsMayContinue: true };
    case "timeout":
      return { status: "timeout", reason: "timeout", externalEffectsMayContinue: true };
    case "cancelled":
      return { status: "cancelled", reason: "user_cancelled", externalEffectsMayContinue: true };
    case "error":
      return { status: "runtime_error", reason: "E_HARNESS_FAILURE", externalEffectsMayContinue: true };
    default:
      return { status: "success", externalEffectsMayContinue: hasUncertainEffects };
  }
}
