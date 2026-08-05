import { app } from "electron";
import * as fs from "fs";
import * as path from "path";
import { randomUUID } from "crypto";
import type { EmbeddingProvider } from "../rag/embedding";
import { getAdapterForConfig } from "../orchestrator/vendors";
import type { VendorConfig } from "../orchestrator/vendors/types";
import { formatLocalTime, resolveChatContextTimezone } from "../chat-time-context";

export type SocialAtomType = "short_term" | "open_loop";
export type SocialAtomStatus = "active" | "archived" | "resolved" | "superseded";

export interface SocialAtom {
  id: string;
  conversationId: string;
  type: SocialAtomType;
  content: string;
  evidenceTurnId: string;
  evidenceQuote: string;
  createdAt: number;
  updatedAt: number;
  expiresAt: number;
  status: SocialAtomStatus;
  closedByTurnId?: string;
}

export interface SocialTurnContext {
  conversationId: string;
  userTurnId: string;
  assistantTurnId: string;
  userText: string;
  retrievedAtoms: SocialAtom[];
}

interface StoreData { version: 1; atoms: SocialAtom[] }
interface ExtractedOperation {
  action: "add" | "resolve";
  type?: SocialAtomType;
  content?: string;
  evidenceQuote: string;
  targetId?: string;
}

const SHORT_TERM_TTL = 14 * 24 * 60 * 60 * 1000;
const OPEN_LOOP_TTL = 72 * 60 * 60 * 1000;
const MAX_ACTIVE_PER_SESSION = 200;
const MAX_INJECTION = 3;
const embeddingCache = new Map<string, number[]>();

function filePath(): string {
  return path.join(app.getPath("userData"), "chat-social-atoms.json");
}

function load(): StoreData {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath(), "utf8")) as Partial<StoreData>;
    return { version: 1, atoms: Array.isArray(parsed.atoms) ? parsed.atoms as SocialAtom[] : [] };
  } catch {
    return { version: 1, atoms: [] };
  }
}

function save(data: StoreData): void {
  const target = filePath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const temp = target + ".tmp";
  fs.writeFileSync(temp, JSON.stringify(data, null, 2), "utf8");
  fs.renameSync(temp, target);
}

function archiveExpired(data: StoreData, now = Date.now()): boolean {
  let changed = false;
  for (const atom of data.atoms) {
    if (atom.status === "active" && atom.expiresAt <= now) {
      atom.status = "archived";
      atom.updatedAt = now;
      changed = true;
    }
  }
  return changed;
}

