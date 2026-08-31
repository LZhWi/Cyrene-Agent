// 播放器选源判定 —— 纯函数，便于单测，也让 App.tsx 里的条件有个明确出处。
//
// 起因是一个真实 bug：本地曲库的加载和整个播放器 UI 都被挂在
// `account === "signed_in"` 下面，于是只导入了本地音乐、没登录网易云的用户，
// 打开播放器永远看到「音乐服务未就绪，请先扫码登录网易云」——而本地播放
// 根本不需要网易云。

/** 缓存/本地虚拟歌单的固定 id。 */
export const LOCAL_CACHE_PLAYLIST_ID = "__local_cache__";

/** 播放器是否有内容可放。登录网易云和有本地曲库，任一成立即可。 */
export function canOpenPlayer(opts: {
  neteaseSignedIn: boolean;
  localTrackCount: number;
}): boolean {
  return opts.neteaseSignedIn || opts.localTrackCount > 0;
}

/**
 * 打开播放器时该默认选哪个歌单。
 * 返回 null 表示「不动」——用户已经选过，或者没有可自动选的。
 */
export function pickInitialPlaylist(opts: {
  currentId: string;
  localTrackCount: number;
  neteasePlaylistCount: number;
}): string | null {
  if (opts.currentId) return null;                // 不覆盖用户的手动选择
  if (opts.localTrackCount === 0) return null;    // 没有本地曲库
  if (opts.neteasePlaylistCount > 0) return null; // 有网易云歌单时沿用原有的「选首个」逻辑
  return LOCAL_CACHE_PLAYLIST_ID;
}
