import type { MusicPaths } from "./paths";
import { MusicService } from "./music-service";
import { registerMusicIpcHandlers } from "./ipc-handlers";
import { buildMusicTools, type MusicToolHooks } from "../orchestrator/tools/music-tools";
import { toolRegistry } from "../orchestrator/tool-registry";
import type { MusicShutdownReport } from "./types";

export interface MusicBootstrap {
  service: MusicService;
  isShuttingDown(): boolean;
  shutdown(): Promise<MusicShutdownReport>;
}

export function bootstrapMusicService(paths: MusicPaths, hooks: MusicToolHooks = {}): MusicBootstrap {
  const service = new MusicService(paths);
  const ipcDisposer = registerMusicIpcHandlers(service);
  const tools = buildMusicTools(service, hooks);
  for (const tool of tools) toolRegistry.register(tool);
  // start() emits the "failed" backend state on error and then re-throws;
  // attach a no-op .catch() so the rejection does not surface as
  // UnhandledPromiseRejectionWarning. Callers observe failures via
  // service.getBackendState() (e.g. smoke harness polls state).
  service.start().catch(() => { /* failure is signalled via backendState="failed" */ });

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