function cosine(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0; let aa = 0; let bb = 0;
  for (let i = 0; i < a.length; i += 1) { dot += a[i] * b[i]; aa += a[i] * a[i]; bb += b[i] * b[i]; }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

function lexicalScore(query: string, content: string): number {
  const chars = new Set(query.toLowerCase().replace(/\s+/g, ""));
  if (!chars.size) return 0;
  let hits = 0;
  for (const char of new Set(content.toLowerCase().replace(/\s+/g, ""))) if (chars.has(char)) hits += 1;
  return hits / Math.max(8, Math.min(chars.size, 40));
}

async function vector(provider: EmbeddingProvider, key: string, text: string): Promise<number[]> {
  const cached = embeddingCache.get(key);
  if (cached) return cached;
  const value = await provider.embed(text);
  embeddingCache.set(key, value);
  return value;
}

export async function retrieveSocialContext(
  conversationId: string,
  query: string,
  provider?: EmbeddingProvider | null,
): Promise<SocialAtom[]> {
  return retrieveSocialContextInternal(conversationId, query, provider, true);
}

/** Phone 只读取聊天背景，不归档、恢复或改写 Chat/Collab/Proactive 的共享状态。 */
export async function retrieveSocialContextReadOnly(
  conversationId: string,
  query: string,
  provider?: EmbeddingProvider | null,
): Promise<SocialAtom[]> {
  return retrieveSocialContextInternal(conversationId, query, provider, false);
}

async function retrieveSocialContextInternal(
  conversationId: string,
  query: string,
  provider: EmbeddingProvider | null | undefined,
  mutateState: boolean,
): Promise<SocialAtom[]> {
  if (!query.trim()) return [];
  const data = load();
  const now = Date.now();
  const changed = mutateState ? archiveExpired(data, now) : false;
  const explicitRecall = /之前|上次|昨天|前几天|继续|接着|那个|还记得|回到/.test(query);
  const candidates = data.atoms.filter((atom) => atom.conversationId === conversationId
    && (
      (atom.status === "active" && atom.expiresAt > now)
      || (explicitRecall && (atom.status === "archived" || atom.status === "active"))
    ));
  if (!candidates.length) { if (changed) save(data); return []; }

  let queryVector: number[] | null = null;
  if (provider) {
    try { queryVector = await provider.embed(query); } catch (error) {
      console.warn("[SocialContext] embedding query failed:", error instanceof Error ? error.message : String(error));
    }
  }
  const scored = await Promise.all(candidates.map(async (atom) => {
    let semantic = 0;
    if (provider && queryVector) {
      try { semantic = cosine(queryVector, await vector(provider, atom.id, atom.content)); } catch { semantic = 0; }
    }
    const lexical = lexicalScore(query, atom.content);
    const ageDays = Math.max(0, (Date.now() - atom.updatedAt) / 86_400_000);
    const recency = Math.exp(-ageDays / (atom.type === "open_loop" ? 3 : 14));
    return { atom, score: semantic * 0.72 + lexical * 0.18 + recency * 0.10 };
  }));
  const selected = scored.filter((item) => item.score >= (queryVector ? 0.34 : 0.22))
    .sort((a, b) => b.score - a.score).slice(0, MAX_INJECTION);
  for (const item of selected) {
    if (mutateState && item.atom.status === "archived") {
      item.atom.status = "active";
      item.atom.updatedAt = Date.now();
      item.atom.expiresAt = Date.now() + (item.atom.type === "open_loop" ? OPEN_LOOP_TTL : SHORT_TERM_TTL);
    }
  }
  if (mutateState && (changed || selected.some((item) => item.atom.status === "active" && explicitRecall))) save(data);
  return selected.map((item) => item.atom);
}

export function buildSocialContextBlock(atoms: SocialAtom[], timezone?: string): string {
  if (!atoms.length) return "";
  const resolvedTimezone = resolveChatContextTimezone(timezone);
  const formatAtom = (atom: SocialAtom): string =>
    `- [形成于 ${formatLocalTime(atom.createdAt, resolvedTimezone)}] ${atom.content}`;
  const shortTerm = atoms.filter((atom) => atom.type === "short_term").map(formatAtom);
  const openLoops = atoms.filter((atom) => atom.type === "open_loop").map(formatAtom);
  return [
    "【本轮可用的对话背景】",
    "以下内容只在确实相关时自然使用；不要复述这份背景，不要声称自己拥有额外记忆能力。",
    ...(shortTerm.length ? ["近期状态：", ...shortTerm] : []),
    ...(openLoops.length ? ["尚未接上的话题：", ...openLoops] : []),
  ].join("\n");
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced ?? text.slice(text.indexOf("["), text.lastIndexOf("]") + 1);
  return JSON.parse(candidate);
}

function validateOperations(raw: unknown, context: SocialTurnContext): ExtractedOperation[] {
  if (!Array.isArray(raw)) return [];
  const knownIds = new Set(context.retrievedAtoms.map((atom) => atom.id));
  return raw.flatMap((item): ExtractedOperation[] => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    const action = value.action;
    const quote = typeof value.evidenceQuote === "string" ? value.evidenceQuote.trim() : "";
    if (!quote || !context.userText.includes(quote)) return [];
    if (action === "resolve" && typeof value.targetId === "string" && knownIds.has(value.targetId)) {
      return [{ action, targetId: value.targetId, evidenceQuote: quote }];
    }
    if (action !== "add" || (value.type !== "short_term" && value.type !== "open_loop")) return [];
    const content = typeof value.content === "string" ? value.content.trim().slice(0, 240) : "";
    if (!content) return [];
    return [{ action, type: value.type, content, evidenceQuote: quote }];
  }).slice(0, 4);
}

