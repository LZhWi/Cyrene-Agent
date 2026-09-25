import fs from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"

const root = path.resolve(__dirname, "../../..")

describe("native L2 management UI", () => {
  it("renders edit/delete controls and keeps trigger evidence read-only", () => {
    const source = fs.readFileSync(path.join(root, "src/renderer/settings/memory/panel.ts"), "utf8")
    expect(source).toContain("memory-record__edit")
    expect(source).toContain("memory-record__delete")
    expect(source).toContain("memory-record__save")
    expect(source).toContain("memory-record__cancel")
    expect(source).toContain('maxlength="2000"')
    expect(source).toContain("触发片段（不会修改）")
    expect(source).toContain("window.memoryPanel?.editL2(id, content)")
    expect(source).toContain("window.memoryPanel?.deleteL2(id)")
  })

  it("exposes IPC channels and preload methods for both mutations", () => {
    const channels = fs.readFileSync(path.join(root, "src/shared/ipc-channels.ts"), "utf8")
    const preload = fs.readFileSync(path.join(root, "src/preload/index.ts"), "utf8")
    expect(channels).toContain('MEMORY_PANEL_EDIT_L2: "memory-panel:edit-l2"')
    expect(channels).toContain('MEMORY_PANEL_DELETE_L2: "memory-panel:delete-l2"')
    expect(preload).toContain("editL2: (id: string, content: string)")
    expect(preload).toContain("deleteL2: (id: string)")
  })
})
