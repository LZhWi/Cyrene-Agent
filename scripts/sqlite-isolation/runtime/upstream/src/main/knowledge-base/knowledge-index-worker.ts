import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { parentPort, workerData } from "node:worker_threads";
import type { KnowledgeDocument } from "../../shared/knowledge-base-types";

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const dbPath = (workerData as { dbPath: string }).dbPath;
let db: DatabaseSync;
let jieba: import("@node-rs/jieba").Jieba | null = null;

function tokenizer(): import("@node-rs/jieba").Jieba {
  return jieba ??= new (require("@node-rs/jieba").Jieba)();
}

function words(value: string): string[] {
  return tokenizer().cut(value.normalize("NFKC"), true).map((part: string) => part.trim()).filter(Boolean);
}

function openDatabase(): DatabaseSync {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  let database: DatabaseSync;
  try {
    database = new DatabaseSync(dbPath);
    const check = database.prepare("PRAGMA quick_check").get() as { quick_check: string };
    if (check.quick_check !== "ok") throw new Error("KNOWLEDGE_INDEX_CORRUPT");
  } catch (error) {
    if (!/CORRUPT|malformed|not a database/i.test(String(error))) throw error;
    try { database!.close(); } catch { /* A corrupt handle may already be closed. */ }
    fs.renameSync(dbPath, `${dbPath}.corrupt-${Date.now()}`);
    database = new DatabaseSync(dbPath);
  }
  database.exec(`
    PRAGMA journal_mode=DELETE;
    CREATE TABLE IF NOT EXISTS documents (
      id TEXT PRIMARY KEY,
      collection_id TEXT NOT NULL,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      status TEXT NOT NULL,
      error TEXT,
      size INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      content_hash TEXT
    );
    CREATE INDEX IF NOT EXISTS documents_collection ON documents(collection_id);
    CREATE VIRTUAL TABLE IF NOT EXISTS documents_fts USING fts5(title, body, content='', contentless_delete=1);
  `);
  return database;
}

interface DocumentRow {
  id: string;
  collection_id: string;
  path: string;
  name: string;
  status: KnowledgeDocument["status"];
  error: string | null;
  size: number;
  updated_at: number;
  content_hash: string | null;
}

function documentFromRow(row: DocumentRow): KnowledgeDocument {
  return {
    id: row.id, collectionId: row.collection_id, path: row.path, name: row.name,
    status: row.status, ...(row.error ? { error: row.error } : {}), size: row.size,
    updatedAt: row.updated_at, ...(row.content_hash ? { contentHash: row.content_hash } : {}),
  };
}

