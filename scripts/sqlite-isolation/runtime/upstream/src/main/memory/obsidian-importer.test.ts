import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { beforeEach, describe, expect, it, vi } from "vitest"

const electronMock = vi.hoisted(() => ({
  userDataDir: "",
}))

vi.mock("electron", () => ({
  app: {
    getPath: () => electronMock.userDataDir,
  },
}))

// 回流向量重建依赖 RAG 接口；测试里 mock 掉避免初始化真实 embedding
const ragMock = vi.hoisted(() => ({
  addL2MemoryVector: vi.fn(async (_text: string, l2Id: string) => `rag_new_${l2Id}`),
  deleteUserMemoryVectors: vi.fn(() => 1),
}))

vi.mock("../rag/index", () => ({
  addL2MemoryVector: ragMock.addL2MemoryVector,
  deleteUserMemoryVectors: ragMock.deleteUserMemoryVectors,
}))

describe("parseL2Markdown", () => {
  beforeEach(() => {
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-import-"))
    vi.resetModules()
  })

  it("extracts id from frontmatter and content body (with 关联 section)", async () => {
    const { parseL2Markdown } = await import("./obsidian-importer")
    const md = [
      "---",
      "id: l2_abc_123",
      "type: 片段",
      "status: 活跃",
      "weight: 50",
      "tags: [记忆, 片段, active]",
      "---",
      "",
      "# 用户喜欢跑步",
      "",
      "用户喜欢跑步，每周三次",
      "",
      "## 关联",
      "",
      "- 提及实体：[[张三]]",
      "",
    ].join("\n")

    const { id, content } = parseL2Markdown(md)
    expect(id).toBe("l2_abc_123")
    expect(content).toBe("用户喜欢跑步，每周三次")
  })

  it("extracts content when there is no 关联 section (content to EOF)", async () => {
    const { parseL2Markdown } = await import("./obsidian-importer")
    const md = [
      "---",
      'id: "l2_quoted"',
      "type: 片段",
      "---",
      "",
      "# 标题",
      "",
      "第一行",
      "第二行",
    ].join("\n")

    const { id, content } = parseL2Markdown(md)
    // 引号包裹的 id 应被去掉引号
    expect(id).toBe("l2_quoted")
    expect(content).toBe("第一行\n第二行")
  })

  it("preserves in-content lines that look like (but aren't) 关联", async () => {
    const { parseL2Markdown } = await import("./obsidian-importer")
    const md = [
      "---",
      "id: l2_x",
      "---",
      "",
      "# t",
      "",
      "内容包含 ## 其他小节",
      "但不应被截断",
      "",
      "## 关联",
      "",
      "- 链接",
    ].join("\n")
    const { content } = parseL2Markdown(md)
    expect(content).toBe("内容包含 ## 其他小节\n但不应被截断")
  })

  it("returns null content when there is no frontmatter", async () => {
    const { parseL2Markdown } = await import("./obsidian-importer")
    const md = "# 标题\n\n没有 frontmatter"
    const { id, content } = parseL2Markdown(md)
    expect(id).toBeNull()
    expect(content).toBeNull()
  })

  it("returns null content when frontmatter has no id", async () => {
    const { parseL2Markdown } = await import("./obsidian-importer")
    const md = ["---", "type: 片段", "---", "", "# t", "", "正文"].join("\n")
    const { id, content } = parseL2Markdown(md)
    expect(id).toBeNull()
    expect(content).toBeNull()
  })
})

