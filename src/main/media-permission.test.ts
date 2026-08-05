import { describe, expect, it } from "vitest";
import { isAudioMediaCheck, isAudioOnlyMediaRequest } from "./media-permission";

describe("desktop media permissions", () => {
  it("allows microphone-only permission checks", () => {
    expect(isAudioMediaCheck("audio")).toBe(true);
    expect(isAudioMediaCheck("video")).toBe(false);
    expect(isAudioMediaCheck("unknown")).toBe(false);
  });

  it("allows only explicit audio-only permission requests", () => {
    expect(isAudioOnlyMediaRequest(["audio"])).toBe(true);
    expect(isAudioOnlyMediaRequest(["audio", "video"])).toBe(false);
    expect(isAudioOnlyMediaRequest(["video"])).toBe(false);
    expect(isAudioOnlyMediaRequest(undefined)).toBe(false);
  });
});
