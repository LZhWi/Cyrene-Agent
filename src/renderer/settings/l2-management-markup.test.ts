import fs from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const settingsSource = fs.readFileSync(fileURLToPath(new URL("./settings.ts", import.meta.url)), "utf8")
const settingsCss = fs.readFileSync(fileURLToPath(new URL("./settings.css", import.meta.url)), "utf8")
const ipcSource = fs.readFileSync(fileURLToPath(new URL("../../shared/ipc-channels.ts", import.meta.url)), "utf8")

describe("L2 memory management UI", () => {
  it("exposes edit and delete controls for individual L2 records", () => {
    expect(settingsSource).toContain('class="memory-record__edit"')
    expect(settingsSource).toContain('class="memory-record__delete"')
    expect(settingsSource).toContain("window.memoryPanel?.editL2(id, content)")
    expect(settingsSource).toContain("window.memoryPanel?.deleteL2(id)")
  })

  it("keeps the trigger fragment read-only while editing content", () => {
    expect(settingsSource).toContain('class="memory-record__editor" maxlength="2000"')
    expect(settingsSource).toContain("触发片段（不会修改）")
    expect(settingsSource).not.toContain('class="memory-record__trigger-editor"')
  })

  it("keeps the L2 time formatter in scope for both list and edit rendering", () => {
    expect(settingsSource).toContain("function formatL2MemoryTimeMeta(")
    expect(settingsSource.match(/formatL2MemoryTimeMeta\(item\)/g)).toHaveLength(2)
    expect(settingsSource).not.toContain("const memoryTimeMeta =")
  })

  it("defines dedicated IPC routes and editor styling", () => {
    expect(ipcSource).toContain('MEMORY_PANEL_EDIT_L2: "memory-panel:edit-l2"')
    expect(ipcSource).toContain('MEMORY_PANEL_DELETE_L2: "memory-panel:delete-l2"')
    expect(settingsCss).toContain(".memory-record__editor")
  })
})
