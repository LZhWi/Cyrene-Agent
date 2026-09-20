import { createHash } from "node:crypto";
import { readFileSync, lstatSync, realpathSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { auditQuote, type AuditSession } from "./support/evidence-audit";
import { matchTrigger, nearbyCandidates, type SourceSession } from "./support/trigger-matcher";
import { deriveSummarySources, type SourceRange } from "../plugins/companion-memory/src/summary-sources";
import { storedSemanticCandidates, type StoredVector } from "./support/semantic-candidates";

// 不加载宿主模块、不启动 app、不访问附件/模型，不写入激活值、访问计数或任何用户文件。
it.runIf(process.env.CYRENE_READONLY_CHAT_EVIDENCE_TEST === "1")("原始聊天证据只读核对，仅输出分类数量", () => {
  const root = path.join(homedir(), "AppData/Roaming/live2d-cyrene");
  const directory = path.join(root, "cyrene-chats/sessions");
  const hashes = new Map<string, string>();
  const hash = (buffer: Buffer) => createHash("sha256").update(buffer).digest("hex");
  function read(file: string): any {
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024 || path.normalize(realpathSync(file)).toLowerCase() !== path.normalize(file).toLowerCase()) throw new Error("源文件类型、大小或路径校验失败");
    const buffer = readFileSync(file); hashes.set(file, hash(buffer));
    try { return JSON.parse(buffer.toString("utf8")); } catch { throw new Error("源 JSON 解析失败（不输出原文）"); }
  }
  try {
    const memory = read(path.join(root, "memory.json"));
    const vectors = read(path.join(root, "rag-data", "memory-store.json")) as StoredVector[];
    expect(Array.isArray(memory.l2) && Array.isArray(memory.evidence)).toBe(true);
    expect(Array.isArray(vectors)).toBe(true);
    const references = new Set<string>();
    for (const item of memory.l2) if (typeof item.sourceConversationId === "string" && item.sourceConversationId.trim()) references.add(item.sourceConversationId);
    for (const item of memory.evidence) if (item.sourceStatus !== "deleted" && typeof item.conversationId === "string" && item.conversationId.trim()) references.add(item.conversationId);
    // 旧记忆没有来源 ID，因此只读扫描此目录内的全部正式会话；不跟随附件或备份。
    const names = readdirSync(directory).filter((name) => /^[a-zA-Z0-9_-]+\.json$/.test(name));
    const sessions = new Map<string, AuditSession>();
    const sourceSessions: SourceSession[] = [];
    for (const name of names) {
      const raw = read(path.join(directory, name));
      if (raw?.id !== name.slice(0, -5) || raw.schemaVersion !== 1 || !Array.isArray(raw.messages) || raw.messages.some((m: any) => !m || typeof m.id !== "string" || !["user", "model"].includes(m.role) || typeof m.content !== "string" || !Number.isFinite(m.at))) throw new Error("会话格式不兼容（不输出原文）");
      if (new Set(raw.messages.map((m: any) => m.id)).size !== raw.messages.length) throw new Error("会话消息 ID 重复");
      sessions.set(raw.id, { id: raw.id, messages: raw.messages.map((m: any) => ({ id: m.id, role: m.role, content: m.content })) });
      sourceSessions.push({ id: raw.id, messages: raw.messages.map((m: any) => ({ id: m.id, role: m.role, content: m.content, at: m.at })) });
    }
    const sourceQuotes: Record<string, number> = {}, independentEvidence: Record<string, number> = {};
    const count = (target: Record<string, number>, result: string) => { target[result] = (target[result] ?? 0) + 1; };
    for (const e of memory.l2) {
      if (e.sourceQuote !== undefined && typeof e.sourceQuote !== "string") throw new Error("原话字段格式无效");
      count(sourceQuotes, !e.sourceQuote?.trim() ? "empty" : !e.sourceConversationId?.trim() ? "missing-reference" : auditQuote(e.sourceQuote, sessions.get(e.sourceConversationId)));
    }
    for (const e of memory.evidence) {
      if (typeof e.quoteSnippet !== "string" || (e.messageIds !== undefined && (!Array.isArray(e.messageIds) || e.messageIds.some((id: unknown) => typeof id !== "string")))) throw new Error("证据字段格式无效");
      count(independentEvidence, e.sourceStatus === "deleted" ? "deleted" : !e.quoteSnippet.trim() ? "empty" : !e.conversationId?.trim() ? "missing-reference" : auditQuote(e.quoteSnippet, sessions.get(e.conversationId), e.messageIds));
    }
    const triggerMatches: Record<string, number> = {};
    const located = new Map<string, SourceRange>();
    let ambiguousCandidates = 0, timeCandidates = 0, semanticEligible = 0, semanticCandidates = 0, missingMemoryVector = 0, semanticTimeOverlap = 0;
    const topScores: number[] = [];
    for (const e of memory.l2) {
      if (e.isSummary === true) { count(triggerMatches, "summary-needs-children"); continue; }
      if (typeof e.triggerText !== "string") { count(triggerMatches, "missing-trigger"); continue; }
      const result = matchTrigger(e.triggerText, sourceSessions); count(triggerMatches, result.method);
      if (["exact", "normalized-exact"].includes(result.method)) {
        const at = result.candidates[0].message.at; located.set(e.id, { start: at, end: at });
      }
      if (result.method === "ambiguous") ambiguousCandidates += result.candidates.length;
      if (["ambiguous", "no-match"].includes(result.method)) {
        semanticEligible++;
        const candidates = storedSemanticCandidates(e.id, vectors, sourceSessions);
        if (!vectors.some((v) => v.source === "user_memory" && v.metadata?.l2Id === e.id)) missingMemoryVector++;
        semanticCandidates += candidates.length;
        if (candidates[0]) topScores.push(candidates[0].score);
        const nearby = nearbyCandidates(e.createdAt, sourceSessions);
        timeCandidates += nearby.length;
        const semanticKeys = new Set(candidates.map((c) => `${c.sessionId}:${c.message.id}`));
        semanticTimeOverlap += nearby.filter((c) => semanticKeys.has(`${c.sessionId}:${c.message.id}`)).length;
      }
    }
    const summarySources: Record<string, number> = {};
    for (const result of deriveSummarySources(memory.l2, located).values()) count(summarySources, result.status);
    const topScoreRange = topScores.length ? { min: Math.min(...topScores), max: Math.max(...topScores), average: topScores.reduce((a, b) => a + b, 0) / topScores.length } : null;
    console.log("READONLY_CHAT_EVIDENCE_SUMMARY " + JSON.stringify({ referencedSessions: references.size, loadedSessions: sessions.size, sourceQuotes, independentEvidence, triggerMatches, summarySources, semanticEligible, semanticCandidates, missingMemoryVector, topScoreRange, ambiguousCandidates, timeCandidates, semanticTimeOverlap, sourceFilesRead: hashes.size, writes: 0, modelRequests: 0, embeddingRequests: 0 }));
  } finally {
    let changed = 0;
    for (const [file, before] of hashes) if (hash(readFileSync(file)) !== before) changed++;
    expect(changed, "有源文件在核验期间变化；不回写、不锁定，请稳定时段重试").toBe(0);
  }
});
