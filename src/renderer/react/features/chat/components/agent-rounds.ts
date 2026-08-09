import type { AgentRoundRecord, ProcessMessageRecord, ToolExecutionRecord } from "../../../../../shared/chat-types";

const LIVE_TOOL_LABELS: Record<string, string> = {
  list_dir: "列出目录",
  read_file: "读取文件",
  write_file: "写入文件",
  edit_file: "编辑文件",
  search_code: "搜索代码",
  run_shell: "执行命令",
};

const SUMMARY_TOOL_LABELS: Record<string, string> = {
  list_dir: "浏览|个目录",
  read_file: "读取|个文件",
  write_file: "写入|个文件",
  edit_file: "编辑|个文件",
  search_code: "搜索|次",
  run_shell: "执行|条命令",
};

export function createRoundProcessMessage(
  id: string,
  content: string,
  afterToolCount: number,
  roundId?: string,
): ProcessMessageRecord {
  return { id, content, afterToolCount, roundId };
}

export function startAgentRound(
  rounds: readonly AgentRoundRecord[],
  roundId: string,
  startedAt = Date.now(),
): AgentRoundRecord[] {
  if (rounds.some((round) => round.id === roundId)) return [...rounds];
  return [...rounds, { id: roundId, status: "running", startedAt }];
}

export function finishAgentRound(
  rounds: readonly AgentRoundRecord[],
  roundId: string,
  completedAt = Date.now(),
): AgentRoundRecord[] {
  return rounds.map((round) => round.id === roundId
    ? { ...round, status: "completed", completedAt }
    : round);
}

export interface AgentRoundBoundaryState {
  rounds: AgentRoundRecord[];
  activeRoundId?: string;
}

export function applyAgentRoundBoundary(
  state: AgentRoundBoundaryState,
  action: "start" | "end",
  roundId: string,
  now = Date.now(),
): AgentRoundBoundaryState {
  if (action === "start") {
    return { rounds: startAgentRound(state.rounds, roundId, now), activeRoundId: roundId };
  }
  return {
    rounds: finishAgentRound(state.rounds, roundId, now),
    activeRoundId: state.activeRoundId === roundId ? undefined : state.activeRoundId,
  };
}

function completedSummary(tools: readonly ToolExecutionRecord[]): string[] {
  const successful = tools.filter((tool) => tool.status === "success");
  const counts = new Map<string, number>();
  for (const tool of successful) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);

  const facts = Object.entries(SUMMARY_TOOL_LABELS).flatMap(([name, pattern]) => {
    const count = counts.get(name) ?? 0;
    if (count === 0) return [];
    const [verb, suffix] = pattern.split("|");
    return [`${verb} ${count} ${suffix}`];
  });
  if (facts.length === 0 && successful.length > 0) facts.push(`完成 ${successful.length} 项操作`);
  return facts;
}

export function resolveAgentRoundTitle(
  round: AgentRoundRecord,
  tools: readonly ToolExecutionRecord[],
  interrupted = false,
): string {
  const failures = tools.filter((tool) => tool.status === "error").length;
  if (interrupted) {
    return ["昔涟已中断", ...(failures ? [`${failures} 项失败`] : [])].join(" · ");
  }
  if (round.status === "running") {
    const current = [...tools].reverse().find((tool) => tool.status === "running");
    return current
      ? `昔涟正在${LIVE_TOOL_LABELS[current.name] ?? current.name}`
      : "昔涟正在思考";
  }
  const facts = completedSummary(tools);
  if (failures) facts.push(`${failures} 项失败`);
  return ["昔涟已完成", ...facts].join(" · ");
}
