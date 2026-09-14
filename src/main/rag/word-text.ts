const WordExtractor = require("word-extractor") as new () => {
  extract(source: Buffer): Promise<{
    getBody(options?: { filterUnicode?: boolean }): string;
    getFootnotes(options?: { filterUnicode?: boolean }): string;
    getEndnotes(options?: { filterUnicode?: boolean }): string;
  }>;
};

export const WORD_EXTENSIONS = new Set([".doc", ".docx"]);

export function isWordDocumentExt(ext: string): boolean {
  return WORD_EXTENSIONS.has(ext.toLowerCase());
}

function appendSection(parts: string[], label: string, text: string): void {
  const normalized = text.replace(/\r\n?/g, "\n").trim();
  if (normalized) parts.push(label ? `${label}\n${normalized}` : normalized);
}

export async function extractWordDocumentText(buffer: Buffer): Promise<string> {
  try {
    const document = await new WordExtractor().extract(buffer);
    const parts: string[] = [];
    appendSection(parts, "", document.getBody({ filterUnicode: false }));
    appendSection(parts, "【脚注】", document.getFootnotes({ filterUnicode: false }));
    appendSection(parts, "【尾注】", document.getEndnotes({ filterUnicode: false }));
    return parts.join("\n\n").trim();
  } catch (error) {
    throw new Error(`Word 文档解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
}
