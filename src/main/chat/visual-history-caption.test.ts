import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  sessions: new Map<string, any>(),
  caption: vi.fn(),
  setCaption: vi.fn(),
}));

vi.mock("../chats/chats-store", () => ({
  getSession: (id: string) => state.sessions.get(id) ?? null,
  listSessions: () => [...state.sessions.values()].map(({ messages, ...meta }) => meta),
  setImageVisualIndexResult: state.setCaption,
}));
vi.mock("./image-caption", () => ({ validateCaptionImagePath: () => ({ ok: true, buffer: Buffer.from("image"), mime: "image/png" }) }));
vi.mock("../settings/model-settings", () => ({ loadVisionConfig: () => ({ provider: "test" }) }));
vi.mock("../orchestrator/vision-captioner", () => ({ captionImageWithRetryAndFallback: state.caption }));

import { backfillVisualHistoryCaptions, retryVisualHistoryAfterScreenObservation, scheduleVisualHistoryCaption } from "./visual-history-caption";

const attachment = (extra: Record<string, unknown> = {}) => ({
  kind: "image", name: "scene.png", filePath: "C:/scene.png", mime: "image/png", status: "done", ...extra,
});
async function settle() {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

describe("视觉历史后台描述", () => {
  beforeEach(() => {
    state.sessions.clear();
    retryVisualHistoryAfterScreenObservation();
    state.caption.mockReset().mockResolvedValue('{"summary":"蓝色丝带系在小摆件上","detail":"蓝色丝带系在小摆件上，旁边有白花"}');
    state.setCaption.mockReset().mockReturnValue(true);
  });

  it("直发模式同轮生成摘要和详情，已有 caption 只生成短摘要", async () => {
    state.sessions.set("chat", { id: "chat", mode: "chat", messages: [
      { id: "direct", role: "user", attachments: [attachment()] },
      { id: "caption", role: "user", attachments: [attachment({ filePath: "C:/other.png", caption: "已有描述" })] },
    ] });
    state.caption.mockResolvedValueOnce('{"summary":"蓝色丝带系在小摆件上","detail":"蓝色丝带系在小摆件上，旁边有白花"}')
      .mockResolvedValueOnce("窗边花瓶里插着几朵白花");
    backfillVisualHistoryCaptions();
    scheduleVisualHistoryCaption("chat", "direct");
    await settle();
    expect(state.caption).toHaveBeenCalledTimes(2);
    expect(state.setCaption).toHaveBeenCalledWith("chat", "direct", "C:/scene.png",
      { summary: "蓝色丝带系在小摆件上", caption: "蓝色丝带系在小摆件上，旁边有白花" });
    expect(state.setCaption).toHaveBeenCalledWith("chat", "caption", "C:/other.png",
      { summary: "窗边花瓶里插着几朵白花" });
  });

  it("模型失败后不立即重试，下一次周期观察结束才补建", async () => {
    state.sessions.set("chat", { id: "chat", mode: "chat", messages: [
      { id: "failed", role: "user", attachments: [attachment()] },
    ] });
    state.caption.mockResolvedValueOnce("[错误] 暂时不可用")
      .mockResolvedValueOnce('{"summary":"恢复后看见窗边的蓝花瓶","detail":"恢复后的描述"}');
    scheduleVisualHistoryCaption("chat", "failed");
    await settle();
    expect(state.setCaption).not.toHaveBeenCalled();
    expect(state.caption).toHaveBeenCalledTimes(1);
    retryVisualHistoryAfterScreenObservation();
    await settle();
    expect(state.setCaption).toHaveBeenCalledWith("chat", "failed", "C:/scene.png",
      { summary: "恢复后看见窗边的蓝花瓶", caption: "恢复后的描述" });
    expect(state.caption).toHaveBeenCalledTimes(2);
  });

  it("rejects a too-short model output instead of truncating a caption", async () => {
    state.sessions.set("chat", { id: "chat", mode: "chat", messages: [
      { id: "short", role: "user", attachments: [attachment({ caption: "原有完整描述".repeat(50) })] },
    ] });
    state.caption.mockResolvedValueOnce("花瓶");
    scheduleVisualHistoryCaption("chat", "short");
    await settle();
    expect(state.setCaption).not.toHaveBeenCalled();
  });

  it("pauses a backfill batch after a model error without losing later images", async () => {
    state.sessions.set("chat", { id: "chat", mode: "chat", messages: [
      { id: "first", role: "user", attachments: [attachment()] },
      { id: "second", role: "user", attachments: [attachment({ filePath: "C:/second.png" })] },
    ] });
    state.caption.mockResolvedValueOnce("[错误] 服务暂不可用")
      .mockResolvedValueOnce('{"summary":"窗边摆着一只蓝色小花瓶","detail":"窗边有一只蓝色花瓶"}');
    backfillVisualHistoryCaptions();
    await settle();
    expect(state.caption).toHaveBeenCalledTimes(1);
    scheduleVisualHistoryCaption("chat", "second");
    await settle();
    expect(state.setCaption).toHaveBeenCalledWith("chat", "second", "C:/second.png", expect.anything());
  });
});
