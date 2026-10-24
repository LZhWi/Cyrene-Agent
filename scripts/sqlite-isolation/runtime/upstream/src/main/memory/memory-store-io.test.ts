import * as fs from "fs"
import * as os from "os"
import * as path from "path"
import { beforeEach, describe, expect, it, vi } from "vitest"
import type { MemoryStore } from "./memory-types"
import {
  backupMemoryFile,
  readMemoryFile,
  resolveMemoryPath,
  writeMemoryFile,
} from "./memory-store-io"

const electronMock = vi.hoisted(() => ({
  userDataDir: "",
}))

vi.mock("electron", () => ({
  app: {
    getPath: () => electronMock.userDataDir,
  },
}))

function buildStore(): MemoryStore {
  return {
    schemaVersion: 2,
    l0: {
      nickname: "",
      preferredName: "伙伴",
      occupation: "",
      longTermInterests: "",
      language: "zh-CN",
      permanentNote: "",
      isPinned: false,
      updatedAt: 0,
    },
    l1: {
      recentGoals: "",
      recentPreferences: "",
      currentProject: "",
      generatedAt: 0,
      roundCount: 7,
    },
    l2: [{
      id: "l2_legacy",
      content: "旧记忆",
      triggerText: "旧触发",
      sourceConversationId: "test",
      createdAt: 1,
      lastAccessedAt: 1,
      accessCount: 0,
      weight: 0,
      isPinned: false,
      status: "active",
      ragId: "rag_legacy",
    }],
    evidence: [],
    reflectionLogs: [],
    conflictLogs: [],
    version: 1,
  }
}

describe("memory-store-io", () => {
  beforeEach(() => {
    electronMock.userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-store-io-"))
  })

  it("resolves the memory path from Electron userData", () => {
    expect(resolveMemoryPath()).toBe(path.join(electronMock.userDataDir, "memory.json"))
  })

  it("writes and reads back a store roundtrip", () => {
    const filePath = path.join(electronMock.userDataDir, "memory.json")
    const store = buildStore()

    writeMemoryFile(filePath, store)

    expect(fs.existsSync(filePath)).toBe(true)
    expect(readMemoryFile(filePath)).toEqual(store)
  })

  it("creates missing directories when writing", () => {
    const filePath = path.join(electronMock.userDataDir, "nested", "dir", "memory.json")

    writeMemoryFile(filePath, buildStore())

    expect(fs.existsSync(filePath)).toBe(true)
    expect(readMemoryFile(filePath).l1?.roundCount).toBe(7)
  })

  it("creates exactly one timestamped backup of an existing file", () => {
    const filePath = path.join(electronMock.userDataDir, "memory.json")
    writeMemoryFile(filePath, buildStore())

    backupMemoryFile(filePath)

    const backups = fs.readdirSync(electronMock.userDataDir).filter((name) => name.startsWith("memory.backup.") && name.endsWith(".json"))
    expect(backups).toHaveLength(1)
    expect(readMemoryFile(path.join(electronMock.userDataDir, backups[0]))).toEqual(buildStore())
  })

  it("is a no-op when backing up a missing file", () => {
    const filePath = path.join(electronMock.userDataDir, "memory.json")

    expect(() => backupMemoryFile(filePath)).not.toThrow()
    expect(fs.readdirSync(electronMock.userDataDir)).toHaveLength(0)
  })
})
