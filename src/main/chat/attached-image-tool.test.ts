// ask_attached_image 工具测试 — 用户发图流程与屏幕观察 focus 旁路对齐的一环：
// LLM 填 focus 追问用户图片细节，照原图回答、不写缓存。
// mock registry/vlm-analyzer/image-caption，规避 rag/electron 重依赖链。

import { describe, it, expect, vi, beforeEach } from "vitest";

const registryMocks = vi.hoisted(() => ({
  register: vi.fn(),
}));
vi.mock("../orchestrator/tool-registry", () => ({ toolRegistry: registryMocks }));

const analyzerMocks = vi.hoisted(() => ({
  analyzeScreenFocused: vi.fn(),
}));
vi.mock("../screen-monitor/vlm-analyzer", () => analyzerMocks);

const captionMocks = vi.hoisted(() => ({
  getTurnAttachedImages: vi.fn(() => [] as string[]),
  validateCaptionImagePath: vi.fn(),
}));
vi.mock("./image-caption", () => captionMocks);

import type { ToolDefinition } from "../orchestrator/tool-registry";
import { registerAttachedImageTool, setAttachedImageConfigGetter } from "./attached-image-tool";

const fakeConfig = { baseUrl: "https://example.com/v1", apiKey: "k", model: "test-vlm" };
const validImage = { ok: true, filePath: "C:/cache/pic.png", buffer: Buffer.from("x"), mime: "image/png" } as const;

function getTool(): ToolDefinition {
  registryMocks.register.mockClear();
  registerAttachedImageTool();
  return registryMocks.register.mock.calls.at(-1)![0] as ToolDefinition;
}

describe("ask_attached_image 工具", () => {
  beforeEach(() => {
    analyzerMocks.analyzeScreenFocused.mockReset();
    captionMocks.getTurnAttachedImages.mockReset().mockReturnValue([]);
    captionMocks.validateCaptionImagePath.mockReset();
    setAttachedImageConfigGetter(() => fakeConfig);
  });

  it("注册 focus 必填，描述与参数说明引导开放式问法（与屏幕 focus 旁路同款契约）", () => {
    const tool = getTool();
    expect(tool.id).toBe("ask_attached_image");
    expect(tool.inputSchema.required).toEqual(["focus"]);
    expect(tool.description).toContain("focus 指定想看清的内容");
    expect((tool.inputSchema.properties.focus as { description: string }).description).toContain("避免「是不是…」的是非问句");
  });

  it("缺 focus（或纯空白）返回错误串，不调 VLM", async () => {
    const tool = getTool();
    await expect(tool.execute({})).resolves.toBe("[错误] 缺少 focus 参数。");
    await expect(tool.execute({ focus: "   " })).resolves.toBe("[错误] 缺少 focus 参数。");
    expect(analyzerMocks.analyzeScreenFocused).not.toHaveBeenCalled();
  });

  it("当轮无登记图片返回错误串（direct 模式/无图轮次）", async () => {
    captionMocks.getTurnAttachedImages.mockReturnValue([]);
    const tool = getTool();
    await expect(tool.execute({ focus: "图纸内容是什么？" })).resolves.toBe("[错误] 用户当轮没有发送可追问的图片。");
    expect(analyzerMocks.analyzeScreenFocused).not.toHaveBeenCalled();
  });

  it("填 focus 照登记原图追问：focus trim 后传聚焦路径，名词用「图片」", async () => {
    captionMocks.getTurnAttachedImages.mockReturnValue(["C:/cache/pic.png"]);
    captionMocks.validateCaptionImagePath.mockReturnValue(validImage);
    analyzerMocks.analyzeScreenFocused.mockResolvedValue("图片是一幅粉色系的拼豆图纸。");
    const tool = getTool();
    const answer = await tool.execute({ focus: " 图纸内容是什么？ " });
    expect(answer).toBe("图片是一幅粉色系的拼豆图纸。");
    expect(captionMocks.validateCaptionImagePath).toHaveBeenCalledWith("C:/cache/pic.png");
    expect(analyzerMocks.analyzeScreenFocused).toHaveBeenCalledWith(
      { base64: Buffer.from("x").toString("base64"), mime: "image/png", width: 0, height: 0 },
      fakeConfig,
      "图纸内容是什么？",
      "图片",
    );
  });

  it("发多图时按 name 匹配文件名，不传 name 默认最后一张", async () => {
    captionMocks.getTurnAttachedImages.mockReturnValue(["C:/cache/a.png", "C:/cache/b.png"]);
    captionMocks.validateCaptionImagePath.mockImplementation((p: string) => ({ ok: true, filePath: p, buffer: Buffer.from("x"), mime: "image/png" }));
    analyzerMocks.analyzeScreenFocused.mockResolvedValue("ok");
    const tool = getTool();
    await tool.execute({ focus: "q", name: "a.png" });
    expect(captionMocks.validateCaptionImagePath).toHaveBeenCalledWith("C:/cache/a.png");
    await tool.execute({ focus: "q" });
    expect(captionMocks.validateCaptionImagePath).toHaveBeenLastCalledWith("C:/cache/b.png");
  });

  it("图片读取失败返回错误串不抛异常，不触达 VLM", async () => {
    captionMocks.getTurnAttachedImages.mockReturnValue(["C:/cache/pic.png"]);
    captionMocks.validateCaptionImagePath.mockReturnValue({ ok: false, error: "文件不存在" });
    const tool = getTool();
    await expect(tool.execute({ focus: "q" })).resolves.toBe("[错误] 图片读取失败：文件不存在");
    expect(analyzerMocks.analyzeScreenFocused).not.toHaveBeenCalled();
  });

  it("未配置视觉模型返回错误串", async () => {
    setAttachedImageConfigGetter(() => null);
    captionMocks.getTurnAttachedImages.mockReturnValue(["C:/cache/pic.png"]);
    captionMocks.validateCaptionImagePath.mockReturnValue(validImage);
    const tool = getTool();
    await expect(tool.execute({ focus: "q" })).resolves.toContain("[错误] 未配置视觉模型");
  });

  it("VLM 错误串原样透传给 LLM（analyzeScreenFocused 返回不抛，工具不吞错）", async () => {
    captionMocks.getTurnAttachedImages.mockReturnValue(["C:/cache/pic.png"]);
    captionMocks.validateCaptionImagePath.mockReturnValue(validImage);
    analyzerMocks.analyzeScreenFocused.mockResolvedValue("[错误·运行时] 视觉模型未返回有效内容");
    const tool = getTool();
    await expect(tool.execute({ focus: "q" })).resolves.toBe("[错误·运行时] 视觉模型未返回有效内容");
  });
});
