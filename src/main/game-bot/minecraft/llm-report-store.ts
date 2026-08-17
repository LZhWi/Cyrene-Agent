import * as fs from "fs";
import * as path from "path";

export interface MinecraftLlmExecutionReport {
  version: 1;
  source: "minecraft_gamebot";
  request: string;
  status: "completed" | "stopped" | "failed" | "step_limit";
  message: string;
  steps: Array<{ command: string; result: string }>;
}

export function saveMinecraftLlmReport(file: string, value: unknown): MinecraftLlmExecutionReport | null {
  if (!value || typeof value !== "object") return null;
  const input = value as Partial<MinecraftLlmExecutionReport>;
  if (input.version !== 1 || input.source !== "minecraft_gamebot") return null;
  if (!["completed", "stopped", "failed", "step_limit"].includes(String(input.status))) return null;
  const report: MinecraftLlmExecutionReport = {
    version: 1,
    source: "minecraft_gamebot",
    request: String(input.request ?? "").slice(0, 300),
    status: input.status as MinecraftLlmExecutionReport["status"],
    message: String(input.message ?? "").slice(0, 240),
    steps: (Array.isArray(input.steps) ? input.steps : []).slice(-8).map((step) => ({
      command: String(step?.command ?? "").slice(0, 80),
      result: String(step?.result ?? "").slice(0, 240),
    })),
  };
  let reports: MinecraftLlmExecutionReport[] = [];
  try {
    if (fs.existsSync(file)) reports = JSON.parse(fs.readFileSync(file, "utf8")) as MinecraftLlmExecutionReport[];
  } catch { reports = []; }
  reports.push(report);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(reports.slice(-100), null, 2), "utf8");
  return report;
}
