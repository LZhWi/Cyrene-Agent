/**
 * 流式 Markdown 围栏检测状态机。
 *
 * Phase 3：只在流式期识别 fenced code block 围栏（```lang / ```），
 * 不做完整 Markdown 解析。检测到围栏后通知调用方创建代码块容器。
 *
 * 生命周期：按单条 assistant message（TEXT_MESSAGE_START ~ END）隔离。
 * 终态时全部销毁，以 raw markdown 重新完整渲染。
 *
 * 设计：
 * - 逐字符输入，输出动作事件（text_char / code_start / code_char / code_end）
 * - 只在行首遇到 ``` 时才进入代码模式
 * - 非 ``` 开头的行原样输出，不缓冲整行（避免延迟）
 * - 行首遇到 ` 时缓冲到能判断是否是 ```，不是则立即 flush
 */

/** 流式解析动作 */
export type StreamAction =
  | { type: "text_char"; char: string }
  | { type: "code_start"; lang: string }
  | { type: "code_char"; char: string }
  | { type: "code_end" };

/** 解析器状态 */
type ParserState = "text" | "buffering_fence" | "collecting_lang" | "code" | "buffering_close";

export interface StreamMarkdownParser {
  /** 输入一个字符，返回 0~N 个动作 */
  push(char: string): StreamAction[];
  /** 流结束，flush 残留状态 */
  flush(): StreamAction[];
  /** 当前是否在代码块内 */
  isInCodeBlock(): boolean;
}

export function createStreamMarkdownParser(): StreamMarkdownParser {
  let state: ParserState = "text";
  let atLineStart = true;
  let buffer = "";        // 缓冲可能的 ``` 或语言名
  let backtickCount = 0;  // 连续 ` 计数

  function resetLineState(): void {
    atLineStart = false;
  }

  return {
    push(char: string): StreamAction[] {
      const actions: StreamAction[] = [];

      // 换行符特殊处理
      if (char === "\n") {
        return handleNewline(actions);
      }

      switch (state) {
        case "text":
          return handleTextChar(char, actions);

        case "buffering_fence":
          return handleBufferingFence(char, actions);

        case "collecting_lang":
          return handleCollectingLang(char, actions);

        case "code":
          return handleCodeChar(char, actions);

        case "buffering_close":
          return handleBufferingClose(char, actions);
      }

      return actions;
    },

    flush(): StreamAction[] {
      const actions: StreamAction[] = [];

      switch (state) {
        case "buffering_fence":
          // 行首的 ` 不是围栏，输出缓冲
          for (const c of buffer) actions.push({ type: "text_char", char: c });
          break;

        case "collecting_lang":
          // ``` 后没有换行就结束了，当作普通文本输出
          for (const c of "```" + buffer) actions.push({ type: "text_char", char: c });
          break;

        case "code":
          // 代码块未闭合，保持代码模式（不主动关闭）
          // 终态渲染会以 raw markdown 重新处理
          break;

        case "buffering_close":
          // 代码中的 ` 不是闭合围栏，作为代码输出
          for (const c of buffer) actions.push({ type: "code_char", char: c });
          break;
      }

      buffer = "";
      backtickCount = 0;
      return actions;
    },

    isInCodeBlock(): boolean {
      return state === "code" || state === "buffering_close";
    },
  };

  // ── 状态处理函数 ──────────────────────────────────────────

  function handleNewline(actions: StreamAction[]): StreamAction[] {
    switch (state) {
      case "text":
        actions.push({ type: "text_char", char: "\n" });
        atLineStart = true;
        break;

      case "buffering_fence":
        // 行首的 ` 不是围栏（不够 3 个），输出缓冲 + 换行
        for (const c of buffer) actions.push({ type: "text_char", char: c });
        actions.push({ type: "text_char", char: "\n" });
        buffer = "";
        backtickCount = 0;
        atLineStart = true;
        break;

      case "collecting_lang": {
        // ```lang\n -> 进入代码模式
        const lang = buffer.trim();
        actions.push({ type: "code_start", lang });
        buffer = "";
        backtickCount = 0;
        state = "code";
        atLineStart = true;
        break;
      }

      case "code":
        actions.push({ type: "code_char", char: "\n" });
        atLineStart = true;
        break;

      case "buffering_close":
        // 代码中的 ` 不是闭合围栏
        for (const c of buffer) actions.push({ type: "code_char", char: c });
        actions.push({ type: "code_char", char: "\n" });
        buffer = "";
        backtickCount = 0;
        state = "code";
        atLineStart = true;
        break;
    }

    return actions;
  }

  function handleTextChar(char: string, actions: StreamAction[]): StreamAction[] {
    if (atLineStart && char === "`") {
      // 可能是围栏开始，进入缓冲
      state = "buffering_fence";
      buffer = "`";
      backtickCount = 1;
      atLineStart = false;
    } else {
      actions.push({ type: "text_char", char });
      atLineStart = false;
    }
    return actions;
  }

  function handleBufferingFence(char: string, actions: StreamAction[]): StreamAction[] {
    if (char === "`") {
      buffer += "`";
      backtickCount++;
      if (backtickCount >= 3) {
        // 检测到 ```，开始收集语言名
        state = "collecting_lang";
        buffer = ""; // 清空，开始收集 lang
      }
    } else {
      // 不是围栏，输出缓冲 + 当前字符
      for (const c of buffer) actions.push({ type: "text_char", char: c });
      actions.push({ type: "text_char", char });
      buffer = "";
      backtickCount = 0;
      state = "text";
    }
    return actions;
  }

  function handleCollectingLang(char: string, actions: StreamAction[]): StreamAction[] {
    // 收集语言名直到换行
    buffer += char;
    return actions;
  }

  function handleCodeChar(char: string, actions: StreamAction[]): StreamAction[] {
    if (atLineStart && char === "`") {
      // 可能是闭合围栏
      state = "buffering_close";
      buffer = "`";
      backtickCount = 1;
      atLineStart = false;
    } else {
      actions.push({ type: "code_char", char });
      atLineStart = false;
    }
    return actions;
  }

  function handleBufferingClose(char: string, actions: StreamAction[]): StreamAction[] {
    if (char === "`") {
      buffer += "`";
      backtickCount++;
      if (backtickCount >= 3) {
        // 检测到闭合 ```
        buffer = "";
        backtickCount = 0;
        state = "text";
        atLineStart = true;
        actions.push({ type: "code_end" });
      }
    } else {
      // 不是闭合围栏，输出缓冲 + 当前字符作为代码
      for (const c of buffer) actions.push({ type: "code_char", char: c });
      actions.push({ type: "code_char", char });
      buffer = "";
      backtickCount = 0;
      state = "code";
    }
    return actions;
  }
}
