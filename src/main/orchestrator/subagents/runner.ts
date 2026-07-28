// 子代理 Runner -- Profile 注册与分发的唯一入口
//
// 主 Agent Loop 只调用 runSubAgent(profile, taskId, args)，
// 不认识 Document/Search/Crawler 的具体实现。

import type { SubAgentRunOutcome } from "./types";

/** 子代理执行器签名：接收 taskId 和 Native FC 生成的参数，返回运行结果。 */
export type SubAgentExecutor = (
  taskId: string,
  args: Record<string, unknown>,
) => Promise<SubAgentRunOutcome>;

const profiles = new Map<string, SubAgentExecutor>();

/** 注册一个子代理 Profile 执行器。 */
export function registerSubAgentProfile(profile: string, executor: SubAgentExecutor): void {
  profiles.set(profile, executor);
}

/**
 * 运行指定 Profile 的子代理。
 * 主 Agent Loop 的唯一调用入口。
 */
export async function runSubAgent(
  profile: string,
  taskId: string,
  args: Record<string, unknown>,
): Promise<SubAgentRunOutcome> {
  const executor = profiles.get(profile);
  if (!executor) {
    return {
      invocationStatus: "crashed",
      error: {
        code: "SUBAGENT_PROFILE_NOT_FOUND",
        message: `未注册的子代理 Profile: ${profile}`,
      },
    };
  }
  return executor(taskId, args);
}
