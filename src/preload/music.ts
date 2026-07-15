import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "../shared/ipc-channels";

export function exposeMusicApi() {
  contextBridge.exposeInMainWorld("music", {
    getStatus: () => ipcRenderer.invoke(IPC.MUSIC_GET_STATUS),
    beginLogin: () => ipcRenderer.invoke(IPC.MUSIC_BEGIN_LOGIN),
    cancelLogin: () => ipcRenderer.invoke(IPC.MUSIC_CANCEL_LOGIN),
    logout: () => ipcRenderer.invoke(IPC.MUSIC_LOGOUT),
    getDaily: () => ipcRenderer.invoke(IPC.MUSIC_GET_DAILY),
    search: (keyword: string, limit?: number) => ipcRenderer.invoke(IPC.MUSIC_SEARCH, { keyword, limit }),
    presentTracks: (args: unknown) => ipcRenderer.invoke(IPC.MUSIC_PRESENT_TRACKS, args),
    playTrack: (trackId: string) => ipcRenderer.invoke(IPC.MUSIC_PLAY_TRACK, trackId),
    playPlaylist: (playlistId: string) => ipcRenderer.invoke(IPC.MUSIC_PLAY_PLAYLIST, playlistId),
    detectPlayer: () => ipcRenderer.invoke(IPC.MUSIC_DETECT_PLAYER),
    onStateChanged: (h: (s: unknown) => void) => {
      const listener = (_: unknown, s: unknown) => h(s);
      ipcRenderer.on(IPC.MUSIC_STATE_CHANGED, listener);
      return () => ipcRenderer.removeListener(IPC.MUSIC_STATE_CHANGED, listener);
    },
    onCard: (h: (c: unknown) => void) => {
      const listener = (_: unknown, c: unknown) => h(c);
      ipcRenderer.on(IPC.MUSIC_CARD, listener);
      return () => ipcRenderer.removeListener(IPC.MUSIC_CARD, listener);
    },
  });
}
