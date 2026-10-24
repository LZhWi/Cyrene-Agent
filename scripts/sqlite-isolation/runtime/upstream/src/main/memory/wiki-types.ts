/** Long-term wiki facts are scoped by identity, never by the display title of a workspace. */
export type WikiScope = { kind: "global" } | { kind: "workspace"; workspaceId: string };
export type WikiVisibility = { workspaceIds?: string[] };
export type WikiTag = "chat" | "learn" | "work" | "code";
export type WikiPageType = "self" | "person" | "concept" | "topic" | "project" | "experience";
export type WikiClaimStatus = "current" | "historical" | "uncertain" | "revoked";
export type WikiStatementKind = "assertion" | "change" | "correction" | "tentative" | "historical";

export interface WikiChatSource {
  kind: "chat";
  /** Generated from conversationId, messageId and revision when omitted. */
  sourceId?: string;
  conversationId: string;
  messageId: string;
  revision: string;
  assertedAt: number;
  sourceRole?: "user" | "assistant";
  evidenceQuote?: string;
}

export interface WikiManualSource {
  kind: "manual";
  sourceId: string;
  assertedAt: number;
  note?: string;
}

/** Reserved for a future knowledge-base source adapter; first release does not ingest files. */
export interface WikiDocumentSource {
  kind: "document";
  sourceId: string;
  originalPath: string;
  contentHash: string;
  locator?: string;
  assertedAt: number;
  evidenceQuote?: string;
}

export type WikiSourceRef = WikiChatSource | WikiManualSource | WikiDocumentSource;

export interface WikiClaimCandidate {
  subject: string;
  predicate: string;
  value: string;
  scope: WikiScope;
  statementKind: WikiStatementKind;
  validFrom?: string;
  validTo?: string;
  tags?: WikiTag[];
  pageType?: WikiPageType;
  aliases?: string[];
  relatedPageIds?: string[];
  source: WikiChatSource;
  /** Used only to validate evidenceQuote; the full text is never copied to the wiki. */
  sourceText: string;
}

export interface WikiClaim {
  id: string;
  subject: string;
  predicate: string;
  value: string;
  status: WikiClaimStatus;
  assertedAt: number;
  validFrom?: string;
  validTo?: string;
  sources: WikiSourceRef[];
  /** Manual deletion/correction must not be undone by later replay of old chat. */
  manuallyRevoked?: boolean;
}

export interface WikiPage {
  id: string;
  title: string;
  aliases: string[];
  pageType: WikiPageType;
  tags: WikiTag[];
  scope: WikiScope;
  updatedAt: number;
  claims: WikiClaim[];
  links: string[];
  suppressedSourceIds: string[];
  body: string;
}

export interface WikiPageSummary {
  id: string;
  title: string;
  pageType: WikiPageType;
  tags: WikiTag[];
  scope: WikiScope;
  updatedAt: number;
  summary: string;
  claimCount: number;
  conflictCount: number;
}

export interface WikiSearchResult extends WikiPageSummary {
  score: number;
}

export interface WikiConflict {
  pageId: string;
  title: string;
  predicate: string;
  claims: WikiClaim[];
  reason: string;
}