function saveDocument(document: KnowledgeDocument, text?: string): KnowledgeDocument {
  db.exec("BEGIN IMMEDIATE");
  try {
    const existing = db.prepare("SELECT rowid FROM documents WHERE id=?").get(document.id) as { rowid: number } | undefined;
    if (existing) db.prepare("DELETE FROM documents_fts WHERE rowid=?").run(existing.rowid);
    db.prepare(`INSERT INTO documents (id,collection_id,path,name,status,error,size,updated_at,content_hash)
      VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      collection_id=excluded.collection_id,path=excluded.path,name=excluded.name,status=excluded.status,
      error=excluded.error,size=excluded.size,updated_at=excluded.updated_at,content_hash=excluded.content_hash`)
      .run(document.id, document.collectionId, document.path, document.name, document.status,
        document.error ?? null, document.size, document.updatedAt, document.contentHash ?? null);
    if (text !== undefined) {
      const row = db.prepare("SELECT rowid FROM documents WHERE id=?").get(document.id) as { rowid: number };
      db.prepare("INSERT INTO documents_fts (rowid,title,body) VALUES (?,?,?)")
        .run(row.rowid, words(document.name).join(" "), words(text).join(" "));
    }
    db.exec("COMMIT");
    return document;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

function indexDocument(input: { id: string; collectionId: string; path: string; name: string }): KnowledgeDocument {
  const base = { id: input.id, collectionId: input.collectionId, path: input.path, name: input.name };
  let stat: fs.Stats;
  try { stat = fs.lstatSync(input.path); }
  catch {
    return saveDocument({ ...base, status: "missing", error: "文件不存在或无法访问", size: 0, updatedAt: Date.now() });
  }
  const details = { size: stat.size, updatedAt: stat.mtimeMs };
  if (!stat.isFile() || stat.isSymbolicLink()) {
    return saveDocument({ ...base, ...details, status: "unsupported", error: "只支持普通文本文件" });
  }
  if (stat.size > MAX_FILE_BYTES) {
    return saveDocument({ ...base, ...details, status: "too_large", error: "文件超过 10 MB" });
  }
  try {
    const prior = db.prepare("SELECT * FROM documents WHERE id=?").get(input.id) as DocumentRow | undefined;
    if (prior?.status === "ready" && prior.size === stat.size && prior.updated_at === stat.mtimeMs) {
      return documentFromRow(prior);
    }
    const content = fs.readFileSync(input.path);
    const current = fs.lstatSync(input.path);
    if (current.size !== stat.size || current.mtimeMs !== stat.mtimeMs || current.isSymbolicLink()) {
      throw new Error("读取时文件发生变化，请刷新");
    }
    const head = content.subarray(0, Math.min(content.length, 4096));
    if (head.includes(0)) {
      return saveDocument({ ...base, ...details, status: "unsupported", error: "疑似二进制文件" });
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(content);
    const contentHash = createHash("sha256").update(content).digest("hex");
    if (prior?.content_hash === contentHash && prior.status === "ready") {
      db.prepare("UPDATE documents SET size=?, updated_at=? WHERE id=?")
        .run(details.size, details.updatedAt, input.id);
      return { ...documentFromRow(prior), ...details };
    }
    return saveDocument({ ...base, ...details, status: "ready", contentHash }, text);
  } catch (error) {
    return saveDocument({ ...base, ...details, status: "error",
      error: error instanceof Error ? error.message.slice(0, 300) : "读取失败" });
  }
}

function deleteDocument(id: string): void {
  const row = db.prepare("SELECT rowid FROM documents WHERE id=?").get(id) as { rowid: number } | undefined;
  if (!row) return;
  db.prepare("DELETE FROM documents_fts WHERE rowid=?").run(row.rowid);
  db.prepare("DELETE FROM documents WHERE id=?").run(id);
}

type WorkerRequest = { requestId: number; type: string; payload: any };

function handle(request: WorkerRequest): unknown {
  const payload = request.payload;
  switch (request.type) {
    case "index": return indexDocument(payload);
    case "list": return (db.prepare("SELECT * FROM documents WHERE collection_id=? ORDER BY path")
      .all(payload.collectionId) as unknown as DocumentRow[]).map(documentFromRow);
    case "get": {
      const row = db.prepare("SELECT * FROM documents WHERE id=?").get(payload.id) as DocumentRow | undefined;
      return row ? documentFromRow(row) : null;
    }
    case "removeCollection": {
      const rows = db.prepare("SELECT id FROM documents WHERE collection_id=?").all(payload.collectionId) as unknown as Array<{ id: string }>;
      db.exec("BEGIN IMMEDIATE");
      try { for (const row of rows) deleteDocument(row.id); db.exec("COMMIT"); }
      catch (error) { db.exec("ROLLBACK"); throw error; }
      return null;
    }
    case "pruneCollection": {
      const keep = new Set<string>(payload.keepIds);
      const rows = db.prepare("SELECT id FROM documents WHERE collection_id=?").all(payload.collectionId) as unknown as Array<{ id: string }>;
      db.exec("BEGIN IMMEDIATE");
      try { for (const row of rows) if (!keep.has(row.id)) deleteDocument(row.id); db.exec("COMMIT"); }
      catch (error) { db.exec("ROLLBACK"); throw error; }
      return null;
    }
    case "search": {
      const collectionIds = payload.collectionIds as string[];
      if (!collectionIds.length) return [];
      const tokens = words(String(payload.query).slice(0, 200)).slice(0, 12);
      if (!tokens.length) return [];
      const query = tokens.map((word) => `"${word.replaceAll('"', '""')}"`).join(" OR ");
      const marks = collectionIds.map(() => "?").join(",");
      try {
        return (db.prepare(`SELECT d.* FROM documents_fts JOIN documents d ON d.rowid=documents_fts.rowid
          WHERE documents_fts MATCH ? AND d.status='ready' AND d.collection_id IN (${marks})
          ORDER BY bm25(documents_fts, 8.0, 1.0) LIMIT ?`)
          .all(query, ...collectionIds, Math.min(50, Math.max(1, payload.limit ?? 20))) as unknown as DocumentRow[])
          .map(documentFromRow);
      } catch { return []; }
    }
    default: throw new Error("KNOWLEDGE_UNKNOWN_INDEX_COMMAND");
  }
}

db = openDatabase();
parentPort?.on("message", (request: WorkerRequest) => {
  try { parentPort?.postMessage({ requestId: request.requestId, result: handle(request) }); }
  catch (error) { parentPort?.postMessage({ requestId: request.requestId,
    error: error instanceof Error ? error.message : String(error) }); }
});
