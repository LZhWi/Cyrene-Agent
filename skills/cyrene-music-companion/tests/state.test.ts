import { describe, expect, it } from "vitest";
import { createMusicCompanionRuntime } from "../index";

const tracks = [
  { trackId: "101", name: "晴天", artists: ["周杰伦"] },
  { trackId: "102", name: "夜曲", artists: ["周杰伦"] },
  { trackId: "103", name: "后来", artists: ["刘若英"] },
];

function runtime(now = 1_000) {
  return createMusicCompanionRuntime({ now: () => now, random: () => 0.51 });
}

describe("cyrene-music-companion candidate state", () => {
  it("resolves 第二首 to the real track id in display order", () => {
    const skill = runtime();
    skill.recordPresented({ conversationId: "c1", setId: "set-1", expiresAt: 9_000, tracks });
    expect(skill.resolveSelection("c1", "第二首")).toEqual({ kind: "resolved", reason: "ordinal", setId: "set-1", track: tracks[1] });
  });

  it("returns ambiguous when multiple displayed tracks share a name", () => {
    const skill = runtime();
    skill.recordPresented({ conversationId: "c1", setId: "set-1", expiresAt: 9_000, tracks: [
      { trackId: "201", name: "唯一", artists: ["告五人"] },
      { trackId: "202", name: "唯一", artists: ["邓紫棋"] },
    ] });
    const result = skill.resolveSelection("c1", "播放唯一");
    expect(result.kind).toBe("ambiguous");
    if (result.kind === "ambiguous") expect(result.candidates.map((item) => item.trackId)).toEqual(["201", "202"]);
  });

  it("does not resolve an expired candidate set", () => {
    let now = 1_000;
    const skill = createMusicCompanionRuntime({ now: () => now });
    skill.recordPresented({ conversationId: "c1", setId: "set-1", expiresAt: 2_000, tracks });
    now = 2_001;
    expect(skill.resolveSelection("c1", "第一首")).toEqual({ kind: "expired" });
  });

  it("isolates candidate sets by conversation", () => {
    const skill = runtime();
    skill.recordPresented({ conversationId: "c1", setId: "set-1", expiresAt: 9_000, tracks });
    expect(skill.resolveSelection("c2", "第一首")).toEqual({ kind: "not_found" });
  });

  it("treats 好啊 as agreement rather than playback authorization", () => {
    const skill = runtime();
    skill.recordPresented({ conversationId: "c1", setId: "set-1", expiresAt: 9_000, tracks });
    expect(skill.resolveSelection("c1", "好啊")).toEqual({ kind: "not_found" });
  });

  it("delegates only to one track from the current real candidate set", () => {
    const skill = runtime();
    skill.recordPresented({ conversationId: "c1", setId: "set-1", expiresAt: 9_000, tracks });
    const result = skill.resolveSelection("c1", "你挑一首");
    expect(result.kind).toBe("resolved");
    if (result.kind === "resolved") {
      expect(result.reason).toBe("delegate");
      expect(tracks).toContainEqual(result.track);
    }
  });
});
