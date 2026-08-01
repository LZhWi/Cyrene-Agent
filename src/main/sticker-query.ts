import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({ html: false, breaks: true });

/**
 * 将聊天内容压缩成适合贴纸语义匹配的自然语言。
 *
 * 贴纸只应反映对话情绪/意图；代码与数学表达式会给 embedding 带来大量无关 token，
 * 因此在调用 embedding provider 前直接剔除，而非尝试解释或转写它们。
 */
export function extractStickerEmbeddingText(source: string): string {
  if (!source.trim()) return "";

  const withoutNonNaturalContent = source
    // fenced code blocks (both Markdown fence styles)
    .replace(/(?:^|\n)[ \t]*```[\s\S]*?```[ \t]*(?=\n|$)/g, "\n")
    .replace(/(?:^|\n)[ \t]*~~~[\s\S]*?~~~[ \t]*(?=\n|$)/g, "\n")
    // display and inline TeX math
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\\\[[\s\S]*?\\\]/g, " ")
    .replace(/\\\([\s\S]*?\\\)/g, " ")
    .replace(/\$(?:\\.|[^$\r\n])+\$/g, " ");

  const fragments: string[] = [];
  for (const token of markdown.parse(withoutNonNaturalContent, {})) {
    if (token.type !== "inline" || !token.children) continue;
    for (const child of token.children) {
      // Inline code, raw HTML and links' URLs must never influence matching.
      if (child.type === "code_inline" || child.type === "html_inline") continue;
      if (child.type === "text" || child.type === "softbreak" || child.type === "hardbreak") {
        fragments.push(child.content);
      }
    }
  }

  return fragments
    .join(" ")
    .replace(/\[sticker:[^\]]+\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Build the bounded, natural-language-only query sent to the embedding provider. */
export function buildStickerEmbeddingQuery(reply: string, userText: string, maxLength = 1000): string {
  return [extractStickerEmbeddingText(reply), extractStickerEmbeddingText(userText)]
    .filter(Boolean)
    .join("\n")
    .slice(0, maxLength);
}
