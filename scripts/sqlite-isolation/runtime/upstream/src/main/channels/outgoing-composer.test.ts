import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildTextOutgoingParts,
  createOutgoingComposer,
  downgradeToCapability,
  shouldAppendChannelTtsAudio,
} from "./outgoing-composer";
import type {
  ChannelCapability,
  IncomingMessage,
  OutgoingMessage,
  OutgoingPart,
} from "./types";

function makeCapability(
  overrides: Partial<ChannelCapability> = {},
): ChannelCapability {
  return {
    text: true,
    image: true,
    audio: true,
    file: true,
    video: true,
    markdown: true,
    card: true,
    sticker: true,
    maxTextLength: 4000,
    ...overrides,
  };
}

function makeMessage(parts: OutgoingPart[]): OutgoingMessage {
  return { channel: "feishu", targetId: "chat-1", parts };
}

function makeIncoming(
  overrides: Partial<IncomingMessage> = {},
): IncomingMessage {
  return {
    channel: "feishu",
    chatType: "private",
    senderId: "user-1",
    chatId: "chat-1",
    text: "你好",
    at: new Date(0),
    ...overrides,
  };
}

describe("channels/outgoing-composer", () => {
  describe("文本分段", () => {
    it("关闭移动端分段时保留为一个文本片段", () => {
      expect(buildTextOutgoingParts("第一句。第二句？", "off")).toEqual([
        { kind: "text", text: "第一句。第二句？" },
      ]);
    });

    it("开启移动端分段时按句子拆分文本", () => {
      expect(buildTextOutgoingParts("第一句。\n第二句？第三句！", "on")).toEqual([
        { kind: "text", text: "第一句。" },
        { kind: "text", text: "第二句？" },
        { kind: "text", text: "第三句！" },
      ]);
    });
  });

  describe("语音决策", () => {
    it("微信即使开启语音且支持音频也不追加语音", () => {
      expect(shouldAppendChannelTtsAudio("wechat", true, true, true)).toBe(false);
    });

    it("飞书开启语音且支持音频时追加语音", () => {
      expect(shouldAppendChannelTtsAudio("feishu", true, true, true)).toBe(true);
    });
  });

  describe("渠道能力降级", () => {
    it("超过文本长度上限时截断并追加提示", () => {
      const output = downgradeToCapability(
        makeMessage([{ kind: "text", text: "a".repeat(5000) }]),
        makeCapability({ maxTextLength: 100 }),
      );

      expect(output.parts).toHaveLength(1);
      expect(output.parts[0]).toEqual({
        kind: "text",
        text: `${"a".repeat(80)}\n...(过长已截断)`,
      });
    });

    it("文本长度上限为零时不截断", () => {
      const output = downgradeToCapability(
        makeMessage([{ kind: "text", text: "a".repeat(1000) }]),
        makeCapability({ maxTextLength: 0 }),
      );

      expect(output.parts).toEqual([{ kind: "text", text: "a".repeat(1000) }]);
    });

    it("不支持图片时降级为文字描述", () => {
      const output = downgradeToCapability(
        makeMessage([{ kind: "image", url: "https://x.png", caption: "截图" }]),
        makeCapability({ image: false }),
      );

      expect(output.parts).toEqual([{ kind: "text", text: "[图片] 截图" }]);
    });

    it("图片没有描述和地址时降级为空描述文字", () => {
      const output = downgradeToCapability(
        makeMessage([{ kind: "image" }]),
        makeCapability({ image: false }),
      );

      expect(output.parts).toEqual([{ kind: "text", text: "[图片] " }]);
    });

    it("不支持音频时降级为文字描述", () => {
      const output = downgradeToCapability(
        makeMessage([{ kind: "audio", filePath: "C:/tmp/x.mp3", mime: "audio/mpeg" }]),
        makeCapability({ audio: false }),
      );

      expect(output.parts).toEqual([
        { kind: "text", text: "[语音消息 audio/mpeg, 见桌面端]" },
      ]);
    });

    it("不支持文件和视频时分别降级为文字描述", () => {
      const output = downgradeToCapability(
        makeMessage([
          { kind: "file", filePath: "C:/tmp/report.pdf", name: "report.pdf" },
          { kind: "video", filePath: "C:/tmp/demo.mp4", name: "demo.mp4" },
        ]),
        makeCapability({ file: false, video: false }),
      );

      expect(output.parts).toEqual([
        { kind: "text", text: "[文件] report.pdf" },
        { kind: "text", text: "[视频] demo.mp4" },
      ]);
    });

    it("不支持卡片时保留标题、正文和字段", () => {
      const output = downgradeToCapability(
        makeMessage([{
          kind: "card",
          title: "天气",
          markdown: "晴 25°",
          fields: [{ key: "湿度", value: "60%" }],
        }]),
        makeCapability({ card: false }),
      );

      expect(output.parts).toEqual([{
        kind: "text",
        text: "天气\n晴 25°\n湿度: 60%",
      }]);
    });

    it("不支持表情包时跳过表情包片段", () => {
      const output = downgradeToCapability(
        makeMessage([
          { kind: "text", text: "回复" },
          { kind: "sticker", stickerId: "OK", imagePath: "C:/tmp/ok.png" },
        ]),
        makeCapability({ sticker: false }),
      );

      expect(output.parts).toEqual([{ kind: "text", text: "回复" }]);
    });

    it("支持对应能力时保留原始片段", () => {
      const message = makeMessage([
        { kind: "text", text: "回复" },
        { kind: "image", url: "https://x.png" },
        { kind: "audio", filePath: "C:/tmp/x.mp3", mime: "audio/mpeg" },
        { kind: "file", filePath: "C:/tmp/report.pdf" },
        { kind: "video", filePath: "C:/tmp/demo.mp4" },
        { kind: "card", title: "标题" },
        { kind: "sticker", stickerId: "OK", imagePath: "C:/tmp/ok.png" },
      ]);

      expect(downgradeToCapability(message, makeCapability())).toEqual(message);
    });

    it("没有能力声明时原样返回消息", () => {
      const message = makeMessage([
        { kind: "text", text: "a".repeat(5000) },
        { kind: "image", url: "https://x.png" },
      ]);

      expect(downgradeToCapability(message, undefined)).toEqual(message);
    });

    it("空消息片段保持为空", () => {
      const output = downgradeToCapability(
        makeMessage([]),
        makeCapability({ text: false }),
      );

      expect(output.parts).toEqual([]);
    });

    it("降级时不修改输入消息", () => {
      const message = makeMessage([
        { kind: "text", text: "回复" },
        { kind: "image", url: "https://x.png" },
      ]);
      const snapshot = structuredClone(message);

      downgradeToCapability(message, makeCapability({ image: false }));

      expect(message).toEqual(snapshot);
    });
  });

  it("生成语音时声明临时文件并能在发送后清理", async () => {
    const files = new Map<string, Buffer>();
    const composer = createOutgoingComposer({
      audioDirectory: "C:/virtual/channels/audio",
      createId: () => "audio-1",
      writeFile: async (filePath, data) => {
        files.set(filePath, data);
      },
      removeFile: async (filePath) => {
        files.delete(filePath);
      },
      synthesizeTts: async () => Buffer.from("audio"),
      resolveStickerImagePath: () => null,
    });

    const prepared = await composer.compose({
      incoming: makeIncoming(),
      replyText: "语音回复",
      sticker: null,
      capability: makeCapability({ audio: true }),
      settings: { ttsEnabled: true, stickerEnabled: true },
      mobileMessageSegmentation: "off",
    });

    expect(prepared.message.parts).toEqual([
      { kind: "text", text: "语音回复" },
      {
        kind: "audio",
        filePath: path.join("C:/virtual/channels/audio", "audio-1.mp3"),
        mime: "audio/mpeg",
      },
    ]);
    expect(prepared.transientFiles).toEqual([
      path.join("C:/virtual/channels/audio", "audio-1.mp3"),
    ]);
    expect(files.has(prepared.transientFiles[0])).toBe(true);

    await composer.cleanupTransientFiles(prepared.transientFiles);

    expect(files.size).toBe(0);
  });

  it("清理一个临时文件失败时继续清理其余文件", async () => {
    const removed: string[] = [];
    const composer = createOutgoingComposer({
      removeFile: async (filePath) => {
        if (filePath === "bad.mp3") throw new Error("占用中");
        removed.push(filePath);
      },
      resolveStickerImagePath: () => null,
    });

    await expect(composer.cleanupTransientFiles(["bad.mp3", "good.mp3"]))
      .resolves.toBeUndefined();
    expect(removed).toEqual(["good.mp3"]);
  });

  it("永久表情包资源不会被声明为临时文件", async () => {
    const composer = createOutgoingComposer({
      resolveStickerImagePath: () => "C:/stickers/ok.png",
    });

    const prepared = await composer.compose({
      incoming: makeIncoming(),
      replyText: "收到",
      sticker: "OK",
      capability: makeCapability({ sticker: true }),
      settings: { ttsEnabled: false, stickerEnabled: true },
      mobileMessageSegmentation: "off",
    });

    expect(prepared.message.parts).toEqual([
      { kind: "text", text: "收到" },
      { kind: "sticker", stickerId: "OK", imagePath: "C:/stickers/ok.png" },
    ]);
    expect(prepared.stickerId).toBe("OK");
    expect(prepared.transientFiles).toEqual([]);
  });

  it("表情包解析异常时保留文本和已生成的语音", async () => {
    const files = new Map<string, Buffer>();
    const composer = createOutgoingComposer({
      audioDirectory: "C:/virtual/channels/audio",
      createId: () => "audio-before-sticker",
      writeFile: async (filePath, data) => {
        files.set(filePath, data);
      },
      removeFile: async (filePath) => {
        files.delete(filePath);
      },
      synthesizeTts: async () => Buffer.from("audio"),
      resolveStickerImagePath: () => {
        throw new Error("表情目录不可用");
      },
    });

    const prepared = await composer.compose({
      incoming: makeIncoming(),
      replyText: "收到",
      sticker: "OK",
      capability: makeCapability({ audio: true, sticker: true }),
      settings: { ttsEnabled: true, stickerEnabled: true },
      mobileMessageSegmentation: "off",
    });

    expect(prepared.message.parts.map((part) => part.kind)).toEqual([
      "text",
      "audio",
    ]);
    expect(prepared.stickerId).toBeUndefined();
    expect(files.size).toBe(1);

    await composer.cleanupTransientFiles(prepared.transientFiles);
    expect(files.size).toBe(0);
  });

  it("渠道不支持表情包时不返回可提交的表情包编号", async () => {
    const composer = createOutgoingComposer({
      resolveStickerImagePath: () => "C:/stickers/ok.png",
    });

    const prepared = await composer.compose({
      incoming: makeIncoming(),
      replyText: "收到",
      sticker: "OK",
      capability: makeCapability({ sticker: false }),
      settings: { ttsEnabled: false, stickerEnabled: true },
      mobileMessageSegmentation: "off",
    });

    expect(prepared.message.parts).toEqual([{ kind: "text", text: "收到" }]);
    expect(prepared.stickerId).toBeUndefined();
  });
});
