const staleConversations = new Set<string>();

export function markWikiSourcesStale(conversationId: string): void {
  staleConversations.add(conversationId);
}

export function markWikiSourcesFresh(conversationId: string): void {
  staleConversations.delete(conversationId);
}

export function canReadWikiMemory(): boolean {
  return staleConversations.size === 0;
}
