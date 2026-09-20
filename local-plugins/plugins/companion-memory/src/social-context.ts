import { randomUUID } from "node:crypto";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import type { Turn } from "../../companion-chat/src/chat";

export type SocialAtomType = "short_term" | "open_loop";
type SocialAtomStatus = "active" | "archived" | "resolved" | "superseded";

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
  vector?: number[];
}

interface State { version: 1; atoms: SocialAtom[] }
interface Operation {
  action: "add" | "resolve";
  type?: SocialAtomType;
  content?: string;
  evidenceQuote: string;
  targetId?: string;
}

const STORAGE_KEY = "social-context-state";
const SHORT_TERM_TTL = 14 * 24 * 60 * 60 * 1000;
const OPEN_LOOP_TTL = 72 * 60 * 60 * 1000;
const MAX_ACTIVE_PER_SESSION = 200;
const MAX_INJECTION = 3;

function validAtom(value: unknown): value is SocialAtom {
  if (!value || typeof value !== "object") return false;
  const atom = value as Record<string, unknown>;
  return ["id", "conversationId", "content", "evidenceTurnId", "evidenceQuote"].every((key) => typeof atom[key] === "string")
    && (atom.type === "short_term" || atom.type === "open_loop")
    && ["active", "archived", "resolved", "superseded"].includes(String(atom.status))
    && [atom.createdAt, atom.updatedAt, atom.expiresAt].every((number) => Number.isFinite(number))
    && (atom.closedByTurnId === undefined || typeof atom.closedByTurnId === "string")
    && (atom.vector === undefined || (Array.isArray(atom.vector) && atom.vector.length >= 64 && atom.vector.every(Number.isFinite)));
}

function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  return JSON.parse(fenced ?? (start >= 0 && end >= start ? text.slice(start, end + 1) : "[]"));
}

function validateOperations(raw: unknown, turn: Turn, retrieved: SocialAtom[]): Operation[] {
  if (!Array.isArray(raw)) return [];
  const knownIds = new Set(retrieved.map((atom) => atom.id));
  return raw.flatMap((item): Operation[] => {
    if (!item || typeof item !== "object") return [];
    const value = item as Record<string, unknown>;
    const quote = typeof value.evidenceQuote === "string" ? value.evidenceQuote.trim() : "";
    if (!quote || !turn.user.includes(quote)) return [];
    if (value.action === "resolve" && typeof value.targetId === "string" && knownIds.has(value.targetId)) {
      return [{ action: "resolve", targetId: value.targetId, evidenceQuote: quote }];
    }
    if (value.action !== "add" || (value.type !== "short_term" && value.type !== "open_loop")) return [];
    const content = typeof value.content === "string" ? value.content.trim().slice(0, 240) : "";
    return content ? [{ action: "add", type: value.type, content, evidenceQuote: quote }] : [];
  }).slice(0, 4);
}

function lexicalScore(query: string, content: string): number {
  const chars = new Set(query.toLowerCase().replace(/\s+/g, ""));
  if (!chars.size) return 0;
  let hits = 0;
  for (const char of new Set(content.toLowerCase().replace(/\s+/g, ""))) if (chars.has(char)) hits += 1;
  return hits / Math.max(8, Math.min(chars.size, 40));
}

function cosine(left: number[], right: number[]): number {
  if (!left.length || left.length !== right.length) return 0;
  let dot = 0; let aa = 0; let bb = 0;
  for (let index = 0; index < left.length; index += 1) {
    dot += left[index] * right[index]; aa += left[index] ** 2; bb += right[index] ** 2;
  }
  return aa && bb ? dot / Math.sqrt(aa * bb) : 0;
}

function formatLocalTime(timestamp: number, timezone?: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
    ...(timezone ? { timeZone: timezone } : {}),
  }).format(new Date(timestamp));
}

