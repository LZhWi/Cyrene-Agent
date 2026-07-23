import { describe, it, expect, vi } from "vitest";

vi.mock("../sticker-storage", () => ({
  loadUserStickerManifest: () => ({
    mycat: { id: "mycat", file: "mycat.png", description: "我的猫", phrases: ["喵"], createdAt: 0 },
  }),
}));

import { formatStickerMarker, formatImageMarker, describeMarkersForLlm, stripStickerStageDirections } from "./mobile-markers";

describe("mobile-markers", () => {
  it("formats markers", () => {
    expect(formatStickerMarker("OK")).toBe("[sticker:OK]");
    expect(formatImageMarker("abc123")).toBe("[image:abc123]");
  });

  it("describes built-in sticker markers for LLM (user subject by default)", () => {
    expect(describeMarkersForLlm("好呀 [sticker:OK]")).toBe("好呀 （用户发送表情包：好的，没问题）");
  });

  it("describes user sticker markers via manifest phrases", () => {
    expect(describeMarkersForLlm("[sticker:mycat]")).toBe("（用户发送表情包：喵）");
  });

  it("drops the assistant's own markers from LLM context (PC out-of-band discipline)", () => {
    expect(describeMarkersForLlm("[sticker:mycat]", "assistant")).toBe("");
    expect(describeMarkersForLlm("好呀 [sticker:OK]", "assistant")).toBe("好呀");
  });

  it("also strips leaked stage-directions when feeding assistant history to LLM", () => {
    // history-log 存原始（含漏出的舞台指示 + 真标记），喂回 LLM 时应得到干净正文。
    expect(describeMarkersForLlm("好呀～（发送表情包：开心） [sticker:OK]", "assistant")).toBe("好呀～");
    expect(describeMarkersForLlm("（我发送了表情包：开心）", "assistant")).toBe("");
  });

  it("replaces user image markers with subject-aware placeholder; drops assistant's own", () => {
    expect(describeMarkersForLlm("看这个 [image:deadbeef]")).toBe("看这个 （用户发送了图片）");
    expect(describeMarkersForLlm("[image:deadbeef]", "assistant")).toBe("");
  });

  it("leaves unknown sticker id as generic label", () => {
    expect(describeMarkersForLlm("[sticker:__nope__]")).toBe("（用户发送表情包）");
  });

  it("strips stage-direction the model echoed (with desc)", () => {
    expect(stripStickerStageDirections("好呀～（发送表情包：等你回复）")).toBe("好呀～");
  });

  it("strips bare stage-direction and mid-text ones", () => {
    expect(stripStickerStageDirections("（发送表情包）等你哦")).toBe("等你哦");
    expect(stripStickerStageDirections("（发送表情包：开心）")).toBe("");
  });

  it("strips ascii-paren / colon variants", () => {
    expect(stripStickerStageDirections("(发送表情包:开心)么么哒")).toBe("么么哒");
  });

  it("strips subject-carrying variants the model may echo from its own history", () => {
    expect(stripStickerStageDirections("好呀～（我发送了表情包：开心）")).toBe("好呀～");
    expect(stripStickerStageDirections("（用户发送表情包：期待）你好")).toBe("你好");
    expect(stripStickerStageDirections("嗯（我发送了图片）")).toBe("嗯");
    expect(stripStickerStageDirections("（用户发送了图片）看到了")).toBe("看到了");
  });

  it("keeps normal sentences that merely mention stickers", () => {
    expect(stripStickerStageDirections("这个表情包好可爱")).toBe("这个表情包好可爱");
  });
});
