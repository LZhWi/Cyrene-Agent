import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { describe, expect, it, vi } from "vitest"
import {
  buildAgentRunOptions,
  buildChannelSystem,
  onAgentRunFinished,
  suppressOverlappingMemoryEntries,
  type BuildOptionsDeps,
  type OnRunFinishedDeps,
} from "./build-options"
import type { SocialAtom } from "../social-context"

function createBuildDeps(): BuildOptionsDeps {
  return {
    loadModelSettings: () => ({ provider: "test", baseUrl: "https://example.test", model: "m", apiKey: "k" }),
    loadUserProfile: () => ({}),
    buildEnvironmentContext: () => "ENV",
    buildSkillCatalog: () => "",
    buildAutoInjectedSkillContext: () => "",
    skillRegistry: { getEnabled: () => [] },
    resolveSlashActivation: () => "",
    buildToneInjection: async () => "",
    sceneEmbeddingIndex: null,
    getSceneEmbeddingProvider: () => null,
    buildAlwaysOnContext: async () => "ALWAYS",
    buildMemoryInjection: async () => "MEMORY",
    buildRelationshipContext: async () => "RELATIONSHIP",
    buildSystemPrompt: () => "BASE_SYSTEM",
    buildToolSystemPrompt: () => "TOOL_SYSTEM",
    buildSoulSystemBasePrompt: () => "SOUL_SYSTEM_BASE",
    toolRegistry: { getEnabled: () => [] },
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

    expect(result.options.soulSystemBaseContent).toContain("你正在通过微信回复用户")
    expect(result.options.soulSystemBaseContent).toContain("SOUL_SYSTEM_BASE")
    expect(result.options.soulSystemBaseContent).toContain("RELATIONSHIP")
    expect(result.options.toolSystemContent).toContain("TOOL_SYSTEM")
    expect(result.options.toolSystemContent).toContain("ENV")
  })

  it("does not add channel system for desktop chat", async () => {
    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "你好" }],
      style: "01_default.md",
    }, createBuildDeps())

    expect(result.options.soulSystemBaseContent).not.toContain("你正在通过微信回复用户")
    expect(result.options.soulSystemBaseContent).not.toContain("你正在通过飞书回复用户")
  })

  it.each(["talk-soft.md", "01_default.md"])("injects session social context in desktop Chat/Collab (%s)", async (style) => {
    const deps = createBuildDeps()
    deps.isSocialContextEnabled = () => true
    deps.retrieveSocialContext = async () => [{
      id: "atom-1", conversationId: "session-1", type: "short_term", content: "用户明天要去复诊",
      evidenceTurnId: "old-user", evidenceQuote: "明天去复诊", createdAt: 1, updatedAt: 1,
      expiresAt: Date.now() + 1000, status: "active",
    }]
    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "接着聊吧" }], style, sessionId: "session-1",
      userTurnId: "user-2", assistantTurnId: "assistant-2",
    }, deps)

    expect(result.options.soulSystemBaseContent).toContain("【本轮可用的对话背景】")
    expect(result.options.soulSystemBaseContent).toContain("用户明天要去复诊")
    expect(result.options.socialContext?.conversationId).toBe("session-1")
  })

  it("keeps social context out of external channel runs", async () => {
    const deps = createBuildDeps()
    deps.isSocialContextEnabled = () => true
    deps.retrieveSocialContext = vi.fn(async () => [])
    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "继续" }], style: "talk-soft.md", sessionId: "session-1",
      userTurnId: "user-2", assistantTurnId: "assistant-2", channel: "wechat",
    }, deps)

    expect(deps.retrieveSocialContext).not.toHaveBeenCalled()
    expect(result.options.socialContext).toBeUndefined()
  })

  it("messages 不含 system，FC 循环按阶段动态注入", async () => {
    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "你好" }],
      style: "01_default.md",
    }, createBuildDeps())

    // 第一期：原始 messages 不含 system 消息
    expect(result.options.messages.some((m) => m.role === "system")).toBe(false)
  })

  it("adds message timestamps and one gap notice to AG-UI chat context", async () => {
    const deps = createBuildDeps()
    deps.loadUserProfile = () => ({ timezone: "Asia/Taipei" })

    const result = await buildAgentRunOptions({
      messages: [
        { role: "user", content: "今天有点累", at: Date.UTC(2026, 6, 12, 12, 0) },
        { role: "assistant", content: "早点休息", at: Date.UTC(2026, 6, 12, 12, 2) },
        { role: "user", content: "我回来啦", at: Date.UTC(2026, 6, 13, 3, 0) },
      ],
      style: "01_default.md",
    }, deps)

    expect(result.options.messages[0].content).toBe("[2026-07-12 20:00, Asia/Taipei]\n今天有点累")
    expect(result.options.messages[2].content).toBe("[2026-07-13 11:00, Asia/Taipei]\n我回来啦")
    expect(result.options.soulSystemBaseContent).toContain("[对话时间信息]")
    expect(result.options.soulSystemBaseContent).toContain("距离上一条有效聊天消息：约 14 小时 58 分钟")
    expect(result.options.soulSystemBaseContent.match(/距离上一条有效聊天消息/g)).toHaveLength(1)
    expect(result.options.toolSystemContent).not.toContain("[对话时间信息]")
  })

  it("keeps Phone summaries in the 16-item window for filtering, but renders them as a system-prompt block instead of history messages", async () => {
    const deps = createBuildDeps()
    deps.getCallContextEvents = () => [{
      id: "call-1",
      startedAt: 1_500,
      endedAt: 1_700,
      summary: "用户在通话里提到明天要考试。",
    }]
    const history = Array.from({ length: 15 }, (_, index) => ({
      role: index % 2 === 0 ? "user" as const : "assistant" as const,
      content: `history-${index}`,
      at: index * 100,
    }))
    const result = await buildAgentRunOptions({
      messages: [...history, { role: "user", content: "接着聊", at: 2_000 }],
      style: "01_default.md",
    }, deps)

    // 16 chat + 1 call = 17 项排序后 slice 16，淘汰 history-0；窗口内 15 chat + 1 call。
    // call 不进 messages 数组（避免 Anthropic 合并 system 消息），messages 只含 15 条 chat。
    expect(result.options.messages).toHaveLength(15)
    expect(result.options.messages.some((message) => String(message.content).includes("明天要考试"))).toBe(false)
    // 通话梗概改为 system prompt 里的只读数据块
    expect(result.options.soulSystemBaseContent).toContain("【近期通话事件｜只读事实数据】")
    expect(result.options.soulSystemBaseContent).toContain("明天要考试")
    // MemoryJudge 仍拿到通话梗概（buildCallMemoryContext 未改）
    expect(result.memoryContextText).toContain("明天要考试")
  })

  it("keeps Phone summaries out of unrelated external-channel conversations", async () => {
    const deps = createBuildDeps()
    deps.getCallContextEvents = () => [{
      id: "call-1", startedAt: 1_000, endedAt: 1_100, summary: "本地通话私有摘要",
    }]
    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "微信消息", at: 2_000 }],
      style: "01_default.md",
      channel: "wechat",
      sessionId: "channel:wechat:user",
    }, deps)

    expect(result.options.messages.some((message) => String(message.content).includes("本地通话私有摘要"))).toBe(false)
    expect(result.memoryContextText).toBeUndefined()
  })

  it("toolSystemContent / soulSystemBaseContent 是分开的两套字符串", async () => {
    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "你好" }],
      style: "01_default.md",
    }, createBuildDeps())

    expect(result.options.toolSystemContent).toContain("TOOL_SYSTEM")
    expect(result.options.toolSystemContent).toContain("ENV")
    expect(result.options.soulSystemBaseContent).not.toBe("TOOL_SYSTEM")
    expect(result.options.soulSystemBaseContent).toContain("SOUL_SYSTEM_BASE")
  })

  it("soul 阶段在 environmentContext 后追加工具不可调纠正，工具阶段不受影响", async () => {
    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "你好" }],
      style: "01_default.md",
    }, createBuildDeps())

    // soul 侧：纠正句紧跟 environmentContext 之后
    expect(result.options.soulSystemBaseContent).toContain("当前回复阶段工具调用环节已经结束")
    expect(result.options.soulSystemBaseContent.indexOf("ENV"))
      .toBeLessThan(result.options.soulSystemBaseContent.indexOf("当前回复阶段工具调用环节已经结束"))
    // 工具侧：绝不能注入（否则会阻止 TOOL_PHASE 正常调工具）
    expect(result.options.toolSystemContent).not.toContain("当前回复阶段工具调用环节已经结束")
  })

  it("environmentContext 构建失败（空）时，soul 阶段不注入孤立的纠正句", async () => {
    const deps = createBuildDeps()
    deps.buildEnvironmentContext = () => ""

    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "你好" }],
      style: "01_default.md",
    }, deps)

    // 纠正句的存在与 environmentContext 绑定：没有工具清单就没有“谎言”，不需要纠正
    expect(result.options.soulSystemBaseContent).not.toContain("当前回复阶段工具调用环节已经结束")
  })

  it("尾部动态区携带当前时钟：无 tone-anchor 时也存在，有时则时钟在前锚点在后", async () => {
    // 无 loadToneAnchor：soulTailAnchorContent 仍应携带时钟（时钟已从 system 前缀头部移出，不能丢）
    const bare = await buildAgentRunOptions({
      messages: [{ role: "user", content: "你好" }],
      style: "01_default.md",
    }, createBuildDeps())
    expect(bare.options.soulTailAnchorContent).toContain("[当前时间]")

    // 有 tone-anchor：时钟在前，硬规则锚点更靠近生成点
    const deps = createBuildDeps()
    deps.loadToneAnchor = () => "ANCHOR_RULES"
    const withAnchor = await buildAgentRunOptions({
      messages: [{ role: "user", content: "你好" }],
      style: "01_default.md",
    }, deps)
    const tail = withAnchor.options.soulTailAnchorContent ?? ""
    expect(tail).toContain("ANCHOR_RULES")
    expect(tail.indexOf("[当前时间]")).toBeLessThan(tail.indexOf("ANCHOR_RULES"))
  })

  it("system 前缀不再含分钟级时钟（prompt 缓存前缀稳定性）", async () => {
    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "你好" }],
      style: "01_default.md",
    }, createBuildDeps())
    // 时钟只允许出现在尾部动态区，两套 system 前缀都不应有 [当前时间] 段
    expect(result.options.soulSystemBaseContent).not.toContain("[当前时间]")
    expect(result.options.toolSystemContent).not.toContain("[当前时间]")
  })

  it("keeps enabled music and weather tools available in Talk mode and hides unrelated tools", async () => {
    const deps = createBuildDeps()
    deps.toolRegistry.getEnabled = () => [
      { id: "music_search" },
      { id: "music_play_track" },
      { id: "weather" },
      { id: "web_search" },
    ]
    deps.buildToolSystemPrompt = vi.fn((tools: ReadonlyArray<unknown>) =>
      `TOOLS:${tools.map((tool) => (tool as { id: string }).id).join(",")}`,
    )

    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "放个左转灯怎么样？" }],
      style: "talk",
    }, deps)

    expect(result.options.tools?.map((tool) => tool.id)).toEqual([
      "music_search",
      "music_play_track",
      "weather",
    ])
    expect(result.options.toolSystemContent).toContain("TOOLS:music_search,music_play_track,weather")
    expect(result.options.toolSystemContent).not.toContain("web_search")
  })

  it("requires music_search for an explicit NetEase Cloud search request", async () => {
    const deps = createBuildDeps()
    deps.toolRegistry.getEnabled = () => [{ id: "music_search" }]

    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "网易云上搜一下左转灯" }],
      style: "talk",
    }, deps)

    expect(result.options.requiredToolName).toBe("music_search")
  })

  it("requires daily recommendations only for an explicit daily request", async () => {
    const deps = createBuildDeps()
    deps.toolRegistry.getEnabled = () => [
      { id: "music_get_daily_recommendations" },
      { id: "music_search" },
    ]

    const daily = await buildAgentRunOptions({
      messages: [{ role: "user", content: "看看网易云今日推荐" }],
      style: "talk",
    }, deps)
    const generic = await buildAgentRunOptions({
      messages: [{ role: "user", content: "有点无聊，想听歌" }],
      style: "talk",
    }, deps)

    expect(daily.options.requiredToolName).toBe("music_get_daily_recommendations")
    expect(generic.options.requiredToolName).toBeUndefined()
  })

  it("injects deterministic recent-music selection context for the current conversation", async () => {
    const deps = createBuildDeps()
    deps.buildMusicCompanionContext = vi.fn(() => "[真实候选解析] 第二首 = trackId 102")

    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "第二首" }],
      style: "01_default.md",
      sessionId: "conversation-1",
    }, deps)

    expect(deps.buildMusicCompanionContext).toHaveBeenCalledWith("conversation-1", "第二首")
    expect(result.options.conversationId).toBe("conversation-1")
    expect(result.options.toolSystemContent).toContain("trackId 102")
    expect(result.options.soulSystemBaseContent).toContain("trackId 102")
  })

  it("puts the enabled Skill catalog into the tool phase so invoke_skill can route", async () => {
    const deps = createBuildDeps()
    deps.buildSkillCatalog = () => "SKILL_CATALOG"

    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "好无聊" }],
      style: "01_default.md",
    }, deps)

    expect(result.options.toolSystemContent).toContain("SKILL_CATALOG")
  })

  it("puts auto-injected Skill rules into both tool and Soul phases", async () => {
    const deps = createBuildDeps()
    deps.buildAutoInjectedSkillContext = () => "AUTO_MUSIC_RULES"

    const result = await buildAgentRunOptions({
      messages: [{ role: "user", content: "今日推荐呢" }],
      style: "01_default.md",
    }, deps)

    expect(result.options.toolSystemContent).toContain("AUTO_MUSIC_RULES")
    expect(result.options.soulSystemBaseContent).toContain("AUTO_MUSIC_RULES")
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
    // 第一期：原始 messages 不含 system，所以 messages[0] 就是首条用户消息
    expect(result.options.messages[0].content).toBe("上一轮")
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

  it("does not send document model context into memory or sticker embedding side effects", async () => {
    const scheduleMemoryWrite = vi.fn()
    const matchSticker = vi.fn(async () => null)
    const latestIndex = [{ id: "thinking", embedding: [1, 0] }]
    const hugeDoc = "超长文档内容".repeat(1000)
    const latestUserText = [
      "帮我总结这个 md",
      "【本轮文件】\n📝 notes.md（附件，内容已注入本轮上下文）",
      `【文档内容】\n文档 notes.md 内容：\n${hugeDoc}`,
    ].join("\n\n")
    const deps: OnRunFinishedDeps = {
      loadModelSettings: () => ({
        provider: "test",
        baseUrl: "",
        model: "",
        apiKey: "",
        runtimeSync: "off",
        stickerEnabled: true,
        stickerSimilarityThreshold: 0.55,
      }),
      scheduleMemoryWrite,
      inferRuntimeState: () => ({ status: "陪伴中" }),
      runtimeState: { status: "陪伴中", feeling: "温柔", expression: 0, updatedAt: 0 },
      feelingToExpression: { "温柔": 0 },
      setRuntimeState: () => {},
      stickerEmbeddingIndex: latestIndex,
      getEmbeddingProvider: () => ({ embed: async () => [1, 0] }),
      matchSticker,
      loadStickerSettings: () => ({}),
      broadcastRuntimeStateChanged: () => {},
      observeRuntimeState: async () => {},
      recordRelationshipTurn: async () => {},
      getChatWindow: () => null,
    }

    await onAgentRunFinished(
      { reply: "总结好了", toolResults: [] },
      latestUserText,
      deps,
      undefined,
      "[此前语音通话梗概，仅作为记忆判定的事实来源]\n- 用户明天要考试",
    )

    expect(scheduleMemoryWrite).toHaveBeenCalledWith(
      "帮我总结这个 md\n\n[此前语音通话梗概，仅作为记忆判定的事实来源]\n- 用户明天要考试",
      "总结好了",
    )
    expect(matchSticker).toHaveBeenCalledWith(
      "总结好了\n帮我总结这个 md",
      expect.anything(),
      latestIndex,
      0.55,
    )
  })
})

