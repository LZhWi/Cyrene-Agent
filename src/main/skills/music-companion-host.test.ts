import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildMusicCompanionContext,
  clearMusicCompanionHost,
  configureMusicCompanionHost,
  isMusicCompanionAvailable,
  recordMusicCompanionPresentation,
} from "./music-companion-host";

function runtimeDouble(result: any = { kind: "not_found" }) {
  return {
    shouldInject: vi.fn(() => true),
    recordPresented: vi.fn(),
    resolveSelection: vi.fn(() => result),
    clear: vi.fn(),
  };
}

beforeEach(() => clearMusicCompanionHost());

describe("music-companion host", () => {
  it("uses the compound runtime as the Skill availability gate", () => {
    const runtime = runtimeDouble();
    const capabilities = { skillEnabled: true, backendAvailable: true, enabledTools: ["music_search"] };
    configureMusicCompanionHost(runtime, () => capabilities);

    expect(isMusicCompanionAvailable()).toBe(true);
    expect(runtime.shouldInject).toHaveBeenCalledWith(capabilities);
  });

  it("records only the exact candidate set supplied by music_present_tracks", () => {
    const runtime = runtimeDouble();
    configureMusicCompanionHost(runtime, () => ({ skillEnabled: true, backendAvailable: true, enabledTools: [] }));
    const set = { conversationId: "c1", setId: "s1", expiresAt: 9_000, tracks: [
      { trackId: "101", name: "晴天", artists: ["周杰伦"] },
    ] };

    recordMusicCompanionPresentation(set);

    expect(runtime.recordPresented).toHaveBeenCalledWith(set);
  });

  it("turns a resolved reference into an exact official play-tool instruction", () => {
    const runtime = runtimeDouble({
      kind: "resolved",
      reason: "ordinal",
      setId: "s1",
      track: { trackId: "102", name: "夜曲", artists: ["周杰伦"] },
    });
    configureMusicCompanionHost(runtime, () => ({ skillEnabled: true, backendAvailable: true, enabledTools: [] }));

    const context = buildMusicCompanionContext("c1", "第二首");

    expect(context).toContain("trackId=102");
    expect(context).toContain("music_play_track");
    expect(context).toContain("已明确授权");
  });

  it("does not inject selection context while capabilities are unavailable", () => {
    const runtime = runtimeDouble({ kind: "resolved", reason: "ordinal", setId: "s1", track: { trackId: "1", name: "x", artists: [] } });
    runtime.shouldInject.mockReturnValue(false);
    configureMusicCompanionHost(runtime, () => ({ skillEnabled: true, backendAvailable: false, enabledTools: [] }));

    expect(buildMusicCompanionContext("c1", "第一首")).toBe("");
    expect(runtime.resolveSelection).not.toHaveBeenCalled();
  });
});
