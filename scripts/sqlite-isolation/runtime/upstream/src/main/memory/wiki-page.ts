import { createHash } from "node:crypto";
import path from "node:path";
import matter from "gray-matter";
import { isValidPageId, pageRelativePath, wikiHash } from "./wiki-paths";
import type {
  WikiChatSource, WikiClaim, WikiClaimCandidate, WikiPage, WikiPageType, WikiScope,
  WikiSourceRef, WikiTag,
} from "./wiki-types";

const TAGS = new Set<WikiTag>(["chat", "learn", "work", "code"]);
const TYPES = new Set<WikiPageType>(["self", "person", "concept", "topic", "project", "experience"]);
const STATUSES = new Set(["current", "historical", "uncertain", "revoked"]);
const MAX_QUOTE_CHARS = 240;
const MAX_PAGE_BYTES = 512 * 1024;
const MAX_CLAIMS = 500;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmpty(value: unknown, max = 500): value is string {
  return typeof value === "string" && value.trim().length > 0 && Array.from(value).length <= max && !value.includes("\0");
}

function finiteTime(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function validDate(value: unknown): value is string {
  return typeof value === "string" && /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2}))?$/.test(value) && Number.isFinite(Date.parse(value));
}

function validScope(value: unknown): value is WikiScope {
  return isRecord(value) && (value.kind === "global" ||
    (value.kind === "workspace" && typeof value.workspaceId === "string" && /^[a-f0-9]{32}$/.test(value.workspaceId)));
}

export function wikiChatSourceId(conversationId: string, messageId: string, revision: string | number): string {
  const normalizedRevision = String(revision);
  if (![conversationId, messageId, normalizedRevision].every((part) => nonEmpty(part, 512))) {
    throw new Error("WIKI_INVALID_CHAT_SOURCE");
  }
  return `chat:${createHash("sha256").update(JSON.stringify([conversationId, messageId, normalizedRevision])).digest("hex")}`;
}

function normalizeChatSource(source: WikiChatSource, sourceText: string): WikiChatSource {
  if (!nonEmpty(source.conversationId, 512) || !nonEmpty(source.messageId, 512) ||
      !nonEmpty(source.revision, 64) || !finiteTime(source.assertedAt) ||
      ![undefined, "user", "assistant"].includes(source.sourceRole)) {
    throw new Error("WIKI_INVALID_CHAT_SOURCE");
  }
  if (typeof sourceText !== "string") throw new Error("WIKI_MISSING_SOURCE_TEXT");
  const expectedId = wikiChatSourceId(source.conversationId, source.messageId, source.revision);
  if (source.sourceId !== undefined && source.sourceId !== expectedId) throw new Error("WIKI_SOURCE_ID_MISMATCH");
  const evidenceQuote = source.evidenceQuote?.trim();
  if (evidenceQuote && (Array.from(evidenceQuote).length > MAX_QUOTE_CHARS || !sourceText.includes(evidenceQuote))) {
    throw new Error("WIKI_INVALID_EVIDENCE_QUOTE");
  }
  return {
    kind: "chat", sourceId: expectedId, conversationId: source.conversationId,
    messageId: source.messageId, revision: source.revision, assertedAt: source.assertedAt,
    sourceRole: source.sourceRole ?? "user", ...(evidenceQuote ? { evidenceQuote } : {}),
  };
}

function validSource(source: unknown): source is WikiSourceRef {
  if (!isRecord(source) || !nonEmpty(source.sourceId, 100) || !finiteTime(source.assertedAt)) return false;
  if (source.kind === "chat") {
    return nonEmpty(source.conversationId, 512) && nonEmpty(source.messageId, 512) &&
      nonEmpty(source.revision, 64) && source.sourceId === wikiChatSourceId(source.conversationId, source.messageId, source.revision) &&
      [undefined, "user", "assistant"].includes(source.sourceRole as string | undefined) &&
      (source.evidenceQuote === undefined || nonEmpty(source.evidenceQuote, MAX_QUOTE_CHARS));
  }
  if (source.kind === "manual") return source.note === undefined || typeof source.note === "string";
  if (source.kind === "document") {
    return nonEmpty(source.originalPath, 4096) && nonEmpty(source.contentHash, 128) &&
      (source.locator === undefined || nonEmpty(source.locator, 512)) &&
      (source.evidenceQuote === undefined || nonEmpty(source.evidenceQuote, MAX_QUOTE_CHARS));
  }
  return false;
}

