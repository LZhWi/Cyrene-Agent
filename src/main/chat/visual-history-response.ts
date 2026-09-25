function shortSummary(value: string): string | null {
  const summary = value.trim().replace(/^摘要[：:]\s*/u, "").replace(/^['“"]|['”"]$/gu, "").trim();
  return Array.from(summary).length >= 10 && Array.from(summary).length <= 30 ? summary : null;
}

/** Parse individual JSON objects; reasoning text may contain unrelated braces. */
export function parseVisualHistoryResponse(value: string, summaryOnly: boolean): { summary: string; caption?: string } | null {
  if (summaryOnly) {
    const answer = value.replace(/<think>[\s\S]*?<\/think>/gu, "").trim();
    const summary = shortSummary(answer);
    return summary ? { summary } : null;
  }
  for (let start = value.indexOf("{"); start >= 0; start = value.indexOf("{", start + 1)) {
    let depth = 0;
    let quoted = false;
    let escaped = false;
    for (let end = start; end < value.length; end += 1) {
      const char = value[end];
      if (escaped) { escaped = false; continue; }
      if (quoted && char === "\\") { escaped = true; continue; }
      if (char === '"') { quoted = !quoted; continue; }
      if (quoted) continue;
      if (char === "{") depth += 1;
      if (char === "}") depth -= 1;
      if (depth !== 0) continue;
      try {
        const parsed = JSON.parse(value.slice(start, end + 1)) as { summary?: unknown; detail?: unknown };
        const summary = typeof parsed.summary === "string" ? shortSummary(parsed.summary) : null;
        const caption = typeof parsed.detail === "string" ? parsed.detail.trim() : "";
        if (summary && caption) return { summary, caption };
      } catch { /* try the next object */ }
      break;
    }
  }
  return null;
}
