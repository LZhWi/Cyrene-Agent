import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";

export interface RecoveryIssue { file: string; canRestore: boolean }

/** Detection never edits the primary, backup or interrupted write. */
export function createChatStorageRecovery(validate: (file: string, value: unknown) => boolean) {
  const pending = new Map<string, RecoveryIssue>();
  const backup = (file: string) => file.replace(/\.json$/, ".last-good.json");
  function read(file: string, target = file): unknown | undefined {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
      return validate(target, value) ? value : undefined;
    } catch { return undefined; }
  }
  function candidate(file: string) {
    return read(file + ".tmp", file) ?? read(backup(file), file);
  }
  function inspect(file: string, required = false): void {
    if (read(file) !== undefined) return;
    if (required || [file, backup(file), file + ".tmp"].some(fs.existsSync)) {
      pending.set(file, { file, canRestore: candidate(file) !== undefined });
    }
  }
  function atomic(file: string, value: unknown): void {
    const temporary = `${file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(temporary, file);
  }
  function requireReady(): void {
    if (pending.size) throw new Error("聊天存储等待恢复确认，已暂停写入");
  }
  return {
    inspect, requireReady,
    issues: () => [...pending.values()],
    write(file: string, value: unknown) {
      requireReady();
      inspect(file);
      requireReady();
      if (!validate(file, value)) throw new Error("聊天存储结构无效，拒绝写入");
      atomic(file, value);
      atomic(backup(file), value);
    },
    recover(file: string, fallback?: unknown) {
      if (!pending.has(file)) throw new Error("没有待确认的恢复项");
      const value = candidate(file) ?? fallback;
      if (value === undefined || !validate(file, value)) throw new Error("没有可恢复的有效数据");
      const recoveryDir = path.join(path.dirname(file), "recovery");
      fs.mkdirSync(recoveryDir, { recursive: true });
      for (const source of [file, backup(file), file + ".tmp"]) {
        if (fs.existsSync(source)) fs.copyFileSync(source, path.join(recoveryDir, `${path.basename(source)}.${randomUUID()}`));
      }
      atomic(file, value);
      atomic(backup(file), value);
      pending.delete(file);
    },
    isolate(file: string) {
      if (!pending.has(file)) throw new Error("没有待确认的恢复项");
      const recoveryDir = path.join(path.dirname(file), "recovery");
      fs.mkdirSync(recoveryDir, { recursive: true });
      for (const source of [file, backup(file), file + ".tmp"]) {
        if (fs.existsSync(source)) fs.renameSync(source, path.join(recoveryDir, `${path.basename(source)}.${randomUUID()}`));
      }
      pending.delete(file);
    },
  };
}