export function assertValidWikiCandidate(candidate: WikiClaimCandidate): void {
  if (!nonEmpty(candidate.subject, 160) || !nonEmpty(candidate.predicate, 120) || !nonEmpty(candidate.value, 2000) ||
      !validScope(candidate.scope) ||
      !["assertion", "change", "correction", "tentative", "historical"].includes(candidate.statementKind) ||
      (candidate.validFrom !== undefined && !validDate(candidate.validFrom)) ||
      (candidate.validTo !== undefined && !validDate(candidate.validTo)) ||
      (candidate.validFrom && candidate.validTo && Date.parse(candidate.validFrom) > Date.parse(candidate.validTo)) ||
      (candidate.tags !== undefined && (!Array.isArray(candidate.tags) || !candidate.tags.every((tag) => TAGS.has(tag)))) ||
      (candidate.pageType !== undefined && !TYPES.has(candidate.pageType)) ||
      (candidate.aliases !== undefined && (!Array.isArray(candidate.aliases) || candidate.aliases.length > 20 || !candidate.aliases.every((alias) => nonEmpty(alias, 160)))) ||
      (candidate.relatedPageIds !== undefined && (!Array.isArray(candidate.relatedPageIds) || candidate.relatedPageIds.length > 30 || !candidate.relatedPageIds.every(isValidPageId)))) {
    throw new Error("WIKI_INVALID_CANDIDATE");
  }
  normalizeChatSource(candidate.source, candidate.sourceText);
}

function validClaim(value: unknown): value is WikiClaim {
  return isRecord(value) && nonEmpty(value.id, 100) && nonEmpty(value.subject, 160) &&
    nonEmpty(value.predicate, 120) && nonEmpty(value.value, 2000) && STATUSES.has(value.status as string) &&
    finiteTime(value.assertedAt) && (value.validFrom === undefined || validDate(value.validFrom)) &&
    (value.validTo === undefined || validDate(value.validTo)) && Array.isArray(value.sources) &&
    value.sources.length > 0 && value.sources.every(validSource) &&
    (value.manuallyRevoked === undefined || typeof value.manuallyRevoked === "boolean");
}

function sameScope(a: WikiScope, b: WikiScope): boolean {
  return a.kind === b.kind && (a.kind === "global" || (b.kind === "workspace" && a.workspaceId === b.workspaceId));
}

export function parseWikiPage(raw: string, expectedId?: string): WikiPage {
  if (Buffer.byteLength(raw, "utf8") > MAX_PAGE_BYTES) throw new Error("WIKI_PAGE_TOO_LARGE");
  const parsed = matter(raw);
  const data: unknown = parsed.data;
  if (!isRecord(data) || data.schemaVersion !== 1 || !nonEmpty(data.id, 160) || !isValidPageId(data.id) ||
      (expectedId && data.id !== expectedId) || !nonEmpty(data.title, 160) || !validScope(data.scope) ||
      !TYPES.has(data.pageType as WikiPageType) || !finiteTime(data.updatedAt) ||
      !Array.isArray(data.aliases) || data.aliases.length > 20 || !data.aliases.every((alias) => nonEmpty(alias, 160)) ||
      !Array.isArray(data.tags) || !data.tags.every((tag) => TAGS.has(tag)) ||
      !Array.isArray(data.claims) || data.claims.length > MAX_CLAIMS || !data.claims.every(validClaim) ||
      !Array.isArray(data.links) || !data.links.every(isValidPageId) ||
      (data.suppressedSourceIds !== undefined && (!Array.isArray(data.suppressedSourceIds) ||
        !data.suppressedSourceIds.every((id) => nonEmpty(id, 160))))) {
    throw new Error("WIKI_INVALID_PAGE");
  }
  const idScope: WikiScope = data.id.startsWith("global/") ? { kind: "global" } :
    { kind: "workspace", workspaceId: data.id.split("/")[1] };
  if (!sameScope(data.scope, idScope)) throw new Error("WIKI_PAGE_SCOPE_MISMATCH");
  return {
    id: data.id, title: data.title, aliases: data.aliases as string[],
    pageType: data.pageType as WikiPageType, tags: data.tags as WikiTag[],
    scope: data.scope, updatedAt: data.updatedAt, claims: data.claims as WikiClaim[],
    links: data.links as string[], suppressedSourceIds: (data.suppressedSourceIds as string[] | undefined) ?? [],
    body: parsed.content,
  };
}

