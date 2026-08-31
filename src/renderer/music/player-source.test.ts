import { describe, expect, it } from "vitest";
import { canOpenPlayer, pickInitialPlaylist, LOCAL_CACHE_PLAYLIST_ID } from "./player-source";

describe("canOpenPlayer", () => {
  it("只登录了网易云 → 可以打开", () => {
    expect(canOpenPlayer({ neteaseSignedIn: true, localTrackCount: 0 })).toBe(true);
  });

  it("只有本地音乐、没登录网易云 → 也必须可以打开（这就是那个 bug）", () => {
    expect(canOpenPlayer({ neteaseSignedIn: false, localTrackCount: 12 })).toBe(true);
  });

  it("两者都有 → 可以打开", () => {
    expect(canOpenPlayer({ neteaseSignedIn: true, localTrackCount: 12 })).toBe(true);
  });

  it("两者都没有 → 才显示未就绪", () => {
    expect(canOpenPlayer({ neteaseSignedIn: false, localTrackCount: 0 })).toBe(false);
  });
});

describe("pickInitialPlaylist", () => {
  it("没登录网易云但有本地曲库 → 自动落到本地歌单", () => {
    expect(pickInitialPlaylist({ currentId: "", localTrackCount: 5, neteasePlaylistCount: 0 }))
      .toBe(LOCAL_CACHE_PLAYLIST_ID);
  });

  it("用户已经选过歌单 → 不覆盖", () => {
    expect(pickInitialPlaylist({ currentId: "已选", localTrackCount: 5, neteasePlaylistCount: 0 }))
      .toBeNull();
  });

  it("有网易云歌单时不抢选择权（沿用原有的选首个歌单逻辑）", () => {
    expect(pickInitialPlaylist({ currentId: "", localTrackCount: 5, neteasePlaylistCount: 3 }))
      .toBeNull();
  });

  it("本地曲库为空 → 没什么可自动选", () => {
    expect(pickInitialPlaylist({ currentId: "", localTrackCount: 0, neteasePlaylistCount: 0 }))
      .toBeNull();
  });
});
