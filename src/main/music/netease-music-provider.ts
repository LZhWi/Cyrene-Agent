import type { MusicMcpClient } from "./music-mcp-client";
import {
  normalizeDailyRecommendations,
  normalizeSearchResults,
  normalizeMyPlaylists,
  normalizePlaylistDetail,
  normalizeCreatePlaylistResult,
  normalizeAddToPlaylistResult,
  normalizeMySubscriptions,
} from "./result-normalizer";
import { normalizeMcpPlaybackResult } from "./playback-result-normalizer";
import type { MusicProvider } from "./music-provider";

export const NETEASE_PROVIDER_ID = "netease-cloud-music";

export class NeteaseMusicProvider implements MusicProvider {
  readonly id = NETEASE_PROVIDER_ID;

  constructor(private readonly client: MusicMcpClient) {}

  async getDailyRecommendations() {
    const raw = await this.client.callDataTool("cloud_music_get_daily_recommend", {});
    return normalizeDailyRecommendations(raw);
  }

  async searchTracks(keyword: string) {
    const raw = await this.client.callDataTool("cloud_music_search", { keyword, category: "song" });
    return normalizeSearchResults(raw);
  }

  async playTrack(trackId: string) {
    const raw = await this.client.callDataTool("cloud_music_play", { id: trackId, type: "song" });
    return normalizeMcpPlaybackResult(raw, "song", trackId);
  }

  async playPlaylist(playlistId: string) {
    const raw = await this.client.callDataTool("cloud_music_play", { id: playlistId, type: "playlist" });
    return normalizeMcpPlaybackResult(raw, "playlist", playlistId);
  }

  async getMyPlaylists() {
    console.log("[MusicProvider/Trace] getMyPlaylists request");
    const raw = await this.client.callDataTool("cloud_music_my_playlists", {});
    console.log("[MusicProvider/Trace] getMyPlaylists raw=", JSON.stringify(raw).slice(0, 2000));
    return normalizeMyPlaylists(raw);
  }

  async getPlaylistDetail(playlistId: string) {
    console.log("[MusicProvider/Trace] getPlaylistDetail request playlistId=", playlistId);
    const raw = await this.client.callDataTool("cloud_music_playlist_detail", { playlist_id: playlistId });
    console.log("[MusicProvider/Trace] getPlaylistDetail raw=", JSON.stringify(raw).slice(0, 2000));
    return normalizePlaylistDetail(raw);
  }

  async createPlaylist(name: string, privacy = false) {
    console.log("[MusicProvider/Trace] createPlaylist request name=", name, "privacy=", privacy);
    const raw = await this.client.callDataTool("cloud_music_create_playlist", { name, privacy });
    console.log("[MusicProvider/Trace] createPlaylist raw=", JSON.stringify(raw).slice(0, 2000));
    return normalizeCreatePlaylistResult(raw);
  }

  async addToPlaylist(playlistId: string, trackIds: string[]) {
    console.log("[MusicProvider/Trace] addToPlaylist request playlistId=", playlistId, "trackIds=", trackIds);
    const raw = await this.client.callDataTool("cloud_music_add_to_playlist", { playlist_id: playlistId, track_ids: trackIds });
    console.log("[MusicProvider/Trace] addToPlaylist raw=", JSON.stringify(raw).slice(0, 2000));
    return normalizeAddToPlaylistResult(raw);
  }

  async getMySubscriptions(category: "artists" | "albums") {
    console.log("[MusicProvider/Trace] getMySubscriptions request category=", category);
    const raw = await this.client.callDataTool("cloud_music_my_subscriptions", { category });
    console.log("[MusicProvider/Trace] getMySubscriptions raw=", JSON.stringify(raw).slice(0, 2000));
    return normalizeMySubscriptions(raw);
  }
}
