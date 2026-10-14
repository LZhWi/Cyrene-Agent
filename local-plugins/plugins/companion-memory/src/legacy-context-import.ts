import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import type { PluginStorage } from "@playa0v0/cyrene-plugin-sdk";
import { createEntityGraph } from "./entity-graph";
import { createRelationshipLog } from "./relationship-context";
import { createSocialContext } from "./social-context";
import { LEGACY_CONTEXT_KEY } from "./legacy-context-state";
import { messageVersion } from "./legacy-source";
import type { SourceSession } from "./source-matcher";
import type { Evidence } from "./evidence";
import { legacyUserText } from "./legacy-sticker-text";

const files = ["entity-graph.json", "relationship-log.json", "chat-social-atoms.json", "memory-dream.json"] as const;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export function createLegacyContextPlan(directory: string, sessions: SourceSession[] = []) {
  if (typeof directory !== "string" || !path.isAbsolute(directory) || realpathSync(directory).toLowerCase() !== path.resolve(directory).toLowerCase()) throw new Error("旧上下文目录必须为普通绝对路径");
  const raw: Record<string, any> = {}, hashes: Record<string, string> = {};
  for (const name of files) {
    const file = path.join(directory, name);
    if (!existsSync(file)) continue;
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 32 * 1024 * 1024 || realpathSync(file).toLowerCase() !== file.toLowerCase()) throw new Error("旧上下文文件边界无效");
    const bytes = readFileSync(file); hashes[name] = digest(bytes); raw[name] = JSON.parse(bytes.toString("utf8"));
  }
  if (!Object.keys(raw).length) throw new Error("目录中没有可导入的上下文文件");
  const graph = raw[files[0]] ?? { entities: [], relations: [] };
  const relationship = raw[files[1]] ?? { entries: [], dailySummaries: [] };
  const social = raw[files[2]] ?? { version: 1, atoms: [] };
  const dream = raw[files[3]] ?? { logs: [] };
  if (!Array.isArray(relationship.entries) || relationship.entries.length > 500 || !Array.isArray(relationship.dailySummaries) || relationship.dailySummaries.length > 90
    || relationship.entries.some((e: any) => !e || ![e.id, e.date, e.userText, e.assistantText, e.userMood, e.relationshipSignal, e.nextCareCue].every(v => typeof v === "string") || !e.id || !Number.isFinite(e.createdAt)
      || (e.channel !== undefined && !["desktop", "wechat", "feishu", "mobile"].includes(e.channel)) || (e.cyreneFeeling !== undefined && typeof e.cyreneFeeling !== "string"))
    || relationship.dailySummaries.some((s: any) => !s || ![s.date, s.summary, s.nextCareCue].every(v => typeof v === "string") || !Number.isFinite(s.updatedAt))) throw new Error("旧关系日志无效");
  if (!Array.isArray(dream.logs) || (dream.lastDreamAt !== undefined && (!Number.isFinite(dream.lastDreamAt) || dream.lastDreamAt < 0))) throw new Error("旧 Dream 运行记录无效");
  const states: Record<string, any> = {
    "entity-graph": { version: 1, entities: graph.entities, relations: graph.relations },
    "relationship-log": { version: 1, entries: relationship.entries.map((e: any) => ({ ...e, turnId: `legacy:${e.id}`, origin: "legacy" })), dailySummaries: relationship.dailySummaries.map((s: any) => ({ ...s, origin: "legacy" })) },
    "social-context-state": structuredClone(social),
    "auto-dream-state": { version: 1, ...(dream.lastDreamAt === undefined ? {} : { lastCompletedAt: dream.lastDreamAt }) },
  };
  const sourceEvidence: Evidence[] = [];
  const probe: PluginStorage = { get: <T>(key: string) => structuredClone(states[key]) as T, set: () => { throw new Error("导入预检必须只读"); }, rootDir: () => "unused" };
  createEntityGraph(probe); createRelationshipLog(probe); createSocialContext(probe, async () => { throw new Error("导入不能调用模型"); });
  for (const atom of states["social-context-state"].atoms) {
    const session = sessions.find(s => s.id === atom.conversationId);
    const ids = [...new Set<string>([atom.evidenceTurnId, atom.sourceUserTurnId, atom.sourceAssistantTurnId, atom.closedByTurnId].filter(Boolean))];
    const messages = ids.map(id => session?.messages.find(m => m.id === id));
    const evidence = session?.messages.find(m => m.id === atom.evidenceTurnId);
    const verified = messages.length > 0 && messages.every(Boolean) && evidence && atom.evidenceQuote && legacyUserText(evidence.content).includes(legacyUserText(atom.evidenceQuote))
      && (evidence.role === "model" ? "assistant" : evidence.role) === (atom.evidenceRole ?? "user");
    atom.legacyUnbound = !verified;
    if (verified && !evidence.content.includes(atom.evidenceQuote)) atom.evidenceQuote = evidence.content;
    if (verified) sourceEvidence.push({ id: `legacy-social:${atom.id}`, memoryId: `legacy-social:${atom.id}`, quoteSnippet: atom.evidenceQuote,
      createdAt: atom.createdAt, sourceStatus: "active", provenance: "verified", conversationId: atom.conversationId, messageIds: ids,
      messageVersions: messages.map(m => ({ id: m!.id, hash: messageVersion(m!) })) });
  }
  return { version: 1 as const, sourceHash: digest(JSON.stringify({ hashes, sourceEvidence })), hashes, states, sourceEvidence, archive: raw,
    summary: { files: Object.keys(raw).length, entities: graph.entities.length, relations: graph.relations?.length ?? 0,
      relationshipEntries: relationship.entries.length, dailySummaries: relationship.dailySummaries.length, socialAtoms: social.atoms.length,
      verifiedSocialAtoms: sourceEvidence.length, unboundSocialAtoms: social.atoms.length - sourceEvidence.length, dreamLogs: dream.logs.length } };
}

/** One durable envelope is the commit point. Consumers load it only on restart. */
export function commitLegacyContext(storage: PluginStorage, plan: ReturnType<typeof createLegacyContextPlan>, expectedHash: string) {
  if (plan.sourceHash !== expectedHash) throw new Error("旧上下文自预检后已变化");
  if (storage.get(LEGACY_CONTEXT_KEY) !== undefined) throw new Error("旧上下文已经导入，拒绝重复覆盖");
  for (const key of Object.keys(plan.states)) {
    const current = storage.get<any>(key);
    if (current !== undefined) throw new Error("目标上下文已有状态文件，拒绝合并覆盖");
  }
  storage.set(LEGACY_CONTEXT_KEY, structuredClone(plan));
  return { ...plan.summary, restartRequired: true };
}
