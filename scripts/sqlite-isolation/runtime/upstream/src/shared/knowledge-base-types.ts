export type KnowledgeScope = { kind: "global" } | {
  kind: "workspace";
  workspaceId: string;
  workspaceRoot: string;
  workspaceName: string;
};

export type KnowledgePathKind = "file" | "directory";

export interface KnowledgePathEntry {
  path: string;
  kind: KnowledgePathKind;
}

export interface KnowledgeCollection {
  id: string;
  name: string;
  scope: KnowledgeScope;
  enabled: boolean;
  paths: KnowledgePathEntry[];
  createdAt: number;
  updatedAt: number;
  lastScannedAt?: number;
  scanning: boolean;
  fileCount: number;
  errorCount: number;
  scanWarning?: { truncated: boolean; unreadableFolders: number };
  scanError?: string;
}

export interface KnowledgeDocument {
  id: string;
  collectionId: string;
  path: string;
  name: string;
  status: "ready" | "missing" | "unsupported" | "too_large" | "error";
  error?: string;
  size: number;
  updatedAt: number;
  contentHash?: string;
}

export interface KnowledgeState {
  enabled: boolean;
  collections: KnowledgeCollection[];
}

export interface KnowledgeSearchHit {
  documentId: string;
  collectionId: string;
  collectionName: string;
  path: string;
  name: string;
  line?: number;
  excerpt: string;
  contentHash: string;
}

export interface KnowledgeReadResult {
  documentId: string;
  path: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  content: string;
  contentHash: string;
}

export interface KnowledgeWorkspaceOption {
  workspaceId: string;
  workspaceRoot: string;
  workspaceName: string;
  active?: boolean;
}

export interface KnowledgeBaseApi {
  getState(): Promise<KnowledgeState>;
  setEnabled(enabled: boolean): Promise<KnowledgeState>;
  createCollection(input: { name: string; scope: KnowledgeScope }): Promise<KnowledgeState>;
  deleteCollection(collectionId: string): Promise<KnowledgeState>;
  setCollectionEnabled(collectionId: string, enabled: boolean): Promise<KnowledgeState>;
  listWorkspaces(): Promise<KnowledgeWorkspaceOption[]>;
  pickPaths(kind: KnowledgePathKind): Promise<string[]>;
  addPaths(collectionId: string, paths: KnowledgePathEntry[]): Promise<KnowledgeState>;
  removePath(collectionId: string, path: string): Promise<KnowledgeState>;
  refreshCollection(collectionId: string): Promise<KnowledgeState>;
  listDocuments(collectionId: string): Promise<KnowledgeDocument[]>;
  search(query: string, collectionId?: string): Promise<KnowledgeSearchHit[]>;
  openSource(documentId: string): Promise<{ ok: boolean; error?: string }>;
}
