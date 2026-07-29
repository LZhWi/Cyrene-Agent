/**
 * Cline 适配层 - <think> 跨 chunk 过滤器
 *
 * 处理 MiniMax 双路输出：
 * - reasoning 事件不发送到用户
 * - text 事件中 <think>...</think> 需要过滤
 * - 处理 <thi + nk> 这种跨 chunk 拆分标签
 */

const THINK_OPEN = "<think>";
const THINK_CLOSE = "</think>";
const MAX_TAG_LEN = Math.max(THINK_OPEN.length, THINK_CLOSE.length); // 8

export class ThinkFilter {
  private insideThink = false;
  private buffer = "";

  /**
   * 输入一个文本 chunk，返回应该发送给用户的纯文本。
   */
  process(text: string): string {
    this.buffer += text;
    let output = "";

    while (this.buffer.length > 0) {
      if (this.insideThink) {
        // 在 <think> 块内，寻找 </think>
        const idx = this.buffer.indexOf(THINK_CLOSE);
        if (idx === -1) {
          // 可能是部分 </think> 标签在末尾
          if (this.buffer.length > THINK_CLOSE.length - 1) {
            // 丢弃前面的内容（是 think 内容），只保留可能的标签前缀
            this.buffer = this.buffer.slice(-(THINK_CLOSE.length - 1));
          }
          break;
        }
        // 找到 </think>，跳过 think 内容
        this.buffer = this.buffer.slice(idx + THINK_CLOSE.length);
        this.insideThink = false;
      } else {
        // 在 <think> 块外，寻找 <think>
        const idx = this.buffer.indexOf(THINK_OPEN);
        if (idx === -1) {
          // 检查末尾是否有 <think> 的部分前缀
          const partialLen = this.findPartialTagPrefix(this.buffer, THINK_OPEN);
          if (partialLen > 0) {
            // 输出除了部分前缀以外的内容
            output += this.buffer.slice(0, this.buffer.length - partialLen);
            this.buffer = this.buffer.slice(-partialLen);
          } else {
            // 没有部分前缀，输出全部
            output += this.buffer;
            this.buffer = "";
          }
          break;
        }
        // 输出 <think> 之前的内容
        output += this.buffer.slice(0, idx);
        this.buffer = this.buffer.slice(idx + THINK_OPEN.length);
        this.insideThink = true;
      }
    }

    return output;
  }

  /**
   * flush 剩余 buffer（消息结束时调用）。
   */
  flush(): string {
    let output = "";
    if (!this.insideThink && this.buffer.length > 0) {
      output = this.buffer;
    }
    this.buffer = "";
    this.insideThink = false;
    return output;
  }

  /**
   * 检查 text 末尾是否匹配 tag 的部分前缀。
   * 例如 text="abc<thi" tag="<think>" 返回 4（匹配 "<thi"）。
   * 如果没有匹配返回 0。
   */
  private findPartialTagPrefix(text: string, tag: string): number {
    // 从最长可能的前缀开始检查
    const maxCheck = Math.min(text.length, tag.length - 1);
    for (let len = maxCheck; len > 0; len--) {
      if (text.endsWith(tag.slice(0, len))) {
        return len;
      }
    }
    return 0;
  }
}
