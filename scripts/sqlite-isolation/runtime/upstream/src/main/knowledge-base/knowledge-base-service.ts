import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import path from "node:path";
import { Worker } from "node:worker_threads";
import type {
  KnowledgeCollection, KnowledgeDocument, KnowledgePathEntry, KnowledgeReadResult,
  KnowledgeScope, KnowledgeSearchHit, KnowledgeState,
} from "../../shared/knowledge-base-types";
import { workspaceScope } from "../memory/wiki-paths";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_FOLDER_FILES = 5000;
const SKIP_DIRECTORIES = new Set([
  ".git", ".hg", ".svn", "node_modules", "dist", "build", "out", ".next", ".cache", "coverage",
]);
const TEXT_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown", ".mdx", ".log", ".json", ".jsonl", ".yaml", ".yml", ".toml",
  ".ini", ".csv", ".tsv", ".xml", ".html", ".css", ".scss", ".js", ".jsx", ".ts", ".tsx",
  ".mjs", ".cjs", ".py", ".rs", ".go", ".java", ".c", ".cc", ".cpp", ".h", ".hpp",
  ".sh", ".ps1", ".sql", ".rb", ".php", ".swift", ".kt", ".vue", ".svelte",
]);

interface Manifest {
  version: 1;
  enabled: boolean;
  collections: Array<Omit<KnowledgeCollection, "scanning">>;
}

type WorkerResponse = { requestId: number; result?: unknown; error?: string };

function normalizedPath(value: string): string {
  if (!path.isAbsolute(value)) throw new Error("知识库只接受绝对路径");
  return path.resolve(value);
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function isRegisteredPath(collection: Manifest["collections"][number], filePath: string): boolean {
  return collection.paths.some((source) => {
    if (source.kind === "file") return samePath(source.path, filePath);
    const relative = path.relative(source.path, filePath);
    return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
  });
}

function documentId(collectionId: string, filePath: string): string {
  const normalized = process.platform === "win32" ? filePath.toLowerCase() : filePath;
  return createHash("sha256").update(`${collectionId}\0${normalized}`).digest("hex");
}

function sourceExcerpt(text: string, query: string): { line?: number; excerpt: string } {
  const needle = query.normalize("NFKC").trim().toLocaleLowerCase();
  const parts = [...new Intl.Segmenter("zh", { granularity: "word" }).segment(needle)]
    .filter((part) => part.isWordLike).map((part) => part.segment);
  let line = 1;
  let start = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i < text.length && text.charCodeAt(i) !== 10) continue;
    const value = text.slice(start, i).replace(/\r$/, "");
    const normalized = value.normalize("NFKC").toLocaleLowerCase();
    const matches = [needle, ...parts].map((part) => normalized.indexOf(part)).filter((position) => position >= 0);
    if (matches.length) {
      const position = Math.min(...matches);
      const from = Math.max(0, position - 120);
      const excerpt = value.slice(from, from + 400).trim();
      return { line, excerpt: `${from > 0 ? "…" : ""}${excerpt}${from + 400 < value.length ? "…" : ""}` };
    }
    line++;
    start = i + 1;
  }
  return { excerpt: "" };
}

function lineWindow(text: string, startLine: number, maxLines: number): Pick<KnowledgeReadResult, "startLine" | "endLine" | "totalLines" | "content"> {
  const selected: string[] = [];
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i < text.length && text.charCodeAt(i) !== 10) continue;
    if (line >= startLine && selected.length < maxLines) {
      selected.push(`${String(line).padStart(5, " ")} | ${text.slice(lineStart, i).replace(/\r$/, "")}`);
    }
    line++;
    lineStart = i + 1;
  }
  return {
    startLine, endLine: startLine + selected.length - 1, totalLines: line - 1,
    content: selected.join("\n").slice(0, 20_000),
  };
}

