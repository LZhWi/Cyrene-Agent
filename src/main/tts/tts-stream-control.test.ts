import { describe, expect, it } from "vitest";
import { TtsStreamControlRegistry } from "./tts-stream-control";

describe("TtsStreamControlRegistry", () => {
  it("cancels only the owning renderer's stream", () => {
    const registry = new TtsStreamControlRegistry();
    const signal = registry.start("tts-chat-12345678", 7);

    expect(registry.cancel("tts-chat-12345678", 8)).toBe(false);
    expect(signal.aborted).toBe(false);
    expect(registry.cancel("tts-chat-12345678", 7)).toBe(true);
    expect(signal.aborted).toBe(true);
  });

  it("rejects invalid and duplicate stream ids", () => {
    const registry = new TtsStreamControlRegistry();
    expect(() => registry.start("bad", 1)).toThrow(/E_INVALID_TTS_STREAM_ID/);
    registry.start("tts-chat-abcdefgh", 1);
    expect(() => registry.start("tts-chat-abcdefgh", 1)).toThrow(/E_TTS_STREAM_ID_CONFLICT/);
  });

  it("releases a completed id", () => {
    const registry = new TtsStreamControlRegistry();
    registry.start("tts-chat-abcdefgh", 1);
    registry.finish("tts-chat-abcdefgh");
    expect(() => registry.start("tts-chat-abcdefgh", 1)).not.toThrow();
  });
});
