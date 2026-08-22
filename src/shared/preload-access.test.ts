import { describe, expect, it } from "vitest";
import { parsePreloadWindowRole, shouldExposePreloadApi } from "./preload-access";

describe("preload access policy", () => {
  it("parses only known main-process window roles", () => {
    expect(parsePreloadWindowRole(["electron", "--cyrene-window-role=chat"])).toBe("chat");
    expect(parsePreloadWindowRole(["electron", "--cyrene-window-role=unknown"])).toBeNull();
    expect(parsePreloadWindowRole(["electron"])).toBeNull();
  });

  it("limits privileged APIs to the window that needs them", () => {
    expect(shouldExposePreloadApi("chat", "agui")).toBe(true);
    expect(shouldExposePreloadApi("chat", "gameBot")).toBe(false);
    expect(shouldExposePreloadApi("call", "tts")).toBe(true);
    expect(shouldExposePreloadApi("call", "settings")).toBe(false);
    expect(shouldExposePreloadApi("sticker-manager", "stickerManager")).toBe(true);
    expect(shouldExposePreloadApi("sticker-manager", "chatStore")).toBe(false);
  });

  it("keeps unlabelled legacy windows compatible", () => {
    expect(shouldExposePreloadApi(null, "gameBot")).toBe(true);
    expect(shouldExposePreloadApi(null, "settings")).toBe(true);
  });
});
