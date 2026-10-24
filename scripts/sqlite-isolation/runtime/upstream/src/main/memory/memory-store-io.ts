import * as fs from "fs"
import * as path from "path"
import { app } from "electron"
import { MemoryStore } from "./memory-types"

export function resolveMemoryPath(): string | null {
  // Electron 主进程外（如单测环境）app 可能不存在，直接放弃持久化
  try {
    return path.join(app.getPath("userData"), "memory.json")
  } catch {
    return null
  }
}

export function memoryFileExists(filePath: string): boolean {
  return fs.existsSync(filePath)
}

export function backupMemoryFile(filePath: string): void {
  if (!fs.existsSync(filePath)) return
  const dir = path.dirname(filePath)
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-")
  const backupPath = path.join(dir, `memory.backup.${timestamp}.json`)
  fs.copyFileSync(filePath, backupPath)
}

export function readMemoryFile(filePath: string): Partial<MemoryStore> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<MemoryStore>
}

export function writeMemoryFile(filePath: string, store: MemoryStore): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), "utf8")
}
