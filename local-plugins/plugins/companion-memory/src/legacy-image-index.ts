import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { ChatSession } from "../../../../src/shared/chat-types";

interface ImageRow { source: string; text: string; embedding: number[]; createdAt: number; metadata?: Record<string, unknown> }
interface HistoryVectors { version: 1; entries: Record<string, { text: string; embedding: number[] }> }

/** Offline migration: resolve original path identities before copying/remapping attachment paths. */
export function migrateLegacyImageIndex(sourceSessions: ChatSession[], targetSessions: ChatSession[], rows: ImageRow[], originalIndex: HistoryVectors, options: { preferSource?: boolean } = {}) {
  const sessions = structuredClone(targetSessions), index = structuredClone(originalIndex);
  const matched: Array<{ session: ChatSession; messageId: string; attachmentIndex: number; row: ImageRow }> = [];
  const seen = new Set<string>();
  const conflicts: string[] = [];
  for (const row of rows.filter(item => item.source === "chat_image")) {
    const meta = row.metadata;
    const source = sourceSessions.find(session => session.id === meta?.sessionId);
    const message = source?.messages.find(message => message.id === meta?.turnId && message.role === "user");
    const attachmentIndex = message?.attachments?.findIndex((attachment, i) => attachment.kind === "image"
      && createHash("sha256").update(`${i}\0${attachment.filePath}`).digest("hex") === meta?.imageKey) ?? -1;
    const session = sessions.find(session => session.id === source?.id);
    const targetMessage = session?.messages.find(item => item.id === message?.id && item.role === "user");
    const attachment = targetMessage?.attachments?.[attachmentIndex];
    const sourceAttachment = message?.attachments?.[attachmentIndex];
    if (!session || !message || !attachment || attachment.kind !== "image" || attachment.name !== sourceAttachment?.name) throw new Error("图片来源无法唯一绑定");
    const key = `${session.id}\0${message.id}\0${attachmentIndex}`;
    if (seen.has(key)) throw new Error("图片来源重复"); seen.add(key);
    const prefix = `图片 ${attachment.name}。画面内容：`;
    if (!row.text.startsWith(prefix) || !row.text.slice(prefix.length).trim()
      || typeof meta?.summary !== "string" || !meta.summary.trim()
      || !Number.isFinite(row.createdAt) || !Array.isArray(row.embedding) || row.embedding.length < 64
      || row.embedding.some(value => !Number.isFinite(value))) throw new Error("旧图片索引字段无效");
    const caption = row.text.slice(prefix.length);
    const currentCaption = attachment.visualIndexCaption?.trim() || attachment.caption?.trim();
    if ((currentCaption && currentCaption !== caption) || (attachment.visualIndexSummary && attachment.visualIndexSummary !== meta.summary)) {
      if (!options.preferSource) { conflicts.push(key); continue; }
    }
    attachment.visualIndexCaption = caption;
    attachment.visualIndexSummary = meta.summary;
    if (options.preferSource) attachment.visualIndexedAt = row.createdAt;
    else attachment.visualIndexedAt ??= row.createdAt;
    matched.push({ session, messageId: message.id, attachmentIndex, row });
  }
  let added = 0;
  for (const { session, messageId, attachmentIndex, row } of matched) {
    const attachments = session.messages.find(message => message.id === messageId)!.attachments!;
    // The host projects only images with captions; IDs use their projected position.
    const projectedIndex = attachments.slice(0, attachmentIndex).filter(item => item.kind === "image" && (item.visualIndexCaption?.trim() || item.caption?.trim())).length;
    const id = `host-image:${session.id}:${messageId}:${projectedIndex}`;
    const value = { text: row.text, embedding: [...row.embedding] };
    const existing = index.entries[id];
    if (existing && !isDeepStrictEqual(existing, value)) {
      if (!options.preferSource) throw new Error("目标图片向量已存在且不同，拒绝覆盖");
      index.entries[id] = value;
    }
    if (!existing) { index.entries[id] = value; added++; }
  }
  if (Object.keys(index.entries).length > 20_000) throw new Error("历史向量索引超过容量");
  const dimensions = new Set(Object.values(index.entries).map(item => item.embedding.length));
  if (dimensions.size > 1) throw new Error("图片向量与历史索引维度不一致");
  return { sessions, index, matched: matched.length, added, conflicts };
}
