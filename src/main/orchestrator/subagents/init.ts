// 子代理初始化 -- 显式注册所有内置 Profile
//
// 由 Orchestrator 启动阶段调用一次，不依赖模块加载副作用。

import { registerDocumentProfile } from "./document-agent";

/** 显式注册所有内置子代理 Profile。 */
export function registerBuiltInSubAgentProfiles(): void {
  registerDocumentProfile();
}
