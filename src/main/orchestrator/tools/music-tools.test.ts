import { describe, expect, it, vi } from "vitest";
import { buildMusicTools } from "./music-tools";

function serviceDouble() {
  return {
    getDailyRecommendations: vi.fn(),
    searchTracks: vi.fn(),
    presentTracks: vi.fn(),
    getSelectionSet: vi.fn(),
    playTrack: vi.fn(),
    playPlaylist: vi.fn(),
  };
}

describe("music Agent tools", () => {
  it("daily recommendations publish the first five real tracks as a card", async () => {
    const service = serviceDouble();
    const tracks = Array.from({ length: 6 }, (_, index) => ({
      id: String(index + 1),
      name: `歌曲${index + 1}`,
      artists: ["歌手"],
    }));
    const set = {
      setId: "daily-1",
      provider: "netease-cloud-music",
      source: "daily_recommendation",
      expiresAt: 9_000,
      conversationId: "conversation-1",
      tracks,
    };
    service.getDailyRecommendations.mockResolvedValue(set);
    service.presentTracks.mockResolvedValue({ cardRef: "cyrene:music:daily-1" });
    service.getSelectionSet.mockReturnValue(set);
    const onPresented = vi.fn();
    const sendCard = vi.fn();
    const tool = buildMusicTools(service as never, { onPresented, sendCard })
      .find((candidate) => candidate.id === "music_get_daily_recommendations")!;

    await tool.execute({}, { userQuery: "今日推荐", conversationId: "conversation-1", runId: "run-1" });

    expect(service.getDailyRecommendations).toHaveBeenCalledWith(
      "conversation-1",
      { resolutionRunId: "run-1" },
    );

    expect(service.presentTracks).toHaveBeenCalledWith(expect.objectContaining({
      setId: "daily-1",
      conversationId: "conversation-1",
      trackIds: ["1", "2", "3", "4", "5"],
    }));
    expect(onPresented).toHaveBeenCalledWith(expect.objectContaining({
      setId: "daily-1",
      tracks: expect.arrayContaining([expect.objectContaining({
        provider: "netease-cloud-music",
        trackId: "1",
      })]),
    }));
    expect(sendCard).toHaveBeenCalledWith(expect.objectContaining({
      setId: "daily-1",
      tracks: tracks.slice(0, 5),
    }));
  });

  it("music_play_track delegates a complete real-candidate reference with ToolContext", async () => {
    const service = serviceDouble();
    service.playTrack.mockResolvedValue({ state: "dispatched", resourceType: "song", resourceId: "123" });
    const tool = buildMusicTools(service as never).find((candidate) => candidate.id === "music_play_track")!;

    const output = JSON.parse(await tool.execute(
      { provider: "netease-cloud-music", setId: "set-1", trackId: "123" },
      { userQuery: "播放稻香", conversationId: "c1", runId: "run-1" },
    ));

    expect(service.playTrack).toHaveBeenCalledWith({
      provider: "netease-cloud-music",
      setId: "set-1",
      trackId: "123",
      conversationId: "c1",
      runId: "run-1",
    });
    expect(output.dispatch.state).toBe("dispatched");
  });

  it("marks discovery searches as presented but keeps direct-play resolution unpresented", async () => {
    const service = serviceDouble();
    const set = {
      setId: "set-1",
      provider: "netease-cloud-music",
      source: "search",
      expiresAt: 9_000,
      conversationId: "c1",
      tracks: [{ id: "123", name: "稻香", artists: ["周杰伦"] }],
    };
    service.searchTracks.mockResolvedValue(set);
    service.presentTracks.mockResolvedValue({ cardRef: "card" });
    service.getSelectionSet.mockReturnValue(set);
    const tool = buildMusicTools(service as never).find((candidate) => candidate.id === "music_search")!;

    await tool.execute(
      { keyword: "稻香", purpose: "discover" },
      { userQuery: "搜一下稻香", conversationId: "c1", runId: "run-1" },
    );
    expect(service.presentTracks).toHaveBeenCalled();

    service.presentTracks.mockClear();
    await tool.execute(
      { keyword: "稻香", purpose: "play" },
      { userQuery: "播放稻香", conversationId: "c1", runId: "run-2" },
    );
    expect(service.presentTracks).not.toHaveBeenCalled();
  });

  it("does not trust a model-supplied play purpose without an explicit playback request", async () => {
    const service = serviceDouble();
    const set = {
      setId: "set-1",
      provider: "netease-cloud-music",
      source: "search",
      expiresAt: 9_000,
      conversationId: "c1",
      tracks: [{ id: "123", name: "稻香", artists: ["周杰伦"] }],
    };
    service.searchTracks.mockResolvedValue(set);
    service.presentTracks.mockResolvedValue({ cardRef: "card" });
    service.getSelectionSet.mockReturnValue(set);
    const tool = buildMusicTools(service as never).find((candidate) => candidate.id === "music_search")!;

    await tool.execute(
      { keyword: "稻香", purpose: "play" },
      { userQuery: "搜一下稻香", conversationId: "c1", runId: "run-1" },
    );

    expect(service.searchTracks).toHaveBeenCalledWith(
      "稻香",
      "c1",
      undefined,
      { resolutionRunId: "run-1", purpose: "discover" },
    );
    expect(service.presentTracks).toHaveBeenCalled();
  });

  it("presents ambiguous direct-play search results for a later explicit selection", async () => {
    const service = serviceDouble();
    const set = {
      setId: "set-ambiguous",
      provider: "netease-cloud-music",
      source: "search",
      expiresAt: 9_000,
      conversationId: "c1",
      tracks: [
        { id: "123", name: "唯一", artists: ["告五人"] },
        { id: "456", name: "唯一", artists: ["邓紫棋"] },
      ],
    };
    service.searchTracks.mockResolvedValue(set);
    service.presentTracks.mockResolvedValue({ cardRef: "card" });
    service.getSelectionSet.mockReturnValue(set);
    const tool = buildMusicTools(service as never).find((candidate) => candidate.id === "music_search")!;

    await tool.execute(
      { keyword: "唯一" },
      { userQuery: "播放唯一", conversationId: "c1", runId: "run-1" },
    );

    expect(service.presentTracks).toHaveBeenCalledWith(expect.objectContaining({
      setId: "set-ambiguous",
      trackIds: ["123", "456"],
    }));
  });

  it("music_play_playlist delegates to MusicService.playPlaylist", async () => {
    const service = serviceDouble();
    service.playPlaylist.mockResolvedValue({ state: "dispatched", resourceType: "playlist", resourceId: "456" });
    const tool = buildMusicTools(service as never).find((candidate) => candidate.id === "music_play_playlist")!;

    await tool.execute({ playlistId: "456" });

    expect(service.playPlaylist).toHaveBeenCalledWith("456");
  });

  it("music_present_tracks uses ToolContext conversation and publishes the exact displayed order", async () => {
    const service = serviceDouble();
    service.presentTracks.mockResolvedValue({ cardRef: "cyrene:music:set-1:102:101" });
    service.getSelectionSet.mockReturnValue({
      setId: "set-1",
      provider: "netease-cloud-music",
      expiresAt: 9_000,
      conversationId: "conversation-1",
      tracks: [
        { id: "101", name: "晴天", artists: ["周杰伦"] },
        { id: "102", name: "夜曲", artists: ["周杰伦"] },
      ],
    });
    const onPresented = vi.fn();
    const sendCard = vi.fn();
    const tool = buildMusicTools(service as never, { onPresented, sendCard })
      .find((candidate) => candidate.id === "music_present_tracks")!;

    await tool.execute(
      { setId: "set-1", trackIds: ["102", "101"] },
      { userQuery: "帮我找几首", conversationId: "conversation-1" },
    );

    expect(service.presentTracks).toHaveBeenCalledWith(expect.objectContaining({ conversationId: "conversation-1" }));
    expect(onPresented).toHaveBeenCalledWith(expect.objectContaining({
      conversationId: "conversation-1",
      setId: "set-1",
      tracks: [
        expect.objectContaining({ trackId: "102", name: "夜曲" }),
        expect.objectContaining({ trackId: "101", name: "晴天" }),
      ],
    }));
    expect(sendCard).toHaveBeenCalledWith(expect.objectContaining({
      setId: "set-1",
      tracks: [expect.objectContaining({ id: "102" }), expect.objectContaining({ id: "101" })],
    }));
  });
});
