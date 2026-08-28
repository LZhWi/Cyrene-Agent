import fs from "fs"
import os from "os"
import path from "path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { setAppPathProvider } from "./runtime/runtime-paths"

describe("token usage store runtime path", () => {
  let tempDir = ""

  afterEach(() => {
    setAppPathProvider(null)
    vi.resetModules()
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it("writes through the injected userData path outside Electron", async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-token-usage-"))
    setAppPathProvider({
      getPath: (name) => name === "userData" ? tempDir : tempDir,
      getAppPath: () => process.cwd(),
    })

    const { recordUsage, flush } = await import("./token-usage-store")
    recordUsage(12, 5, 1)
    flush()

    const stored = JSON.parse(fs.readFileSync(path.join(tempDir, "token-usage.json"), "utf8"))
    const day = Object.values(stored.days)[0] as { input: number; output: number; requests: number }
    expect(day).toMatchObject({ input: 12, output: 5, requests: 1 })
  })
})
