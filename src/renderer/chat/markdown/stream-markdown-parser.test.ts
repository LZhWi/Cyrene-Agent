/**
 * stream-markdown-parser 单元测试
 *
 * 模拟把内容拆成很小的 chunk（逐字符），验证围栏检测状态机。
 */

import { describe, expect, test } from "vitest";
import { createStreamMarkdownParser, type StreamAction } from "./stream-markdown-parser";

/** 辅助：逐字符喂入，收集所有 action */
function feedByChar(text: string): StreamAction[] {
  const parser = createStreamMarkdownParser();
  const actions: StreamAction[] = [];
  for (const char of text) {
    actions.push(...parser.push(char));
  }
  actions.push(...parser.flush());
  return actions;
}

/** 辅助：按指定大小拆 chunk */
function feedByChunks(text: string, chunkSize: number): StreamAction[] {
  const parser = createStreamMarkdownParser();
  const actions: StreamAction[] = [];
  for (let i = 0; i < text.length; i += chunkSize) {
    for (const char of text.slice(i, i + chunkSize)) {
      actions.push(...parser.push(char));
    }
  }
  actions.push(...parser.flush());
  return actions;
}

/** 辅助：从 actions 提取纯文本（text_char + code_char 合并） */
function actionsToText(actions: StreamAction[]): string {
  let text = "";
  for (const a of actions) {
    if (a.type === "text_char" || a.type === "code_char") text += a.char;
  }
  return text;
}

describe("stream-markdown-parser", () => {
  test("纯文本原样输出", () => {
    const actions = feedByChar("Hello World");
    expect(actions.every(a => a.type === "text_char")).toBe(true);
    expect(actionsToText(actions)).toBe("Hello World");
  });

  test("检测到 ```ts 开头：发出 code_start", () => {
    const actions = feedByChar("```ts\n");
    const start = actions.find(a => a.type === "code_start");
    expect(start).toBeDefined();
    expect((start as { type: string; lang: string }).lang).toBe("ts");
  });

  test("代码块内容走 code_char", () => {
    const actions = feedByChar("```ts\nconst x = 1;\n```");
    const codeChars = actions.filter(a => a.type === "code_char");
    expect(codeChars.length).toBeGreaterThan(0);
    const codeText = codeChars.map(a => (a as { char: string }).char).join("");
    expect(codeText).toContain("const x = 1;");
  });

  test("检测到闭合 ```：发出 code_end", () => {
    const actions = feedByChar("```ts\ncode\n```");
    const end = actions.find(a => a.type === "code_end");
    expect(end).toBeDefined();
  });

  test("闭合后恢复正常文本", () => {
    const actions = feedByChar("```ts\ncode\n```\n正文字本");
    const afterEnd = actions.slice(actions.findIndex(a => a.type === "code_end") + 1);
    expect(afterEnd.some(a => a.type === "text_char" && a.char === "正")).toBe(true);
  });

  test("完整示例：文本 + 代码 + 文本", () => {
    const text = "下面是示例：\n\n```typescript\nconst x = 1;\n```\n\n结束";
    const actions = feedByChar(text);
    const starts = actions.filter(a => a.type === "code_start");
    const ends = actions.filter(a => a.type === "code_end");
    expect(starts.length).toBe(1);
    expect(ends.length).toBe(1);
    expect((starts[0] as { lang: string }).lang).toBe("typescript");
  });

  test("跨 chunk 拆分 ``` 标签", () => {
    const text = "```ts\ncode\n```";
    const actions1 = feedByChunks(text, 2);
    const actions2 = feedByChunks(text, 3);
    expect(actions1.some(a => a.type === "code_start")).toBe(true);
    expect(actions1.some(a => a.type === "code_end")).toBe(true);
    expect(actions2.some(a => a.type === "code_start")).toBe(true);
    expect(actions2.some(a => a.type === "code_end")).toBe(true);
  });

  test("逐字符拆分整个代码块", () => {
    const text = "```python\nprint('hello')\n```";
    const actions = feedByChar(text);
    expect(actions.some(a => a.type === "code_start")).toBe(true);
    expect(actions.some(a => a.type === "code_end")).toBe(true);
  });

  test("无语言标记的代码块", () => {
    const actions = feedByChar("```\nplain code\n```");
    const start = actions.find(a => a.type === "code_start");
    expect(start).toBeDefined();
    expect((start as { lang: string }).lang).toBe("");
  });

  test("正文中的反引号不触发代码块", () => {
    const actions = feedByChar("这是 `inline code` 文本");
    expect(actions.some(a => a.type === "code_start")).toBe(false);
    expect(actionsToText(actions)).toBe("这是 `inline code` 文本");
  });

  test("行中的 ``` 不触发代码块（不在行首）", () => {
    const actions = feedByChar("文本 ```\nmore");
    expect(actions.some(a => a.type === "code_start")).toBe(false);
  });

  test("未闭合代码块：flush 不丢失内容", () => {
    const parser = createStreamMarkdownParser();
    const actions: StreamAction[] = [];
    for (const char of "```ts\nconst x = 1;") {
      actions.push(...parser.push(char));
    }
    actions.push(...parser.flush());
    // 应该有 code_start
    expect(actions.some(a => a.type === "code_start")).toBe(true);
    // 代码内容应该在 code_char 中
    const codeText = actions
      .filter(a => a.type === "code_char")
      .map(a => (a as { char: string }).char)
      .join("");
    expect(codeText).toContain("const x = 1;");
  });

  test("多个代码块", () => {
    const text = "```ts\ncode1\n```\n中间文本\n```py\ncode2\n```";
    const actions = feedByChar(text);
    const starts = actions.filter(a => a.type === "code_start");
    const ends = actions.filter(a => a.type === "code_end");
    expect(starts.length).toBe(2);
    expect(ends.length).toBe(2);
    expect((starts[0] as { lang: string }).lang).toBe("ts");
    expect((starts[1] as { lang: string }).lang).toBe("py");
  });

  test("isInCodeBlock 反映当前状态", () => {
    const parser = createStreamMarkdownParser();
    expect(parser.isInCodeBlock()).toBe(false);
    for (const char of "```ts\n") {
      parser.push(char);
    }
    expect(parser.isInCodeBlock()).toBe(true);
    for (const char of "code\n```") {
      parser.push(char);
    }
    expect(parser.isInCodeBlock()).toBe(false);
  });

  test("代码块中的反引号不触发闭合（不够 3 个）", () => {
    const text = "```ts\nconst s = `template`\n```";
    const actions = feedByChar(text);
    const ends = actions.filter(a => a.type === "code_end");
    expect(ends.length).toBe(1); // 只在最后的 ``` 闭合
  });

  test("空消息", () => {
    const actions = feedByChar("");
    expect(actions.length).toBe(0);
  });

  test("只有换行", () => {
    const actions = feedByChar("\n\n\n");
    expect(actions.every(a => a.type === "text_char")).toBe(true);
    expect(actionsToText(actions)).toBe("\n\n\n");
  });
});
