import { describe, it, expect } from "vitest";
import {
  normalizeDailyRecommendations,
  normalizeSearchResults,
  normalizeMyPlaylists,
  normalizePlaylistDetail,
  normalizeCreatePlaylistResult,
  normalizeAddToPlaylistResult,
  normalizeMySubscriptions,
} from "./result-normalizer";

describe("result-normalizer", () => {
  it("normalizes daily recommendations into tracks", () => {
    const out = normalizeDailyRecommendations({ success: true, songs: [
      { id: 1, name: "Song A", artist: "X" },
      { id: 2, name: "Song B", artist: "Y" },
    ] });
    expect(out).toHaveLength(2);
    expect(out[0].artists).toEqual(["X"]);
    expect(out[1].id).toBe("2");
  });

  it("falls back to single artist when artist is array", () => {
    const out = normalizeDailyRecommendations({ success: true, songs: [{ id: 3, name: "t", artist: ["A", "B"] }] });
    expect(out[0].artists).toEqual(["A", "B"]);
  });

  it("normalizes search results with category=song", () => {
    const out = normalizeSearchResults({ success: true, items: [
      { id: 10, name: "S", artists: ["P", "Q"], album: "AL" },
    ] });
    expect(out).toHaveLength(1);
    expect(out[0].artists).toEqual(["P", "Q"]);
    expect(out[0].album).toBe("AL");
  });

  it("normalizes upstream bare-array search results", () => {
    const out = normalizeSearchResults([
      { id: 11, name: "Bare", artist: "Solo" },
    ]);

    expect(out).toEqual([
      expect.objectContaining({ id: "11", name: "Bare", artists: ["Solo"] }),
    ]);
  });

  it("returns empty array on failure", () => {
    expect(normalizeSearchResults({ success: false, error: "x" })).toEqual([]);
  });

  it("preserves a structured daily recommendation failure", () => {
    expect(() => normalizeDailyRecommendations({
      success: false,
      songs: [],
      error: { code: "E_DAILY_RECOMMEND_FAILED", message: "upstream unavailable" },
    })).toThrow(/E_DAILY_RECOMMEND_FAILED.*upstream unavailable/);
  });

  it("rejects legacy human-readable daily recommendation text", () => {
    expect(() => normalizeDailyRecommendations("📅 今日推荐 (1首): ..."))
      .toThrow(/E_DAILY_RECOMMEND_INVALID_RESPONSE/);
  });

  it("clamps to 30 tracks max", () => {
    const songs = Array.from({ length: 50 }, (_, i) => ({ id: i + 1, name: `n${i}`, artist: "a" }));
    expect(normalizeDailyRecommendations({ success: true, songs })).toHaveLength(30);
  });

  describe("cloud-music-mcp text fallback", () => {
    it("parses my playlists from natural language text", () => {
      const out = normalizeMyPlaylists("我的歌单: 喜欢的音乐、绝区零、phonk");
      expect(out).toEqual([
        { id: "", name: "喜欢的音乐", trackCount: 0 },
        { id: "", name: "绝区零", trackCount: 0 },
        { id: "", name: "phonk", trackCount: 0 },
      ]);
    });

    it("still prefers structured playlist payload", () => {
      const out = normalizeMyPlaylists({ success: true, playlists: [{ id: 1, name: "歌单A", count: 10 }] });
      expect(out).toEqual([{ id: "1", name: "歌单A", trackCount: 10 }]);
    });

    it("parses playlist detail tracks from text", () => {
      const out = normalizePlaylistDetail("歌单详情: 晴天 - 周杰伦、夜曲 - 周杰伦");
      expect(out.tracks).toEqual([
        { id: "", name: "晴天", artists: ["周杰伦"], album: undefined },
        { id: "", name: "夜曲", artists: ["周杰伦"], album: undefined },
      ]);
    });

    it("parses create playlist result from text", () => {
      const out = normalizeCreatePlaylistResult("已创建歌单: 新歌单");
      expect(out).toEqual({ id: "", name: "新歌单", trackCount: 0 });
    });

    it("parses add to playlist result from text", () => {
      const out = normalizeAddToPlaylistResult("已添加 3 首歌曲到歌单");
      expect(out.added).toBe(3);
    });

    it("parses my subscriptions from text", () => {
      const out = normalizeMySubscriptions("我的收藏: 周杰伦、林俊杰");
      expect(out).toEqual([
        { id: "", name: "周杰伦" },
        { id: "", name: "林俊杰" },
      ]);
    });
  });
});
