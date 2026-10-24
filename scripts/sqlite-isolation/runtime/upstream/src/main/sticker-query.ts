/**
 * 将聊天内容压缩成适合贴纸文本匹配的自然语言。
 *
 * 贴纸只应反映对话情绪/意图；代码与数学表达式会引入大量无关词语，
 * 因此在匹配前直接剔除，避免技术内容误触发表情。
 *
 * 之前用 markdown-it 完整 parse 一次再重组 inline token，但因为我们只关心"留什么 /
 * 删什么"，纯正则反而更轻、更直接，也避免了 lib 依赖。
 */
export function extractStickerMatchText(source: string): string {
  if (!source.trim()) return "";

  return source
    // fenced code blocks (both Markdown fence styles)
    .replace(/(?:^|\n)[ \t]*```[\s\S]*?```[ \t]*(?=\n|$)/g, "\n")
    .replace(/(?:^|\n)[ \t]*~~~[\s\S]*?~~~[ \t]*(?=\n|$)/g, "\n")
    // display and inline TeX math
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\\\[[\s\S]*?\\\]/g, " ")
    .replace(/\\\([\s\S]*?\\\)/g, " ")
    .replace(/\$(?:\\.|[^$\r\n])+\$/g, " ")
    // inline code spans
    .replace(/`[^`\n]*`/g, " ")
    // inline / block-level HTML tags: drop angle-bracket markup, keep inner text
    .replace(/<\/?[a-zA-Z][^>]*>/g, " ")
    // image syntax ![alt](url) — drop entirely (alt text is usually a filename, not sentiment)
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    // markdown links [text](url) — keep text, drop the URL half because it is not a useful match cue
    .replace(/\]\([^)]*\)/g, "]")
    // explicit sticker markers (control sequence emitted by the assistant)
    .replace(/\[sticker:[^\]]+\]/gi, " ")
    // collapse all whitespace (newlines, tabs, multiple spaces) into single spaces
    .replace(/\s+/g, " ")
    .trim();
}

/** Build a bounded, natural-language-only query for sticker text matching. */
export function buildStickerMatchQuery(reply: string, userText: string, maxLength = 1000): string {
  return [extractStickerMatchText(reply), extractStickerMatchText(userText)]
    .filter(Boolean)
    .join("\n")
    .slice(0, maxLength);
}
