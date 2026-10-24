export type MemoryMode = "vector" | "summary" | "wiki" | "off";

let activeMemoryMode: MemoryMode = "vector";

export function normalizeMemoryMode(value: unknown): MemoryMode {
  return value === "summary" || value === "wiki" || value === "off" ? value : "vector";
}

export function isVectorMemoryEnabled(): boolean {
  return activeMemoryMode === "vector";
}

export function isSummaryMemoryEnabled(): boolean {
  return activeMemoryMode === "summary";
}

export function isWikiMemoryEnabled(): boolean {
  return activeMemoryMode === "wiki";
}

/** Existing RAG/L0/L1/L2 call sites remain vector-only. */
export function isMemoryEnabled(): boolean {
  return isVectorMemoryEnabled();
}

export function setMemoryMode(mode: MemoryMode): void {
  activeMemoryMode = mode;
}
