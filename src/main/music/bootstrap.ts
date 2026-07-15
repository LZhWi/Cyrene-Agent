import type { MusicPaths } from "./paths";
import { ipcMain } from "electron";
import { IPC } from "../../shared/ipc-channels";
import { MusicService } from "./music-service";
import { registerMusicIpcHandlers } from "./ipc-handlers";
import { buildMusicTools } from "../orchestrator/tools/music-tools";
import { toolRegistry } from "../orchestrator/tool-registry";
import type { MusicShutdownReport } from "./types";

const MUSIC_IPC_CHANNELS = [
  IPC.MUSIC_GET_STATUS,
  IPC.MUSIC_BEGIN_LOGIN,
  IPC.MUSIC_CANCEL_LOGIN,
  IPC.MUSIC_GET_DAILY,
  IPC.MUSIC_SEARCH,
  IPC.MUSIC_PRESENT_TRACKS,
  IPC.MUSIC_PLAY_TRACK,
  IPC.MUSIC_PLAY_PLAYLIST,
  IPC.MUSIC_DETECT_PLAYER,
];

export interface MusicBootstrap {
  service: MusicService;
  isShuttingDown(): boolean;
  shutdown(): Promise<MusicShutdownReport>;
}

export function bootstrapMusicService(paths: MusicPaths): MusicBootstrap {
  const service = new MusicService(paths);
  registerMusicIpcHandlers(service);
  const tools = buildMusicTools(service);
  for (const tool of tools) toolRegistry.register(tool);
  void service.start();

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
      for (const channel of MUSIC_IPC_CHANNELS) ipcMain.removeHandler(channel);
      for (const t of tools) toolRegistry.unregister(t.id);
      return report;
    },
  };
}
