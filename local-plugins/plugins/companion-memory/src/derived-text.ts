const HIDDEN_TAG = /<\/?(think|soul|analysis|reasoning)\b[^>]*>/gi;

/** Only use for assistant text projected into memory prompts or evidence. Stored messages stay intact. */
export function stripAssistantHiddenText(text: string): string {
  let visible = "";
  let cursor = 0;
  const hidden: string[] = [];
  for (const match of text.matchAll(HIDDEN_TAG)) {
    const start = match.index;
    if (!hidden.length) visible += text.slice(cursor, start);
    const tag = match[1].toLowerCase();
    if (match[0].startsWith("</")) {
      const index = hidden.lastIndexOf(tag);
      if (index >= 0) hidden.length = index;
      else if (!hidden.length) visible += match[0];
    } else hidden.push(tag);
    cursor = start + match[0].length;
  }
  return hidden.length ? visible : visible + text.slice(cursor);
}
