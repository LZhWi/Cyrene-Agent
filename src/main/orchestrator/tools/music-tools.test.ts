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
  it("music_play_track delegates to MusicService.playTrack", async () => {
    const service = serviceDouble();
    service.playTrack.mockResolvedValue({ state: "dispatched", resourceType: "song", resourceId: "123" });
    const tool = buildMusicTools(service as never).find((candidate) => candidate.id === "music_play_track")!;

    const output = JSON.parse(await tool.execute({ trackId: "123" }));

    expect(service.playTrack).toHaveBeenCalledWith("123");
    expect(output.dispatch.state).toBe("dispatched");
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
