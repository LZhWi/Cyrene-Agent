export function sessionSearchResults<T extends { title: string; workspaceDisplayName?: string; workspaceRoot?: string; updatedAt: number }>(sessions: T[], query: string): T[] {
  const needle = query.trim().toLocaleLowerCase();
  return sessions.filter((session) => `${session.title} ${session.workspaceDisplayName ?? ""} ${session.workspaceRoot ?? ""}`
    .toLocaleLowerCase().includes(needle)).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 20);
}

export function sessionTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(timestamp);
}