describe("importL2File / importL2Markdown (round-trip)", () => {
  let userDataDir: string
  let vaultDir: string

  beforeEach(async () => {
    // 等待上一测试触发的 fire-and-forget vault 自动同步（动态 import obsidian-exporter）完成，
    // 避免 resetModules 清缓存后该加载与新测试的模块加载交错，拿到半初始化的模块记录
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "obsidian-import-"))
    electronMock.userDataDir = userDataDir
    vaultDir = fs.mkdtempSync(path.join(os.tmpdir(), "vault-"))
    vi.resetModules()
    vi.clearAllMocks()
  })

  it("exports then re-imports an edited vault md, updating PMRS content", async () => {
    const { memoryStore } = await import("./memory-store")
    const { exportMemoryToObsidianVault } = await import("./obsidian-exporter")
    const { importL2File } = await import("./obsidian-importer")

    const l2 = await memoryStore.addL2Memory({
      content: "用户喜欢跑步",
      triggerText: "我喜欢跑步",
      sourceConversationId: "conv_1",
      ragId: "rag_1",
      isPinned: false,
    })

    await exportMemoryToObsidianVault(vaultDir)
    const mdPath = path.join(vaultDir, "记忆", `${l2.id}.md`)
    expect(fs.existsSync(mdPath)).toBe(true)

    // 用户在 Obsidian 里把正文改成了新内容（保留 frontmatter id + 标题结构）
    const editedMd = [
      "---",
      `id: ${l2.id}`,
      "type: 片段",
      "status: 活跃",
      "---",
      "",
      "# 用户喜欢跑步",
      "",
      "用户改成了每周游泳三次",
      "",
    ].join("\n")
    fs.writeFileSync(mdPath, editedMd, "utf8")

    const result = await importL2File(mdPath)
    expect(result.id).toBe(l2.id)
    expect(result.ok).toBe(true)
    expect(result.changed).toBe(true)

    const all = await memoryStore.getAllL2()
    const updated = all.find((m) => m.id === l2.id)!
    expect(updated.content).toBe("用户改成了每周游泳三次")
    // 回流后向量应按新正文重建、切换 ragId 并清理旧向量
    expect(ragMock.addL2MemoryVector).toHaveBeenCalledWith("用户改成了每周游泳三次", l2.id, expect.any(Object))
    expect(ragMock.deleteUserMemoryVectors).toHaveBeenCalledWith(["rag_1"])
    expect(updated.syncStatus).toBe("synced")
    expect(updated.ragId).toBe(`rag_new_${l2.id}`)
  })

  it("does not write when vault content is unchanged (changed=false)", async () => {
    const { memoryStore } = await import("./memory-store")
    const { exportMemoryToObsidianVault } = await import("./obsidian-exporter")
    const { importL2File } = await import("./obsidian-importer")

    const l2 = await memoryStore.addL2Memory({
      content: "原始内容",
      triggerText: "t",
      sourceConversationId: "c",
      isPinned: false,
    })
    await exportMemoryToObsidianVault(vaultDir)
    const mdPath = path.join(vaultDir, "记忆", `${l2.id}.md`)

    // 直接对未改动的文件调用回流
    const result = await importL2File(mdPath)
    expect(result.changed).toBe(false)
    expect(result.ok).toBe(true)

    const all = await memoryStore.getAllL2()
    expect(all.find((m) => m.id === l2.id)!.content).toBe("原始内容")
  })

  it("returns not-found for an unknown id", async () => {
    const { importL2Markdown } = await import("./obsidian-importer")
    const md = [
      "---",
      "id: l2_does_not_exist",
      "---",
      "",
      "# t",
      "",
      "正文",
      "",
    ].join("\n")
    const result = await importL2Markdown(md)
    expect(result.ok).toBe(false)
    expect(result.reason).toBe("not-found")
    expect(result.changed).toBe(false)
  })

  it("updateL2Content only touches content/keywords/syncStatus, not status/weight/createdAt/ragId", async () => {
    const { memoryStore } = await import("./memory-store")
    const l2 = await memoryStore.addL2Memory({
      content: "原始",
      triggerText: "t",
      sourceConversationId: "c",
      isPinned: false,
    })
    const before = (await memoryStore.getAllL2()).find((m) => m.id === l2.id)!
    // memoryStore 有内存缓存，getAllL2 返回同一对象引用；断言前先做快照防止就地修改污染
    const beforeKeywords = [...(before.keywords ?? [])]
    await memoryStore.updateL2Content(l2.id, "新内容")
    const after = (await memoryStore.getAllL2()).find((m) => m.id === l2.id)!

    expect(after.content).toBe("新内容")
    // 运行时字段应保持不变
    expect(after.status).toBe(before.status)
    expect(after.weight).toBe(before.weight)
    expect(after.createdAt).toBe(before.createdAt)
    expect(after.accessCount).toBe(before.accessCount)
    expect(after.ragId).toBe(before.ragId)
    // 正文变化时关键词重算并进入待同步状态（向量重建前不可召回）
    expect(after.syncStatus).toBe("pending_sync")
    expect(after.keywords).not.toEqual(beforeKeywords)
    expect(after.keywords).toEqual(expect.arrayContaining(["新", "内", "容"]))
  })

  it("marks sync_failed when vector rebuild fails, keeping content updated and old ragId", async () => {
    const { memoryStore } = await import("./memory-store")
    const { importL2Markdown } = await import("./obsidian-importer")

    const l2 = await memoryStore.addL2Memory({
      content: "旧内容",
      triggerText: "t",
      sourceConversationId: "c",
      ragId: "rag_old",
      isPinned: false,
    })
    ragMock.addL2MemoryVector.mockRejectedValueOnce(new Error("embedding failed"))

    const md = ["---", `id: ${l2.id}`, "---", "", "# t", "", "新内容", ""].join("\n")
    const result = await importL2Markdown(md)
    expect(result.changed).toBe(true)

    const after = (await memoryStore.getAllL2()).find((m) => m.id === l2.id)!
    expect(after.content).toBe("新内容")
    // 向量重建失败：sync_failed 屏蔽召回，ragId 保留旧值等待一致性检查重试
    expect(after.syncStatus).toBe("sync_failed")
    expect(after.ragId).toBe("rag_old")
    // 失败路径不应尝试删除向量
    expect(ragMock.deleteUserMemoryVectors).not.toHaveBeenCalled()
  })

  it("keeps new vector effective even if stale vector deletion fails", async () => {
    const { memoryStore } = await import("./memory-store")
    const { importL2Markdown } = await import("./obsidian-importer")

    const l2 = await memoryStore.addL2Memory({
      content: "旧内容",
      triggerText: "t",
      sourceConversationId: "c",
      ragId: "rag_old",
      isPinned: false,
    })
    ragMock.deleteUserMemoryVectors.mockImplementationOnce(() => {
      throw new Error("delete failed")
    })

    const md = ["---", `id: ${l2.id}`, "---", "", "# t", "", "新内容", ""].join("\n")
    const result = await importL2Markdown(md)
    expect(result.changed).toBe(true)

    // 删除旧向量失败不影响回流结果：新向量已生效、状态 synced
    const after = (await memoryStore.getAllL2()).find((m) => m.id === l2.id)!
    expect(after.syncStatus).toBe("synced")
    expect(after.ragId).toBe(`rag_new_${l2.id}`)
  })

  it("does not call rag during importing flag window (vector rebuild outside flag)", async () => {
    const { memoryStore } = await import("./memory-store")
    const { importL2Markdown } = await import("./obsidian-importer")
    const { isImportingMemory } = await import("./obsidian-sync-flag")

    const l2 = await memoryStore.addL2Memory({
      content: "旧内容",
      triggerText: "t",
      sourceConversationId: "c",
      ragId: "rag_old",
      isPinned: false,
    })
    // embedding 期间回流标志必须已复位，否则其他记忆写入会被跳过 vault 自动导出
    ragMock.addL2MemoryVector.mockImplementationOnce(async () => {
      expect(isImportingMemory()).toBe(false)
      return "rag_new_flag_check"
    })

    const md = ["---", `id: ${l2.id}`, "---", "", "# t", "", "新内容", ""].join("\n")
    await importL2Markdown(md)
    expect(ragMock.addL2MemoryVector).toHaveBeenCalledTimes(1)
  })
})
