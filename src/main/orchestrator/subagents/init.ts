// 子代理初始化 -- 显式注册所有内置 Profile
//
// 由 Orchestrator 启动阶段调用一次，不依赖模块加载副作用。

import { registerDocumentProfile } from "./document-agent";
import { registerSearchProfile } from "./search-agent";

let initialized = false;

/**
 * 显式注册所有内置子代理 Profile。
 * 幂等：多次调用安全，第二次起为 no-op。
 */
export function registerBuiltInSubAgentProfiles(): void {
  if (initialized) return;
  registerDocumentProfile();
  registerSearchProfile();
  initialized = true;
}

/** 重置初始化状态（仅供测试使用） */
export function _resetSubAgentInit(): void {
  initialized = false;
}