function escapeMarkdown(value: string): string {
  return value.replace(/[\\`*_\[\]<>]/g, "\\$&").replace(/\r?\n/g, " ");
}

function linkedPath(fromId: string, toId: string): string {
  const relative = path.relative(path.dirname(pageRelativePath(fromId)), pageRelativePath(toId));
  return relative.replaceAll("\\", "/");
}

export function renderWikiPageBody(page: WikiPage): string {
  const lines = [`# ${escapeMarkdown(page.title)}`, ""];
  const sections: Array<[string, WikiClaim[]]> = [
    ["当前事实", page.claims.filter((claim) => claim.status === "current")],
    ["历史", page.claims.filter((claim) => claim.status === "historical")],
    ["待确认", page.claims.filter((claim) => claim.status === "uncertain")],
  ];
  for (const [heading, claims] of sections) {
    if (claims.length === 0) continue;
    lines.push(`## ${heading}`, "");
    for (const claim of claims) {
      const period = claim.validFrom || claim.validTo ?
        `（${claim.validFrom ?? "?"} ～ ${claim.validTo ?? "现在"}）` : "";
      lines.push(`- **${escapeMarkdown(claim.predicate)}**：${escapeMarkdown(claim.value)}${period}`);
    }
    lines.push("");
  }
  if (page.links.length > 0) {
    lines.push("## 相关页面", "");
    for (const id of page.links) lines.push(`- [${escapeMarkdown(id)}](${linkedPath(page.id, id)})`);
    lines.push("");
  }
  return lines.join("\n").trimEnd() + "\n";
}

export function stringifyWikiPage(page: WikiPage): string {
  const content = matter.stringify(renderWikiPageBody(page), {
    schemaVersion: 1, id: page.id, title: page.title, aliases: page.aliases,
    pageType: page.pageType, tags: page.tags, scope: page.scope,
    updatedAt: page.updatedAt, claims: page.claims, links: page.links,
    suppressedSourceIds: page.suppressedSourceIds,
  });
  if (Buffer.byteLength(content, "utf8") > MAX_PAGE_BYTES) throw new Error("WIKI_PAGE_TOO_LARGE");
  return content;
}

export function newWikiPage(id: string, candidate: WikiClaimCandidate): WikiPage {
  return {
    id, title: candidate.subject.trim(), aliases: [],
    pageType: candidate.pageType ?? (id === "global/self" ? "self" : "topic"),
    tags: [], scope: candidate.scope, updatedAt: Date.now(), claims: [], links: [],
    suppressedSourceIds: [], body: "",
  };
}

/** Deterministic merge; the extractor must classify relocation vs temporary location before this step. */
export function mergeWikiCandidate(page: WikiPage, candidate: WikiClaimCandidate): boolean {
  assertValidWikiCandidate(candidate);
  if (!sameScope(page.scope, candidate.scope)) throw new Error("WIKI_CANDIDATE_SCOPE_MISMATCH");
  const source = normalizeChatSource(candidate.source, candidate.sourceText);
  const sourceId = source.sourceId!;
  const predicate = candidate.predicate.trim();
  const value = candidate.value.trim();
  const suppressionMarker = `${sourceId}:${wikiHash(JSON.stringify([predicate, value]))}`;
  if (page.suppressedSourceIds.includes(sourceId) || page.suppressedSourceIds.includes(suppressionMarker)) return false;
  const alreadySupported = page.claims.some((claim) => claim.predicate === predicate && claim.value === value &&
    claim.sources.some((existing) => existing.sourceId === sourceId));
  if (alreadySupported) return false;
  const currentConflicts = page.claims.filter((old) => old.predicate === predicate && old.status === "current" && old.value !== value);
  const newestCurrent = currentConflicts.reduce((latest, old) => Math.max(latest, old.assertedAt), 0);
  const supersededBeforeBackfill = (candidate.statementKind === "change" || candidate.statementKind === "correction") &&
    newestCurrent > source.assertedAt;
  const newClaimStatus = candidate.statementKind === "tentative" || source.sourceRole === "assistant"
    ? "uncertain" : candidate.statementKind === "historical" || supersededBeforeBackfill ? "historical" : "current";

  const matching = page.claims.find((claim) => claim.predicate === predicate && claim.value === value &&
    claim.status === newClaimStatus && claim.validFrom === candidate.validFrom && !claim.manuallyRevoked);
  if (matching) {
    matching.sources.push(source);
    matching.assertedAt = Math.max(matching.assertedAt, source.assertedAt);
  } else {
    if (page.claims.length >= MAX_CLAIMS) throw new Error("WIKI_TOO_MANY_CLAIMS");
    const claim: WikiClaim = {
      id: `claim:${wikiHash(JSON.stringify([page.id, predicate, value, sourceId]))}`,
      subject: page.title, predicate, value, status: newClaimStatus,
      assertedAt: source.assertedAt, ...(candidate.validFrom ? { validFrom: candidate.validFrom } : {}),
      ...(candidate.validTo || supersededBeforeBackfill
        ? { validTo: candidate.validTo ?? new Date(newestCurrent).toISOString() } : {}), sources: [source],
    };
    if (newClaimStatus === "current") {
      const conflicting = currentConflicts;
      const manualCurrent = conflicting.some((old) => old.sources.some((ref) => ref.kind === "manual"));
      if (candidate.statementKind === "correction") {
        for (const old of conflicting) old.status = "revoked";
      } else if (candidate.statementKind === "change" && !manualCurrent) {
        for (const old of conflicting) {
          old.status = "historical";
          old.validTo = candidate.validFrom ?? new Date(source.assertedAt).toISOString();
        }
      } else if (manualCurrent) {
        claim.status = "uncertain";
      } else if (conflicting.length > 0) {
        claim.status = "uncertain";
        for (const old of conflicting) old.status = "uncertain";
      }
    }
    page.claims.push(claim);
  }
  for (const tag of candidate.tags ?? []) if (!page.tags.includes(tag)) page.tags.push(tag);
  for (const alias of candidate.aliases ?? []) if (alias !== page.title && !page.aliases.includes(alias)) page.aliases.push(alias);
  for (const relatedId of candidate.relatedPageIds ?? []) {
    if (relatedId !== page.id && !page.links.includes(relatedId)) page.links.push(relatedId);
  }
  if (candidate.pageType && page.pageType === "topic") page.pageType = candidate.pageType;
  page.updatedAt = Math.max(page.updatedAt, source.assertedAt, Date.now());
  page.body = renderWikiPageBody(page);
  return true;
}

export function stripConversationSources(page: WikiPage, predicate: (source: WikiChatSource) => boolean): boolean {
  let changed = false;
  page.claims = page.claims.filter((claim) => {
    const next = claim.sources.filter((source) => source.kind !== "chat" || !predicate(source));
    if (next.length !== claim.sources.length) changed = true;
    claim.sources = next;
    return next.length > 0;
  });
  if (changed) {
    page.updatedAt = Date.now();
    page.body = renderWikiPageBody(page);
  }
  return changed;
}
