import { initGameBot } from "./index";

/**
 * 启动游戏代肝子系统：注册 IPC 与 game_bot_start 工具。
 */
export function bootstrapGameBot(): void {
  initGameBot();
}
