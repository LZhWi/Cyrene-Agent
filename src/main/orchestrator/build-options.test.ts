import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { describe, expect, it, vi } from "vitest"
import {
  buildAgentRunOptions,
  buildChannelSystem,
  onAgentRunFinished,
  type BuildOptionsDeps,
  type OnRunFinishedDeps,
} from "./build-options"

function createBuildDeps(): BuildOptionsDeps {
  return {
    loadModelSettings: () => ({ provider: "test", baseUrl: "https://example.test", model: "m", apiKey: "k" }),
    loadUserProfile: () => ({}),
    buildEnvironmentContext: () => "ENV",
    buildSkillCatalog: () => "",
    skillRegistry: { getEnabled: () => [] },
    resolveSlashActivation: () => "",
    buildToneInjection: async () => "",
    sceneEmbeddingIndex: null,
    getSceneEmbeddingProvider: () => null,
    buildAlwaysOnContext: async () => "ALWAYS",
    buildRelationshipContext: async () => "RELATIONSHIP",
    buildSystemPrompt: () => "BASE_SYSTEM",
    logWorldbookInjection: () => {},
    normalizeChatMessages: (raw) => raw as never,
    chatRequestTimeoutMs: 1000,
  }
}

describe("build-options", () => {
  it("adds a concise WeChat system when the run comes from WeChat", async () => {
    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "你好" }],
      style: "01_default.md",
      channel: "wechat",
    }, createBuildDeps())

    const system = result.options.messages[0].content
    expect(system).toContain("你正在通过微信回复用户")
    expect(system).toContain("BASE_SYSTEM")
    expect(system).toContain("RELATIONSHIP")
  })

  it("does not add channel system for desktop chat", async () => {
    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "你好" }],
      style: "01_default.md",
    }, createBuildDeps())

    const system = result.options.messages[0].content
    expect(system).not.toContain("你正在通过微信回复用户")
    expect(system).not.toContain("你正在通过飞书回复用户")
  })

  it("attaches direct image content blocks to the latest user message", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-image-direct-"))
    const imagePath = path.join(dir, "图 像.png")
    fs.writeFileSync(imagePath, Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
      0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    ]))

    const result = await buildAgentRunOptions({
      messages: [
        { role: "user", content: "上一轮" },
        { role: "assistant", content: "好的" },
        { role: "user", content: "请看这张图" },
      ],
      style: "01_default.md",
      imageAttachments: [{ name: "图 像.png", filePath: imagePath, mime: "image/png" }],
    }, createBuildDeps())

    const latestUser = result.options.messages.at(-1)
    expect(latestUser?.content).toEqual([
      { type: "text", text: "请看这张图" },
      {
        type: "image_url",
        image_url: { url: expect.stringMatching(/^data:image\/png;base64,/) },
      },
    ])
    expect(result.options.messages[1].content).toBe("上一轮")
  })

  it("builds caption fallback messages for direct image send failures", async () => {
    const deps = createBuildDeps()
    deps.captionImageForFallback = async () => ({ ok: true, caption: "画面里有一张安装截图" })

    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "这图哪里不对？" }],
      style: "01_default.md",
      imageAttachments: [{ name: "setup.png", filePath: "C:\\tmp\\setup.png", mime: "image/png" }],
    }, deps)

    const fallbackMessages = await result.options.imageCaptionFallback?.()
    const userMessage = fallbackMessages?.at(-1)
    expect(userMessage?.content).toContain("这图哪里不对？")
    expect(userMessage?.content).toContain("setup.png：画面里有一张安装截图")
    expect(userMessage?.content).not.toContain("image_url")
  })

  it("has distinct system text for Feishu work chat", () => {
    expect(buildChannelSystem("feishu")).toContain("你正在通过飞书回复用户")
    expect(buildChannelSystem("feishu")).toContain("工作上下文")
  })

  it("records relationship turn after agent run finishes", async () => {
    const recordRelationshipTurn = vi.fn(async () => {})
    const deps: OnRunFinishedDeps = {
      loadModelSettings: () => ({ provider: "test", baseUrl: "", model: "", apiKey: "", runtimeSync: "off" }),
      scheduleMemoryWrite: () => {},
      inferRuntimeState: () => ({ status: "陪伴中" }),
      runtimeState: { status: "陪伴中", feeling: "温柔", expression: 0, updatedAt: 0 },
      feelingToExpression: { "温柔": 0 },
      setRuntimeState: () => {},
      stickerEmbeddingIndex: null,
      getEmbeddingProvider: () => null,
      matchSticker: async () => null,
      loadStickerSettings: () => ({}),
      broadcastRuntimeStateChanged: () => {},
      observeRuntimeState: async () => {},
      recordRelationshipTurn,
      getChatWindow: () => null,
    }

    await onAgentRunFinished({ reply: "好呀", toolResults: [] }, "今天有点累", deps, "wechat")

    expect(recordRelationshipTurn).toHaveBeenCalledWith({
      userText: "今天有点累",
      assistantText: "好呀",
      cyreneFeeling: "温柔",
      channel: "wechat",
    })
  })

  it("uses the latest sticker embedding index when agent run finishes", async () => {
    const matchSticker = vi.fn(async () => ({ id: "hugtight" }))
    const send = vi.fn()
    const latestIndex = [{ id: "hugtight", embedding: [1, 0] }]
    const deps: OnRunFinishedDeps & { getStickerEmbeddingIndex: () => unknown } = {
      loadModelSettings: () => ({
        provider: "test",
        baseUrl: "",
        model: "",
        apiKey: "",
        runtimeSync: "off",
        stickerEnabled: true,
        stickerSimilarityThreshold: 0.55,
      }),
      scheduleMemoryWrite: () => {},
      inferRuntimeState: () => ({ status: "陪伴中" }),
      runtimeState: { status: "陪伴中", feeling: "温柔", expression: 0, updatedAt: 0 },
      feelingToExpression: { "温柔": 0 },
      setRuntimeState: () => {},
      stickerEmbeddingIndex: null,
      getStickerEmbeddingIndex: () => latestIndex,
      getEmbeddingProvider: () => ({ embed: async () => [1, 0] }),
      matchSticker,
      loadStickerSettings: () => ({}),
      broadcastRuntimeStateChanged: () => {},
      observeRuntimeState: async () => {},
      recordRelationshipTurn: async () => {},
      getChatWindow: () => ({
        isDestroyed: () => false,
        webContents: {
          isDestroyed: () => false,
          send,
        },
      }),
    }

    await onAgentRunFinished({ reply: "来，抱抱你", toolResults: [] }, "今天好累", deps)

    expect(matchSticker).toHaveBeenCalledWith(
      "来，抱抱你\n今天好累",
      expect.anything(),
      latestIndex,
      0.55,
    )
    expect(send).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({
      name: "cyrene.sticker",
      value: "hugtight",
    }))
  })
})
