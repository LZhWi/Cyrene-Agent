import { describe, it, expect, vi } from "vitest";

vi.mock("../sticker-storage", () => ({
  loadUserStickerManifest: () => ({
    mycat: { id: "mycat", file: "mycat.png", description: "我的猫", phrases: ["喵"], createdAt: 0 },
  }),
}));

import { formatStickerMarker, formatImageMarker, describeMarkersForLlm } from "./mobile-markers";

describe("mobile-markers", () => {
  it("formats markers", () => {
    expect(formatStickerMarker("OK")).toBe("[sticker:OK]");
    expect(formatImageMarker("abc123")).toBe("[image:abc123]");
  });

  it("describes built-in sticker markers for LLM", () => {
    expect(describeMarkersForLlm("好呀 [sticker:OK]")).toBe("好呀 （发送表情包：好的，没问题）");
  });

  it("describes user sticker markers via manifest phrases", () => {
    expect(describeMarkersForLlm("[sticker:mycat]")).toBe("（发送表情包：喵）");
  });

  it("replaces image markers with placeholder", () => {
    expect(describeMarkersForLlm("看这个 [image:deadbeef]")).toBe("看这个 （图片）");
  });

  it("leaves unknown sticker id as generic label", () => {
    expect(describeMarkersForLlm("[sticker:__nope__]")).toBe("（发送表情包）");
  });
});
