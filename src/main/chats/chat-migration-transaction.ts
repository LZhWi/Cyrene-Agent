import * as fs from "node:fs";
import * as path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const CONTROL = ".chat-migrations";
interface Pointer { version: 1; active: string | null; previous: string | null; sourceHash?: string }
interface FileRecord { name: string; sha256: string }
const MANAGED = ["cyrene-chats", "cyrene-tts-cache", "phone-context-events.json", "rag-data", path.join("plugin-data", "companion-memory")];
const digest = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const read = <T>(file: string): T => JSON.parse(fs.readFileSync(file, "utf8"));
function ordinary(file: string) {
  if (fs.lstatSync(file).isSymbolicLink() || path.resolve(fs.realpathSync(file)).toLowerCase() !== path.resolve(file).toLowerCase()) throw new Error("迁移路径不能经过链接");
}
function inventory(directory: string, relative = ""): FileRecord[] {
  ordinary(path.join(directory, relative));
  return fs.readdirSync(path.join(directory, relative), { withFileTypes: true }).flatMap(item => {
    const name = path.join(relative, item.name), file = path.join(directory, name); ordinary(file);
    if (item.isDirectory()) return inventory(directory, name);
    if (!item.isFile()) throw new Error("迁移包包含非常规文件");
    return [{ name, sha256: digest(file) }];
  }).sort((a, b) => a.name.localeCompare(b.name));
}
function atomicJson(file: string, value: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, "wx");
  try { fs.writeFileSync(fd, JSON.stringify(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary, file);
}
function generation(base: string, id: string | null) {
  if (id === null) return base;
  if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error("迁移代号无效");
  const directory = path.join(base, CONTROL, "generations", id); ordinary(directory);
  return directory;
}
function pointer(base: string): Pointer {
  ordinary(base);
  const control = path.join(base, CONTROL);
  if (fs.existsSync(control)) ordinary(control);
  const file = path.join(control, "active.json");
  if (!fs.existsSync(file)) return { version: 1, active: null, previous: null };
  ordinary(file);
  const value = read<Pointer>(file);
  if (value.version !== 1) throw new Error("迁移指针版本无效");
  generation(base, value.active); generation(base, value.previous);
  return value;
}
export function resolveChatMigrationData(base: string): string {
  return generation(base, pointer(base).active);
}
export function chatMigrationInventory(directory: string): FileRecord[] {
  return MANAGED.flatMap(name => {
    const file = path.join(directory, name);
    if (!fs.existsSync(file)) return [];
    ordinary(file);
    return fs.statSync(file).isDirectory() ? inventory(directory, name) : [{ name, sha256: digest(file) }];
  }).sort((a, b) => a.name.localeCompare(b.name));
}
function verifyPackage(candidate: string): FileRecord[] {
  ordinary(candidate);
  const manifest = path.join(candidate, "manifest.json"); ordinary(manifest);
  const expected = read<FileRecord[]>(manifest);
  const actual = inventory(candidate).filter(item => item.name !== "manifest.json");
  if (JSON.stringify([...expected].sort((a,b) => a.name.localeCompare(b.name))) !== JSON.stringify(actual)) throw new Error("迁移包清单校验失败");
  for (const item of actual) {
    const top = item.name.split(path.sep)[0];
    if (!["cyrene-chats", "cyrene-tts-cache", "phone-context-events.json", "plugin-data", "rag-data", "migration-baseline.json"].includes(top)) throw new Error("迁移包包含聊天数据之外的文件");
  }
  if (!actual.some(item => item.name === path.join("cyrene-chats", "index.json"))
    || !actual.some(item => item.name === path.join("plugin-data", "companion-memory", "memory-state.json"))) throw new Error("迁移包不完整");
  return actual;
}

/** Called only before subsystem initialization, while the host owns its base-directory single-instance lock. */
export function prepareChatMigration(base: string, candidate: string) {
  const relative = path.relative(base, candidate);
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))) throw new Error("迁移包不能位于宿主数据目录内");
  const previous = pointer(base), files = verifyPackage(candidate), sourceHash = digest(path.join(candidate, "manifest.json"));
  if (previous.sourceHash === sourceHash) return { id: previous.active, unchanged: true };
  const current = generation(base, previous.active);
  const baselineFile = path.join(candidate, "migration-baseline.json");
  const baseline = fs.existsSync(baselineFile) ? read<FileRecord[]>(baselineFile) : undefined;
  if (baseline && JSON.stringify(chatMigrationInventory(current)) !== JSON.stringify(baseline)) throw new Error("目标数据自打包后已变化，请重新生成迁移包");
  const id = randomUUID(), control = path.join(base, CONTROL), destination = path.join(control, "generations", id);
  fs.mkdirSync(destination, { recursive: true }); ordinary(destination);
  for (const entry of fs.readdirSync(current)) {
    if ([CONTROL, "SingletonLock", "SingletonCookie", "SingletonSocket", "lockfile"].includes(entry)) continue;
    const from = path.join(current, entry); ordinary(from);
    fs.cpSync(from, path.join(destination, entry), { recursive: true, filter: file => { ordinary(file); return true; } });
  }
  for (const relative of ["cyrene-chats", "cyrene-tts-cache", "rag-data", path.join("plugin-data", "companion-memory")]) {
    const replace = path.resolve(destination, relative);
    if (!replace.startsWith(path.resolve(destination) + path.sep)) throw new Error("迁移目标越界");
    if (fs.existsSync(replace)) { ordinary(replace); fs.rmSync(replace, { recursive: true }); }
  }
  for (const item of files) {
    const to = path.join(destination, item.name); fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(candidate, item.name), to);
    if (digest(to) !== item.sha256) throw new Error("迁移包在复制期间发生变化");
  }
  // Absolute attachment paths must follow the activated generation, including recovery copies.
  const sessions = path.join(destination, "cyrene-chats", "sessions");
  for (const name of fs.readdirSync(sessions).filter(name => name.endsWith(".json"))) {
    const file = path.join(sessions, name), session = read<any>(file);
    for (const message of session.messages ?? []) for (const attachment of message.attachments ?? []) {
      if (typeof attachment.filePath !== "string") continue;
      const relative = path.relative(candidate, attachment.filePath);
      if (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)) {
        attachment.filePath = path.join(destination, relative);
        attachment.previewUrl = pathToFileURL(attachment.filePath).href;
      }
    }
    atomicJson(file, session);
  }
  verifyPackage(candidate);
  if (baseline && JSON.stringify(chatMigrationInventory(current)) !== JSON.stringify(baseline)) throw new Error("目标数据在准备期间发生变化");
  atomicJson(path.join(control, `${id}.prepared.json`), { previous, sourceHash, baseline, files: inventory(destination) });
  return { id, unchanged: false };
}
export function commitChatMigration(base: string, id: string) {
  generation(base, id);
  ordinary(path.join(base, CONTROL, `${id}.prepared.json`));
  const control = path.join(base, CONTROL), prepared = read<{ previous: Pointer; sourceHash: string; baseline?: FileRecord[]; files: FileRecord[] }>(path.join(control, `${id}.prepared.json`));
  const current = pointer(base);
  if (current.active === id) return;
  if (JSON.stringify(current) !== JSON.stringify(prepared.previous)) throw new Error("迁移基线已改变");
  if (prepared.baseline && JSON.stringify(chatMigrationInventory(generation(base, current.active))) !== JSON.stringify(prepared.baseline)) throw new Error("目标数据在提交前发生变化");
  if (JSON.stringify(inventory(generation(base, id))) !== JSON.stringify(prepared.files)) throw new Error("候选数据在提交前发生变化");
  atomicJson(path.join(control, "active.json"), { version: 1, active: id, previous: current.active, sourceHash: prepared.sourceHash });
}
export function rollbackChatMigration(base: string) {
  const current = pointer(base);
  if (current.active === null) throw new Error("没有可回滚的迁移");
  atomicJson(path.join(base, CONTROL, "active.json"), { version: 1, active: current.previous, previous: current.active });
}
