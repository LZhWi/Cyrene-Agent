// 子代理 Runner -- Profile 注册与分发的唯一入口
//
// 主 Agent Loop 只调用 runSubAgent(ctx)，
// 不认识 Document/Search/Crawler 的具体实现。

import type { SubAgentRunContext, SubAgentRunOutcome, SubAgentProfileId } from "./types";

/** 子代理执行器签名 */
export type SubAgentExecutor = (ctx: SubAgentRunContext) => Promise<SubAgentRunOutcome>;

const profiles = new Map<SubAgentProfileId, SubAgentExecutor>();

/** 注册一个子代理 Profile 执行器。 */
export function registerSubAgentProfile(profile: SubAgentProfileId, executor: SubAgentExecutor): void {
  profiles.set(profile, executor);
}

/** 检查 Profile 是否已注册 */
export function isProfileRegistered(profile: string): boolean {
  return profiles.has(profile as SubAgentProfileId);
}

/**
 * 运行指定 Profile 的子代理。
 * 主 Agent Loop 的唯一调用入口。
 */
export async function runSubAgent(ctx: SubAgentRunContext): Promise<SubAgentRunOutcome> {
  const executor = profiles.get(ctx.profile);
  if (!executor) {
    return {
      invocationStatus: "crashed",
      error: {
        code: "SUBAGENT_PROFILE_NOT_FOUND",
        message: `未注册的子代理 Profile: ${ctx.profile}`,
      },
    };
  }
  return executor(ctx);
}
