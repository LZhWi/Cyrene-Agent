import { ipcMain } from "electron";
import { IPC } from "../../shared/ipc-channels";
import type { MusicService } from "./music-service";

export function registerMusicIpcHandlers(service: MusicService): void {
  ipcMain.handle(IPC.MUSIC_GET_STATUS, () => ({
    backend: service.getBackendState(),
    account: service.getAccountState(),
    player: service.getPlayerState(),
  }));
  ipcMain.handle(IPC.MUSIC_BEGIN_LOGIN, () => service.beginLogin());
  ipcMain.handle(IPC.MUSIC_CANCEL_LOGIN, () => service.cancelLogin());
  ipcMain.handle(IPC.MUSIC_GET_DAILY, () => service.getDailyRecommendations("default"));
  ipcMain.handle(IPC.MUSIC_SEARCH, (_e, payload: { keyword: string; limit?: number }) =>
    service.searchTracks(payload.keyword, "default", payload.limit),
  );
  ipcMain.handle(IPC.MUSIC_PRESENT_TRACKS, (_e, args) => service.presentTracks(args));
  ipcMain.handle(IPC.MUSIC_PLAY_TRACK, (_e, trackId: string) => service.playTrack(trackId));
  ipcMain.handle(IPC.MUSIC_PLAY_PLAYLIST, (_e, playlistId: string) => service.playPlaylist(playlistId));
  ipcMain.handle(IPC.MUSIC_DETECT_PLAYER, () => service.getPlayerState());
}
