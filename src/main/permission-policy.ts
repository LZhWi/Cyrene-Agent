/**
 * 权限档位的纯策略层。
 *
 * 不依赖 Electron、磁盘或 IPC，供 VerificationRunner 等执行核心复用，
 * 避免为了判断 allow/ask/deny 就初始化整个权限宿主。
 */
export type AgentFileAccessLevel = "read-only" | "scoped" | "per-action" | "full";

export type ToolRiskLevel =
  | "safe"
  | "fs-read"
  | "fs-write"
  | "shell"
  | "network"
  | "input-control";

export function policyFor(
  level: AgentFileAccessLevel,
  risk: ToolRiskLevel,
): "allow" | "ask" | "deny" {
  if (risk === "safe") return "allow";

  switch (level) {
    case "read-only":
      return risk === "fs-read" || risk === "network" ? "allow" : "deny";
    case "scoped":
      if (risk === "fs-read" || risk === "fs-write" || risk === "network") return "allow";
      return "deny";
    case "per-action":
      return "ask";
    case "full":
      return "allow";
  }
}