export class KnowledgeBaseService {
  readonly root: string;
  private manifest: Manifest;
  private worker: Worker | null = null;
  private workerRequestId = 0;
  private readonly pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private readonly scanning = new Set<string>();
  private readonly pendingRefresh = new Set<string>();
  private generation = 0;
  private readonly collectionRevisions = new Map<string, number>();
  private manifestQueue: Promise<unknown> = Promise.resolve();
  private startupTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(userDataRoot: string) {
    this.root = path.join(normalizedPath(userDataRoot), "knowledge");
    fsSync.mkdirSync(this.root, { recursive: true });
    const rootStat = fsSync.lstatSync(this.root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new Error("知识库目录不安全");
    const file = path.join(this.root, "collections.json");
    try {
      const stat = fsSync.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("知识库目录文件不安全");
      const parsed = JSON.parse(fsSync.readFileSync(file, "utf8")) as Partial<Manifest>;
      if (parsed.version !== 1 || typeof parsed.enabled !== "boolean" || !Array.isArray(parsed.collections)) {
        throw new Error("知识库目录格式无效");
      }
      this.manifest = { version: 1, enabled: parsed.enabled, collections: parsed.collections };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      this.manifest = { version: 1, enabled: true, collections: [] };
    }
    if (this.manifest.enabled && this.manifest.collections.some((item) => item.enabled && item.paths.length)) {
      this.startupTimer = setTimeout(() => { void this.refreshAll(); }, 5000);
      this.startupTimer.unref?.();
    }
  }

  get enabled(): boolean { return this.manifest.enabled; }
  get hasEnabledCollections(): boolean {
    return this.manifest.enabled && this.manifest.collections.some((item) => item.enabled && item.paths.length > 0);
  }

  state(): KnowledgeState {
    return { enabled: this.manifest.enabled, collections: this.manifest.collections.map((collection) => ({
      ...structuredClone(collection), scanning: this.scanning.has(collection.id),
    })) };
  }

  private async saveManifest(): Promise<void> {
    const file = path.join(this.root, "collections.json");
    const next = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(next, JSON.stringify(this.manifest, null, 2), { encoding: "utf8", mode: 0o600, flag: "wx" });
    try { await fs.rename(next, file); }
    catch (error) { await fs.rm(next, { force: true }); throw error; }
  }

  private mutate<T>(action: () => Promise<T>): Promise<T> {
    const next = this.manifestQueue.catch(() => undefined).then(action);
    this.manifestQueue = next;
    return next;
  }

  private invalidateCollection(id: string): void {
    this.collectionRevisions.set(id, (this.collectionRevisions.get(id) ?? 0) + 1);
  }

  private spawnWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(path.join(__dirname, "knowledge-index-worker.js"), {
      workerData: { dbPath: path.join(this.root, "search.sqlite") },
    });
    this.worker = worker;
    const failPending = (error: Error) => {
      if (this.worker !== worker) return;
      this.worker = null;
      for (const request of this.pending.values()) request.reject(error);
      this.pending.clear();
    };
    worker.on("message", (message: WorkerResponse) => {
      const request = this.pending.get(message.requestId);
      if (!request) return;
      this.pending.delete(message.requestId);
      if (message.error) request.reject(new Error(message.error));
      else request.resolve(message.result);
    });
    worker.on("error", (error) => failPending(error instanceof Error ? error : new Error(String(error))));
    worker.on("exit", (code) => failPending(new Error(`知识库索引线程退出：${code}`)));
    return worker;
  }

