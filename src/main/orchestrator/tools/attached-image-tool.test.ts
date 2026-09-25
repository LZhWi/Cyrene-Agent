import { describe, expect, it, vi } from "vitest";
import { createAttachedImageTool } from "./attached-image-tool";

const config = { baseUrl: "https://vision.invalid/v1", apiKey: "key", model: "vision" };

function fixture() {
  const analyze = vi.fn(async () => "看起来是蓝色蝴蝶结");
  const validateImage = vi.fn((filePath: unknown) => ({
    ok: true as const,
    filePath: String(filePath),
    buffer: Buffer.from("image"),
    mime: "image/png",
  }));
  const tool = createAttachedImageTool({
    analyze,
    validateImage,
    loadVisionConfig: () => config,
  });
  return { tool, analyze, validateImage };
}

describe("ask_attached_image", () => {
  it("is a Chat built-in read-only tool", () => {
    const { tool } = fixture();
    expect(tool).toMatchObject({ id: "ask_attached_image", modes: ["chat"], chatBuiltin: true, effectKind: "read", needsContext: true });
  });

  it("analyzes the last image from the current turn by default", async () => {
    const { tool, analyze, validateImage } = fixture();
    const result = await tool.execute({ focus: "蝴蝶结是什么颜色？" }, {
      userQuery: "再看看细节",
      imageAttachments: [
        { name: "first.png", filePath: "C:/images/first.png" },
        { name: "second.png", filePath: "C:/images/second.png" },
      ],
    });
    expect(result).toBe("看起来是蓝色蝴蝶结");
    expect(validateImage).toHaveBeenCalledWith("C:/images/second.png");
    expect(analyze).toHaveBeenCalledWith(
      { base64: Buffer.from("image").toString("base64"), mime: "image/png" },
      "蝴蝶结是什么颜色？",
      config,
      undefined,
    );
  });

  it("selects only a named image from the frozen current-turn list", async () => {
    const { tool, validateImage } = fixture();
    await tool.execute({ focus: "文字是什么？", name: "FIRST" }, {
      userQuery: "看第一张",
      imageAttachments: [
        { name: "first.png", filePath: "C:/images/first.png" },
        { name: "second.png", filePath: "C:/images/second.png" },
      ],
    });
    expect(validateImage).toHaveBeenCalledWith("C:/images/first.png");
  });

  it("uses the vision backend frozen for the current model profile", async () => {
    const boundConfig = { baseUrl: "https://bound.invalid/v1", apiKey: "bound", model: "bound-vision" };
    const analyze = vi.fn(async () => "当前档案视觉结果");
    const loadVisionConfig = vi.fn(() => config);
    const tool = createAttachedImageTool({
      analyze,
      loadVisionConfig,
      validateImage: () => ({ ok: true, filePath: "C:/images/one.png", buffer: Buffer.from("x"), mime: "image/png" }),
    });

    await tool.execute({ focus: "看细节" }, {
      userQuery: "看图",
      imageAttachments: [{ name: "one.png", filePath: "C:/images/one.png" }],
      visionConfig: boundConfig,
    });

    expect(loadVisionConfig).not.toHaveBeenCalled();
    expect(analyze).toHaveBeenCalledWith(expect.anything(), "看细节", boundConfig, undefined);
  });

  it("rejects missing focus, absent images, unknown names, invalid files, and missing vision config", async () => {
    const { tool } = fixture();
    await expect(tool.execute({}, { userQuery: "" })).resolves.toContain("缺少 focus");
    await expect(tool.execute({ focus: "细节" }, { userQuery: "" })).resolves.toContain("本轮没有发送");
    await expect(tool.execute({ focus: "细节", name: "missing" }, {
      userQuery: "",
      imageAttachments: [{ name: "one.png", filePath: "C:/images/one.png" }],
    })).resolves.toContain("没有找到指定");

    const invalid = createAttachedImageTool({
      analyze: vi.fn(),
      validateImage: () => ({ ok: false, error: "文件不存在" }),
      loadVisionConfig: () => config,
    });
    await expect(invalid.execute({ focus: "细节" }, {
      userQuery: "",
      imageAttachments: [{ name: "one.png", filePath: "C:/images/one.png" }],
    })).resolves.toContain("文件不存在");

    const noVision = createAttachedImageTool({
      analyze: vi.fn(),
      validateImage: () => ({ ok: true, filePath: "C:/images/one.png", buffer: Buffer.from("x"), mime: "image/png" }),
      loadVisionConfig: () => null,
    });
    await expect(noVision.execute({ focus: "细节" }, {
      userQuery: "",
      imageAttachments: [{ name: "one.png", filePath: "C:/images/one.png" }],
    })).resolves.toContain("未启用视觉能力");
  });
});
