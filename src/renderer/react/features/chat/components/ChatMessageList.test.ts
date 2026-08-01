import { describe, expect, it } from "vitest";
import { extractMessageStickerId, stripMessageStickerMarkers } from "./message-sticker";

describe("React chat sticker messages", () => {
  it("extracts a persisted user sticker marker and hides the raw marker", () => {
    expect(extractMessageStickerId("[sticker:hugtight]")).toBe("hugtight");
    expect(stripMessageStickerMarkers("[sticker:hugtight]")).toBe("");
  });

  it("keeps user text while removing only its sticker marker", () => {
    expect(stripMessageStickerMarkers("给你一个 [sticker:hugtight]")).toBe("给你一个");
  });
});