describe("suppressOverlappingMemoryEntries", () => {
  function makeAtom(type: "short_term" | "open_loop", content: string): SocialAtom {
    return {
      id: `atom-${Math.random()}`,
      conversationId: "conv",
      type,
      content,
      evidenceTurnId: "turn-1",
      evidenceQuote: content,
      createdAt: 1_000,
      updatedAt: 1_000,
      expiresAt: 2_000,
      status: "active",
    }
  }

  it("removes user_memory entries that overlap with short_term social atoms", () => {
    const memoryInjection = [
      "【相关记忆】",
      "· 用户明天要考试",
      "· 用户喜欢跑步",
      "· 用户在学法语（较久远的印象）",
      "（标注「较久远的印象」的条目可能已过时，提及时用不确定的语气，不要断言。）",
    ].join("\n")
    const atoms = [makeAtom("short_term", "明天考试，需要复习")]

    const result = suppressOverlappingMemoryEntries(memoryInjection, atoms)

    expect(result).toContain("用户喜欢跑步")
    expect(result).toContain("用户在学法语")
    expect(result).not.toContain("用户明天要考试")
    // notes 行保留（仍有未抑制的条目）
    expect(result).toContain("较久远的印象")
  })

  it("removes the entire 【相关记忆】 block when all entries are suppressed", () => {
    const memoryInjection = [
      "【相关记忆】",
      "· 用户明天要考试",
    ].join("\n")
    const atoms = [makeAtom("short_term", "明天考试")]

    const result = suppressOverlappingMemoryEntries(memoryInjection, atoms)

    expect(result).not.toContain("【相关记忆】")
    expect(result).not.toContain("考试")
  })

  it("leaves 【相关文档】 and 【人物关系】 blocks untouched", () => {
    const memoryInjection = [
      "【相关记忆】",
      "· 用户明天要考试",
      "",
      "【相关文档】",
      "· 文档内容提到考试安排",
      "",
      "【人物关系】",
      "· 小明是同学",
    ].join("\n")
    const atoms = [makeAtom("short_term", "明天考试")]

    const result = suppressOverlappingMemoryEntries(memoryInjection, atoms)

    // 【相关记忆】整块移除（唯一条目被抑制）
    expect(result).not.toContain("【相关记忆】")
    // 但【相关文档】/【人物关系】里即使有"考试"字样也不动
    expect(result).toContain("【相关文档】")
    expect(result).toContain("文档内容提到考试安排")
    expect(result).toContain("【人物关系】")
    expect(result).toContain("小明是同学")
  })

  it("does not suppress based on open_loop atoms", () => {
    const memoryInjection = [
      "【相关记忆】",
      "· 用户喜欢跑步",
    ].join("\n")
    const atoms = [makeAtom("open_loop", "用户喜欢跑步")]

    const result = suppressOverlappingMemoryEntries(memoryInjection, atoms)

    expect(result).toContain("用户喜欢跑步")
  })

  it("passes through unchanged when there are no short_term atoms", () => {
    const memoryInjection = "【相关记忆】\n· 用户喜欢跑步"
    const result = suppressOverlappingMemoryEntries(memoryInjection, [])
    expect(result).toBe(memoryInjection)
  })
})