export function createSocialContext(
  storage: PluginStorage,
  generate: (prompt: string, signal: AbortSignal) => Promise<string>,
  embed?: (text: string, signal: AbortSignal) => Promise<number[]>,
  now: () => number = Date.now,
) {
  const stored = storage.get<unknown>(STORAGE_KEY);
  if (stored !== undefined && (!stored || typeof stored !== "object" || (stored as State).version !== 1
    || !Array.isArray((stored as State).atoms) || !(stored as State).atoms.every(validAtom))) {
    throw new Error("对话连续性存储损坏，拒绝覆盖");
  }
  let state: State = stored === undefined ? { version: 1, atoms: [] } : structuredClone(stored as State);
  let lastErrorAt: number | undefined;

  function save(atoms: SocialAtom[]) {
    const next = { version: 1 as const, atoms };
    storage.set(STORAGE_KEY, next); state = next;
  }

  function candidates(conversationId: string, explicitRecall: boolean): SocialAtom[] {
    const at = now();
    return state.atoms.filter((atom) => atom.conversationId === conversationId && (
      (atom.status === "active" && atom.expiresAt > at)
      || (explicitRecall && (atom.status === "archived" || atom.status === "active"))
    ));
  }

  async function retrieve(conversationId: string, query: string, signal: AbortSignal): Promise<SocialAtom[]> {
    if (!query.trim() || signal.aborted) return [];
    const at = now();
    let changed = false;
    const atoms = structuredClone(state.atoms);
    for (const atom of atoms) if (atom.status === "active" && atom.expiresAt <= at) {
      atom.status = "archived"; atom.updatedAt = at; changed = true;
    }
    if (changed) save(atoms);
    const explicitRecall = /之前|上次|昨天|前几天|继续|接着|那个|还记得|回到/.test(query);
    const available = candidates(conversationId, explicitRecall);
    if (!available.length) return [];

    let queryVector: number[] | undefined;
    if (embed && available.some((atom) => atom.vector)) {
      try { queryVector = await embed(query, AbortSignal.any([signal, AbortSignal.timeout(1_500)])); } catch { queryVector = undefined; }
    }
    const selected = available.map((atom) => {
      const ageDays = Math.max(0, (at - atom.updatedAt) / 86_400_000);
      const recency = Math.exp(-ageDays / (atom.type === "open_loop" ? 3 : 14));
      const semantic = queryVector && atom.vector ? cosine(queryVector, atom.vector) : 0;
      return { atom, score: semantic * 0.72 + lexicalScore(query, atom.content) * 0.18 + recency * 0.10 };
    }).filter((item) => item.score >= (queryVector ? 0.34 : 0.22))
      .sort((left, right) => right.score - left.score).slice(0, MAX_INJECTION);

    if (explicitRecall && selected.some((item) => item.atom.status === "archived")) {
      const ids = new Set(selected.map((item) => item.atom.id));
      save(state.atoms.map((atom) => ids.has(atom.id) && atom.status === "archived" ? {
        ...atom, status: "active", updatedAt: at,
        expiresAt: at + (atom.type === "open_loop" ? OPEN_LOOP_TTL : SHORT_TERM_TTL),
      } : atom));
    }
    return selected.map((item) => structuredClone(item.atom));
  }

  async function extract(turn: Turn, signal: AbortSignal): Promise<void> {
    if (!turn.user.trim() || !turn.assistant.trim() || signal.aborted) return;
    // 只允许关闭本轮用户文本实际召回的至多三条候选，避免模型凭持久化 ID 越界修改其他话题。
    const retrieved = await retrieve(turn.sessionId, turn.user, signal);
    const old = retrieved.map(({ id, type, content }) => ({ id, type, content }));
    const prompt = [
      "你是对话连续性信息抽取器。只输出 JSON 数组，不写解释。",
      "只允许两类：short_term=未来两周内可能相关的用户临时状态/安排；open_loop=本轮明确留下、稍后应继续的话题。",
      "新增内容的 evidenceQuote 必须逐字摘自本轮用户消息。仅当用户本轮明确完成或取消旧 open_loop 时 resolve。不要提取长期事实、人格偏好或常识。",
      '格式：[{"action":"add","type":"short_term|open_loop","content":"...","evidenceQuote":"..."}] 或 [{"action":"resolve","targetId":"...","evidenceQuote":"..."}]；无内容输出 []。',
      `已有候选：${JSON.stringify(old)}`,
      `用户：${turn.user}`,
      `助手：${turn.assistant}`,
    ].join("\n");
    try {
      const operations = validateOperations(extractJson(await generate(prompt, signal)), turn, retrieved);
      if (!operations.length || signal.aborted) return;
      const at = now();
      const atoms = structuredClone(state.atoms);
      for (const operation of operations) {
        if (operation.action === "resolve") {
          const target = atoms.find((atom) => atom.id === operation.targetId && atom.conversationId === turn.sessionId && atom.type === "open_loop");
          if (target) { target.status = "resolved"; target.updatedAt = at; target.closedByTurnId = turn.id; }
          continue;
        }
        const duplicate = atoms.find((atom) => atom.conversationId === turn.sessionId && atom.status === "active"
          && atom.type === operation.type && atom.content === operation.content);
        if (duplicate) {
          duplicate.updatedAt = at;
          duplicate.expiresAt = at + (operation.type === "open_loop" ? OPEN_LOOP_TTL : SHORT_TERM_TTL);
          continue;
        }
        let vector: number[] | undefined;
        if (embed) { try { vector = await embed(operation.content!, signal); } catch { vector = undefined; } }
        atoms.push({
          id: randomUUID(), conversationId: turn.sessionId, type: operation.type!, content: operation.content!,
          evidenceTurnId: turn.id, evidenceQuote: operation.evidenceQuote, createdAt: at, updatedAt: at,
          expiresAt: at + (operation.type === "open_loop" ? OPEN_LOOP_TTL : SHORT_TERM_TTL), status: "active",
          ...(vector ? { vector } : {}),
        });
      }
      const active = atoms.filter((atom) => atom.conversationId === turn.sessionId && atom.status === "active")
        .sort((left, right) => right.updatedAt - left.updatedAt);
      const overflow = new Set(active.slice(MAX_ACTIVE_PER_SESSION).map((atom) => atom.id));
      save(atoms.map((atom) => overflow.has(atom.id) ? { ...atom, status: "archived", updatedAt: at } : atom));
      lastErrorAt = undefined;
    } catch {
      if (!signal.aborted) lastErrorAt = now();
    }
  }

  return {
    extract,
    retrieve,
    buildBlock(atoms: SocialAtom[], timezone?: string): string {
      if (!atoms.length) return "";
      const format = (atom: SocialAtom) => `- [形成于 ${formatLocalTime(atom.createdAt, timezone)}] ${atom.content}`;
      const shortTerm = atoms.filter((atom) => atom.type === "short_term").map(format);
      const openLoops = atoms.filter((atom) => atom.type === "open_loop").map(format);
      return [
        "【本轮可用的对话背景】",
        "以下内容只在确实相关时自然使用；不要复述这份背景，不要声称自己拥有额外记忆能力。",
        ...(shortTerm.length ? ["近期状态：", ...shortTerm] : []),
        ...(openLoops.length ? ["尚未接上的话题：", ...openLoops] : []),
      ].join("\n");
    },
    view() {
      return { total: state.atoms.length, active: state.atoms.filter((atom) => atom.status === "active" && atom.expiresAt > now()).length, lastErrorAt };
    },
  };
}
