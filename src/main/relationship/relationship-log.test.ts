import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { beforeEach, describe, expect, it } from "vitest"

describe("relationship log", () => {
  let filePath: string

  beforeEach(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "relationship-log-"))
    filePath = path.join(dir, "relationship-log.json")
  })

  it("records relationship cues without asking for confirmation", async () => {
    const { RelationshipLogStore } = await import("./relationship-log")
    const store = new RelationshipLogStore(filePath)

    await store.recordTurn({
      userText: "记忆确认卡片不要，太影响观感了！",
      assistantText: "明白，这个不做。",
      cyreneFeeling: "温柔",
      channel: "desktop",
    })

    const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      entries: Array<{ userMood: string; relationshipSignal: string; nextCareCue: string }>
      dailySummaries: Array<{ summary: string }>
    }

    expect(data.entries).toHaveLength(1)
    expect(data.entries[0].userMood).toBe("明确边界")
    expect(data.entries[0].relationshipSignal).toContain("低打扰")
    expect(data.entries[0].nextCareCue).toContain("不要弹确认")
    expect(data.dailySummaries[0].summary).toContain("明确边界")
  })

  it("builds a compact context from recent cues", async () => {
    const { RelationshipLogStore } = await import("./relationship-log")
    const store = new RelationshipLogStore(filePath)

    await store.recordTurn({
      userText: "我今天有点累，先别安排太多",
      assistantText: "那就慢一点来。",
      cyreneFeeling: "担心",
      channel: "desktop",
    })

    const context = await store.buildContext()

    expect(context).toContain("【近期关系线索】")
    expect(context).toContain("用户最近状态")
    expect(context).toContain("疲惫")
    expect(context).toContain("当前回应参考：少安排、少追问")
    expect(context).not.toContain("下次回应提示")
  })

  it("uses only the latest cue and normalizes legacy duplicated prefixes", async () => {
    const { RelationshipLogStore } = await import("./relationship-log")
    const store = new RelationshipLogStore(filePath)
    fs.writeFileSync(filePath, JSON.stringify({
      entries: [
        {
          id: "old", date: "2026-08-09", createdAt: 1, userMood: "焦虑",
          userText: "以前的话题", assistantText: "", cyreneFeeling: "", channel: "desktop",
          relationshipSignal: "old", nextCareCue: "下次回应提示：先安抚，再给一两个可执行小步，不要铺太大。",
        },
        {
          id: "latest", date: "2026-08-10", createdAt: 2, userMood: "未知",
          userText: "小摆件", assistantText: "", cyreneFeeling: "", channel: "desktop",
          relationshipSignal: "latest", nextCareCue: "下次回应提示：下次回应提示：延续最近话题「小摆件」，不要过度解读。",
        },
      ],
      dailySummaries: [{
        date: "2026-08-10", updatedAt: 2,
        summary: "2026-08-10：用户最近状态偏「平稳」。 下次回应提示：延续最近话题「小摆件」，不要过度解读。",
        nextCareCue: "下次回应提示：延续最近话题「小摆件」，不要过度解读。",
      }],
    }), "utf8")

    const context = await store.buildContext()

    expect(context).toContain("最近日记摘要：2026-08-10：用户最近状态偏「平稳」。")
    expect(context).toContain("当前回应参考：延续最近话题「小摆件」，不要过度解读。")
    expect(context).not.toContain("先安抚")
    expect(context).not.toContain("下次回应提示")
  })

  it("does not treat affectionate nervousness as problem-solving anxiety", async () => {
    const { RelationshipLogStore } = await import("./relationship-log")
    const store = new RelationshipLogStore(filePath)

    await store.recordTurn({
      userText: "每次说我喜欢你的时候还是会有点紧张，可能会先排练一下",
      assistantText: "我会好好听着。",
      cyreneFeeling: "温柔",
      channel: "desktop",
    })

    const data = JSON.parse(fs.readFileSync(filePath, "utf8")) as {
      entries: Array<{ userMood: string; nextCareCue: string }>
    }
    expect(data.entries[0].userMood).toBe("害羞")
    expect(data.entries[0].nextCareCue).toContain("不要把亲密表达当作需要解决的问题")
    expect(data.entries[0].nextCareCue).not.toContain("可执行小步")
  })

  it("keeps the latest known user mood when the newest turn is neutral", async () => {
    const { RelationshipLogStore } = await import("./relationship-log")
    const store = new RelationshipLogStore(filePath)

    await store.recordTurn({
      userText: "今天很开心",
      assistantText: "真好呀。",
      cyreneFeeling: "开心",
      channel: "desktop",
    })
    await store.recordTurn({
      userText: "接着聊刚才的小摆件吧",
      assistantText: "好呀。",
      cyreneFeeling: "温柔",
      channel: "desktop",
    })

    const context = await store.buildContext()
    expect(context).toContain("用户最近状态：开心")
    expect(context).toContain("当前回应参考：延续最近话题「接着聊刚才的小摆件吧」")
  })
})
