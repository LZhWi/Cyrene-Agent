/** The four conversation capabilities are overlapping views of one user-level wiki. */
export type WikiTag = "chat" | "learn" | "work" | "code";

export type WikiScope =
  | { kind: "global" }
  | { kind: "workspace"; workspaceId: string; workspaceName?: string };

export interface WikiSource {
  kind: "chat" | "manual" | "document";
  sourceId: string;
  locator: string;
  version: string;
  recordedAt: number;
  label?: string;
  quote?: string;
  conversationId?: string;
  entryId?: string;
}

export interface WikiClaim {
  id: string;
  subject: string;
  predicate: string;
  value: string;
  status: "current" | "historical" | "pending" | "retracted";
  assertedAt: number;
  validFrom?: string;
  validTo?: string;
  sources: WikiSource[];
}

export interface WikiPageSummary {
  id: string;
  title: string;
  kind: string;
  tags: WikiTag[];
  scope: WikiScope;
  updatedAt: number;
  excerpt: string;
  claimCount: number;
  conflictCount: number;
}

export interface WikiPageDetail extends WikiPageSummary {
  body: string;
  claims: WikiClaim[];
  relatedPages: Array<{ id: string; title: string }>;
}

export interface WikiConflict {
  pageId: string;
  pageTitle: string;
  claimIds: string[];
  reason: string;
}

export interface WikiPageListRequest {
  tag?: WikiTag;
  offset?: number;
  limit?: number;
}

export interface WikiSearchRequest extends WikiPageListRequest {
  query: string;
}

export interface WikiPageListResult {
  items: WikiPageSummary[];
  total: number;
}

export interface WikiClaimCorrection {
  pageId: string;
  claimId: string;
  value: string;
  note?: string;
}

export interface WikiClaimDeletion {
  pageId: string;
  claimId: string;
}

export type WikiMutationResult = { ok: boolean; error?: string };
