import type { MusicPaths } from "./paths";
import { MusicService } from "./music-service";
import { registerMusicIpcHandlers } from "./ipc-handlers";
import { buildMusicTools } from "../orchestrator/tools/music-tools";
import { buildExternalPlayerTools } from "../orchestrator/tools/external-player-tools";
import { toolRegistry } from "../orchestrator/tools/registry/tool-registry";
import type { MusicShutdownReport } from "./types";

export interface MusicBootstrap {
  service: MusicService;
  isShuttingDown(): boolean;
  shutdown(): Promise<MusicShutdownReport>;
}

export function bootstrapMusicService(paths: MusicPaths): MusicBootstrap {
  const service = new MusicService(paths);
  const ipcDisposer = registerMusicIpcHandlers(service);
  // 外部播放器（QQ 音乐等）走 SMTC，与 MusicService 无关，但生命周期一致，
  // 挂在同一个 bootstrap 里注册/注销。
  const tools = [...buildMusicTools(service), ...buildExternalPlayerTools()];
  for (const tool of tools) toolRegistry.register(tool);
  // Do not start the music backend here.  It is connected lazily by the first
  // real music action (ensureReady) so an idle Cyrene window never holds a
  // network session merely because the extension is installed.

  let shuttingDown = false;
  return {
    service,
    isShuttingDown: () => shuttingDown,
    shutdown: async () => {
      if (shuttingDown) {
        return {
          rootProcessPid: undefined,
          transportClosed: true,
          processTreeExited: true,
          runtimeRemoved: true,
        };
      }
      shuttingDown = true;
      const report = await service.shutdown();
      ipcDisposer();
      for (const t of tools) toolRegistry.unregister(t.id);
      return report;
    },
  };
}
