import { describe, expect, it } from "vitest";
import { createMusicCompanionRuntime } from "../index";

const required = ["music_get_daily_recommendations", "music_search", "music_present_tracks", "music_play_track"];

describe("cyrene-music-companion capability gate", () => {
  it("does not inject proactive strategy when the Skill is disabled", () => {
    const skill = createMusicCompanionRuntime();
    expect(skill.shouldInject({ skillEnabled: false, backendAvailable: true, enabledTools: required })).toBe(false);
  });

  it("does not induce music use when a required music tool is disabled", () => {
    const skill = createMusicCompanionRuntime();
    expect(skill.shouldInject({ skillEnabled: true, backendAvailable: true, enabledTools: required.filter((id) => id !== "music_play_track") })).toBe(false);
  });

  it("injects only when the backend and every required tool are available", () => {
    const skill = createMusicCompanionRuntime();
    expect(skill.shouldInject({ skillEnabled: true, backendAvailable: true, enabledTools: required })).toBe(true);
    expect(skill.shouldInject({ skillEnabled: true, backendAvailable: false, enabledTools: required })).toBe(false);
  });
});