export async function extractAndStoreSocialContext(
  context: SocialTurnContext,
  assistantText: string,
  config: VendorConfig,
): Promise<void> {
  if (!context.userText.trim() || !assistantText.trim()) return;
  const adapter = getAdapterForConfig(config);
  const old = context.retrievedAtoms.map((atom) => ({ id: atom.id, type: atom.type, content: atom.content }));
  const prompt = [
    "你是对话连续性信息抽取器。只输出 JSON 数组，不写解释。",
    "只允许两类：short_term=未来两周内可能相关的用户临时状态/安排；open_loop=本轮明确留下、稍后应继续的话题。",
    "新增内容的 evidenceQuote 必须逐字摘自本轮用户消息。仅当用户本轮明确完成或取消旧 open_loop 时 resolve。不要提取长期事实、人格偏好或常识。",
    '格式：[{"action":"add","type":"short_term|open_loop","content":"...","evidenceQuote":"..."}] 或 [{"action":"resolve","targetId":"...","evidenceQuote":"..."}]；无内容输出 []。',
    `已有候选：${JSON.stringify(old)}`,
    `用户：${context.userText}`,
    `助手：${assistantText}`,
  ].join("\n");
  const http = adapter.buildRequest({ model: config.model, messages: [{ role: "user", content: prompt }], maxTokens: 700, stream: false }, { ...config, reasoning: { mode: "off" } });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const response = await fetch(http.url, { method: "POST", headers: http.headers, body: http.body, signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const operations = validateOperations(extractJson(adapter.parseResponse(await response.json()).text), context);
    if (!operations.length) return;
    const data = load();
    const now = Date.now();
    for (const operation of operations) {
      if (operation.action === "resolve") {
        const target = data.atoms.find((atom) => atom.id === operation.targetId && atom.conversationId === context.conversationId && atom.type === "open_loop");
        if (target) { target.status = "resolved"; target.updatedAt = now; target.closedByTurnId = context.userTurnId; }
        continue;
      }
      const duplicate = data.atoms.find((atom) => atom.conversationId === context.conversationId && atom.status === "active" && atom.type === operation.type && atom.content === operation.content);
      if (duplicate) { duplicate.updatedAt = now; duplicate.expiresAt = now + (operation.type === "open_loop" ? OPEN_LOOP_TTL : SHORT_TERM_TTL); continue; }
      data.atoms.push({ id: randomUUID(), conversationId: context.conversationId, type: operation.type!, content: operation.content!, evidenceTurnId: context.userTurnId, evidenceQuote: operation.evidenceQuote, createdAt: now, updatedAt: now, expiresAt: now + (operation.type === "open_loop" ? OPEN_LOOP_TTL : SHORT_TERM_TTL), status: "active" });
    }
    const active = data.atoms.filter((atom) => atom.conversationId === context.conversationId && atom.status === "active").sort((a, b) => b.updatedAt - a.updatedAt);
    for (const atom of active.slice(MAX_ACTIVE_PER_SESSION)) { atom.status = "archived"; atom.updatedAt = now; }
    save(data);
  } finally { clearTimeout(timer); }
}

export function deleteSocialContextForConversation(conversationId: string): void {
  try {
    const data = load();
    const next = data.atoms.filter((atom) => atom.conversationId !== conversationId);
    if (next.length !== data.atoms.length) save({ version: 1, atoms: next });
  } catch (error) {
    console.warn("[SocialContext] conversation cleanup failed:", error instanceof Error ? error.message : String(error));
  }
}

export function deleteSocialContextByTurnIds(conversationId: string, turnIds: string[]): void {
  const ids = new Set(turnIds);
  if (!ids.size) return;
  try {
    const data = load();
    const next = data.atoms.filter((atom) => atom.conversationId !== conversationId || (!ids.has(atom.evidenceTurnId) && !atom.closedByTurnId?.split(",").some((id) => ids.has(id))));
    if (next.length !== data.atoms.length) save({ version: 1, atoms: next });
  } catch (error) {
    console.warn("[SocialContext] turn cleanup failed:", error instanceof Error ? error.message : String(error));
  }
}