  private request<T>(type: string, payload: unknown): Promise<T> {
    const worker = this.spawnWorker();
    const requestId = ++this.workerRequestId;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, { resolve, reject });
      worker.postMessage({ requestId, type, payload });
    });
  }

  private async stopWorker(): Promise<void> {
    const worker = this.worker;
    this.worker = null;
    for (const request of this.pending.values()) request.reject(new Error("知识库已关闭"));
    this.pending.clear();
    if (worker) await worker.terminate();
  }

  async close(): Promise<void> {
    this.generation++;
    if (this.startupTimer) clearTimeout(this.startupTimer);
    await this.stopWorker();
  }

  async setEnabled(enabled: boolean): Promise<KnowledgeState> {
    if (typeof enabled !== "boolean") throw new Error("知识库开关无效");
    await this.mutate(async () => {
      this.manifest.enabled = enabled;
      await this.saveManifest();
      if (!enabled) { this.generation++; await this.stopWorker(); }
    });
    if (enabled) void this.refreshAll();
    return this.state();
  }

  async createCollection(input: { name: string; scope: KnowledgeScope }): Promise<KnowledgeState> {
    const name = input.name?.trim();
    if (!name || name.length > 100) throw new Error("资料集名称须为 1 至 100 个字符");
    let scope: KnowledgeScope = { kind: "global" };
    if (input.scope?.kind === "workspace") {
      const root = normalizedPath(input.scope.workspaceRoot);
      const id = workspaceScope(root).workspaceId;
      if (input.scope.workspaceId !== id) throw new Error("工作区身份无效");
      scope = { kind: "workspace", workspaceId: id, workspaceRoot: root,
        workspaceName: input.scope.workspaceName.slice(0, 100) };
    } else if (input.scope?.kind !== "global") throw new Error("资料集范围无效");
    await this.mutate(async () => {
      const at = Date.now();
      this.manifest.collections.push({ id: randomUUID(), name, scope, enabled: true,
        paths: [], createdAt: at, updatedAt: at, fileCount: 0, errorCount: 0 });
      await this.saveManifest();
    });
    return this.state();
  }

  async deleteCollection(id: string): Promise<KnowledgeState> {
    await this.mutate(async () => {
      if (!this.manifest.collections.some((item) => item.id === id)) throw new Error("资料集不存在");
      this.manifest.collections = this.manifest.collections.filter((item) => item.id !== id);
      await this.saveManifest();
      this.invalidateCollection(id);
    });
    await this.request("removeCollection", { collectionId: id });
    if (!this.enabled) await this.stopWorker();
    return this.state();
  }

  async setCollectionEnabled(id: string, enabled: boolean): Promise<KnowledgeState> {
    if (typeof enabled !== "boolean") throw new Error("资料集开关无效");
    await this.mutate(async () => {
      const collection = this.collection(id);
      collection.enabled = enabled;
      collection.updatedAt = Date.now();
      await this.saveManifest();
      if (!enabled) this.invalidateCollection(id);
    });
    if (enabled && this.enabled) void this.refreshCollection(id);
    return this.state();
  }

  private collection(id: string): Manifest["collections"][number] {
    const collection = this.manifest.collections.find((item) => item.id === id);
    if (!collection) throw new Error("资料集不存在");
    return collection;
  }

  async addPaths(id: string, entries: KnowledgePathEntry[]): Promise<KnowledgeState> {
    if (!Array.isArray(entries) || entries.length > 100) throw new Error("路径数量无效");
    const paths: KnowledgePathEntry[] = [];
    for (const entry of entries) {
      if (entry?.kind !== "file" && entry?.kind !== "directory") throw new Error("路径类型无效");
      const resolved = normalizedPath(entry.path);
      const stat = await fs.lstat(resolved);
      if (stat.isSymbolicLink() || (entry.kind === "file" ? !stat.isFile() : !stat.isDirectory())) {
        throw new Error(`路径类型无效：${resolved}`);
      }
      const real = await fs.realpath(resolved);
      if (!samePath(real, resolved)) throw new Error(`不支持符号链接路径：${resolved}`);
      paths.push({ path: resolved, kind: entry.kind });
    }
    await this.mutate(async () => {
      const collection = this.collection(id);
      for (const entry of paths) {
        if (!collection.paths.some((item) => samePath(item.path, entry.path))) collection.paths.push(entry);
      }
      collection.updatedAt = Date.now();
      await this.saveManifest();
      this.invalidateCollection(id);
    });
    if (this.enabled && this.collection(id).enabled) void this.refreshCollection(id);
    return this.state();
  }

  async removePath(id: string, sourcePath: string): Promise<KnowledgeState> {
    const resolved = normalizedPath(sourcePath);
    await this.mutate(async () => {
      const collection = this.collection(id);
      collection.paths = collection.paths.filter((item) => !samePath(item.path, resolved));
      collection.updatedAt = Date.now();
      await this.saveManifest();
      this.invalidateCollection(id);
    });
    if (this.enabled && this.collection(id).enabled) void this.refreshCollection(id);
    return this.state();
  }

  private async enumerate(collection: Manifest["collections"][number]): Promise<{
    files: Array<{ id: string; path: string; name: string }>;
    warning?: { truncated: boolean; unreadableFolders: number };
  }> {
    const paths: string[] = [];
    const seen = new Set<string>();
    let unreadableFolders = 0;
    let truncated = false;
    const add = (filePath: string) => {
      const key = process.platform === "win32" ? filePath.toLowerCase() : filePath;
      if (seen.has(key)) return;
      if (paths.length >= MAX_FOLDER_FILES) { truncated = true; return; }
      seen.add(key);
      paths.push(filePath);
    };
    for (const source of collection.paths) {
      if (source.kind === "file") { add(source.path); continue; }
      const folders = [source.path];
      while (folders.length && paths.length < MAX_FOLDER_FILES) {
        const folder = folders.shift()!;
        let entries: fsSync.Dirent[];
        try { entries = await fs.readdir(folder, { withFileTypes: true }); }
        catch { unreadableFolders++; continue; }
        for (const [index, entry] of entries.entries()) {
          if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
          const full = path.join(folder, entry.name);
          if (entry.isDirectory()) {
            if (!SKIP_DIRECTORIES.has(entry.name.toLowerCase())) folders.push(full);
          } else if (entry.isFile() && TEXT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) add(full);
          if (paths.length >= MAX_FOLDER_FILES) {
            if (index < entries.length - 1 || folders.length) truncated = true;
            break;
          }
        }
      }
      if (folders.length) truncated = true;
    }
    return {
      files: paths.map((filePath) => ({ id: documentId(collection.id, filePath), path: filePath, name: path.basename(filePath) })),
      ...(truncated || unreadableFolders ? { warning: { truncated, unreadableFolders } } : {}),
    };
  }

  async refreshCollection(id: string): Promise<KnowledgeState> {
    const collection = this.collection(id);
    if (!this.enabled || !collection.enabled) return this.state();
    if (this.scanning.has(id)) { this.pendingRefresh.add(id); return this.state(); }
    this.scanning.add(id);
    const generation = this.generation;
    const revision = this.collectionRevisions.get(id) ?? 0;
    const isCurrent = () => generation === this.generation && revision === (this.collectionRevisions.get(id) ?? 0)
      && this.enabled && this.manifest.collections.some((item) => item.id === id && item.enabled);
    void (async () => {
      try {
        const { files, warning } = await this.enumerate(collection);
        for (const file of files) {
          if (!isCurrent()) return;
          await this.request("index", { ...file, collectionId: id });
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
        if (!isCurrent()) return;
        await this.request("pruneCollection", { collectionId: id, keepIds: files.map((item) => item.id) });
        const documents = await this.request<KnowledgeDocument[]>("list", { collectionId: id });
        await this.mutate(async () => {
          const current = this.manifest.collections.find((item) => item.id === id);
          if (!current || !isCurrent()) return;
          current.fileCount = documents.length;
          current.errorCount = documents.filter((item) => item.status !== "ready").length;
          current.lastScannedAt = Date.now();
          current.scanWarning = warning;
          current.scanError = undefined;
          await this.saveManifest();
        });
      } catch (error) {
        console.warn("[KnowledgeBase] refresh failed:", id, error);
        await this.mutate(async () => {
          const current = this.manifest.collections.find((item) => item.id === id);
          if (!current || !isCurrent()) return;
          current.scanError = error instanceof Error ? error.message.slice(0, 300) : "扫描失败";
          await this.saveManifest();
        }).catch((saveError) => console.warn("[KnowledgeBase] failed to save scan error:", saveError));
      } finally {
        this.scanning.delete(id);
        if (this.pendingRefresh.delete(id) && this.enabled && this.manifest.collections.some((item) => item.id === id && item.enabled)) {
          void this.refreshCollection(id);
        }
      }
    })();
    return this.state();
  }

  async refreshAll(): Promise<void> {
    for (const id of this.manifest.collections.map((item) => item.id)) {
      if (!this.enabled) return;
      if (this.manifest.collections.some((item) => item.id === id && item.enabled)) {
        await this.refreshCollection(id);
        while (this.scanning.has(id) && this.enabled) {
          await new Promise<void>((resolve) => setTimeout(resolve, 100));
        }
      }
    }
  }

  async listDocuments(collectionId: string): Promise<KnowledgeDocument[]> {
    this.collection(collectionId);
    if (!this.enabled) return [];
    return this.request("list", { collectionId });
  }

  private visibleCollections(workspaceRoot?: string, collectionId?: string): Manifest["collections"] {
    const workspaceId = workspaceRoot ? workspaceScope(workspaceRoot).workspaceId : undefined;
    return this.manifest.collections.filter((item) => item.enabled && item.paths.length > 0 &&
      (!collectionId || item.id === collectionId) &&
      (item.scope.kind === "global" || item.scope.workspaceId === workspaceId));
  }

  private async verifiedText(document: KnowledgeDocument): Promise<string> {
    const filePath = normalizedPath(document.path);
    const stat = await fs.lstat(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error("来源不可用，请刷新资料集");
    const real = await fs.realpath(filePath);
    if (!samePath(real, filePath)) throw new Error("来源路径发生变化，请重新登记");
    const handle = await fs.open(filePath, "r");
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size !== stat.size || opened.mtimeMs !== stat.mtimeMs) {
        throw new Error("来源正在变化，请稍后刷新");
      }
      const bytes = await handle.readFile();
      const digest = createHash("sha256").update(bytes).digest("hex");
      if (digest !== document.contentHash) throw new Error("来源已更改，请刷新资料集");
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } finally { await handle.close(); }
  }

  async search(query: string, options: { collectionId?: string; workspaceRoot?: string; forModel?: boolean } = {}): Promise<KnowledgeSearchHit[]> {
    if (!this.enabled) return [];
    const normalized = query?.trim().slice(0, 200);
    if (!normalized) return [];
    const collections = options.forModel
      ? this.visibleCollections(options.workspaceRoot, options.collectionId)
      : this.manifest.collections.filter((item) => item.enabled && (!options.collectionId || item.id === options.collectionId));
    if (!collections.length) return [];
    const candidates = await this.request<KnowledgeDocument[]>("search", {
      query: normalized, collectionIds: collections.map((item) => item.id), limit: 30,
    });
    const names = new Map(collections.map((item) => [item.id, item.name]));
    const collectionById = new Map(collections.map((item) => [item.id, item]));
    const hits: KnowledgeSearchHit[] = [];
    for (const candidate of candidates) {
      if (hits.length >= 10) break;
      const collection = collectionById.get(candidate.collectionId);
      if (!collection || !isRegisteredPath(collection, candidate.path)) continue;
      try {
        const text = await this.verifiedText(candidate);
        if (!this.enabled) break;
        const current = this.manifest.collections.find((item) => item.id === collection.id && item.enabled);
        if (!current || !isRegisteredPath(current, candidate.path) ||
          (options.forModel && !this.visibleCollections(options.workspaceRoot).some((item) => item.id === collection.id))) continue;
        const match = sourceExcerpt(text, normalized);
        hits.push({ documentId: candidate.id, collectionId: candidate.collectionId,
          collectionName: names.get(candidate.collectionId) ?? "", path: candidate.path, name: candidate.name,
          ...(match.line ? { line: match.line } : {}), excerpt: match.excerpt, contentHash: candidate.contentHash! });
      } catch { /* Changed or missing sources are never returned as current evidence. */ }
    }
    return hits;
  }

  async read(documentIdValue: string, options: { workspaceRoot?: string; forModel?: boolean; expectedHash?: string; startLine?: number; maxLines?: number } = {}): Promise<KnowledgeReadResult> {
    if (!this.enabled) throw new Error("知识库已关闭");
    const document = await this.request<KnowledgeDocument | null>("get", { id: documentIdValue });
    if (!document || document.status !== "ready") throw new Error("资料不存在或尚未建立索引");
    const collection = this.collection(document.collectionId);
    if (!collection.enabled || !isRegisteredPath(collection, document.path) ||
      (options.forModel && !this.visibleCollections(options.workspaceRoot).some((item) => item.id === collection.id))) {
      throw new Error("当前会话无权读取此资料");
    }
    if (options.expectedHash && options.expectedHash !== document.contentHash) throw new Error("资料版本已变化，请重新搜索");
    const text = await this.verifiedText(document);
    if (!this.enabled || !this.manifest.collections.includes(collection) || !collection.enabled || !isRegisteredPath(collection, document.path) ||
      (options.forModel && !this.visibleCollections(options.workspaceRoot).some((item) => item.id === collection.id))) {
      throw new Error("当前会话无权读取此资料");
    }
    const startLine = Number.isFinite(options.startLine) ? Math.max(1, Math.floor(options.startLine!)) : 1;
    const maxLines = Number.isFinite(options.maxLines)
      ? Math.min(100, Math.max(1, Math.floor(options.maxLines!))) : 60;
    return { documentId: document.id, path: document.path, contentHash: document.contentHash!,
      ...lineWindow(text, startLine, maxLines) };
  }

  async sourcePath(documentIdValue: string): Promise<string> {
    if (!this.enabled) throw new Error("知识库已关闭");
    const document = await this.request<KnowledgeDocument | null>("get", { id: documentIdValue });
    if (!document || document.status !== "ready") throw new Error("资料不存在");
    const collection = this.collection(document.collectionId);
    if (!collection.enabled || !isRegisteredPath(collection, document.path)) throw new Error("资料不存在");
    const stat = await fs.lstat(document.path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("原文件不可用");
    if (!this.enabled || !this.manifest.collections.includes(collection) || !collection.enabled ||
      !isRegisteredPath(collection, document.path)) throw new Error("资料不存在");
    return document.path;
  }
}

let service: KnowledgeBaseService | null = null;

export function initializeKnowledgeBase(userDataRoot: string): KnowledgeBaseService {
  service ??= new KnowledgeBaseService(userDataRoot);
  return service;
}

export function getKnowledgeBase(): KnowledgeBaseService | null { return service; }
export function isKnowledgeBaseAvailable(): boolean { return service?.hasEnabledCollections ?? false; }
