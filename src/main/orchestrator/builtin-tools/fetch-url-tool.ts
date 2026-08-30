// ── 工具 1：fetch_url ─────────────────────────────────────
// 拉一个 URL 的纯文本 / Markdown 形式的 body，给 agent 读 README 用
//
// 原样迁自 built-in-tools.ts（纯搬移，逻辑未改）。注册方式调整：本模块导出
// fetchUrlTool 常量，由 built-in-tools.ts facade 在原注册位置统一 toolRegistry.register，
// 显式保证 registry 插入顺序（= 工具目录 prompt 生成顺序，门禁见
// built-in-tools.snapshot.test.ts）。

import TurndownService from "turndown";
import type { ToolDefinition } from "../tool-registry";
import type { ToolContext } from "../tool-context";

const LOG_PREFIX = "[BuiltinTools]";

// ── 工具 1：fetch_url ─────────────────────────────────────
// 拉一个 URL 的纯文本 / Markdown 形式的 body，给 agent 读 README 用

const FETCH_TIMEOUT_MS = 20_000;
const FETCH_MAX_BYTES = 512 * 1024; // 单次最多 512KB，防止 LLM 上下文爆炸

// HTML → Markdown 清洗：用 turndown 转成 LLM 最易理解的 markdown 格式
// 保留标题层级/列表/代码块/表格/链接，比纯 strip 标签信息量大得多
// （turndown import 已上移到文件头部）

const turndown = new TurndownService({
  headingStyle: "atx",        // <h1>→# <h2>→##
  codeBlockStyle: "fenced",   // <pre><code>→```围栏代码块（LLM 更认）
  bulletListMarker: "-",
  emDelimiter: "*",           // <em>→*斜体*
});

function stripHtml(html: string): string {
  // 先去 script/style/注释（turndown 不会自动去这些，留着会污染 markdown）
  let s = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  // 转 markdown（保留结构），失败则退回纯 strip 标签
  try {
    const md = turndown.turndown(s);
    // 压缩多余空行（turndown 有时会留连续空行）
    return md.replace(/\n{3,}/g, "\n\n").trim();
  } catch {
    // turndown 解析失败（畸形 HTML），退回原来的纯标签剥离
    s = s.replace(/<[^>]+>/g, " ");
    s = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    return s.replace(/[ \t]+/g, " ").replace(/\s*\n\s*/g, "\n").trim();
  }
}

async function executeFetchUrl(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const url = String(args.url || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return "[错误] url 必须以 http:// 或 https:// 开头";
  }
  const asMarkdown = args.format === "markdown" || args.format === undefined;
  console.log(LOG_PREFIX, "fetch_url:", url, "format=" + (asMarkdown ? "markdown" : "raw"));

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
  // 组合父 signal 和超时 signal
  const combinedSignal = ctx?.signal ? AbortSignal.any([ctx.signal, ac.signal]) : ac.signal;
  try {
    const resp = await fetch(url, {
      signal: combinedSignal,
      headers: {
        "User-Agent": "Mozilla/5.0 (Cyrene Agent) Chrome/120 Safari/537.36",
        Accept: "text/html,text/markdown,text/plain,*/*;q=0.8",
      },
      redirect: "follow",
    });
    if (!resp.ok) {
      return "[错误] HTTP " + resp.status + " " + resp.statusText;
    }
    const ctype = resp.headers.get("content-type") || "";
    const buf = await resp.arrayBuffer();
    const truncated = buf.byteLength > FETCH_MAX_BYTES;
    const slice = truncated ? buf.slice(0, FETCH_MAX_BYTES) : buf;
    let text = new TextDecoder("utf-8").decode(slice);
    if (asMarkdown && /text\/html|application\/xhtml/i.test(ctype)) {
      text = stripHtml(text);
    }
    const meta = "URL: " + url + "\nContent-Type: " + ctype + (truncated ? "\n[已截断到 " + FETCH_MAX_BYTES + " 字节]" : "") + "\n\n";
    return meta + text;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return "[错误] fetch 失败: " + msg;
  } finally {
    clearTimeout(timer);
  }
}

export const fetchUrlTool: ToolDefinition = {
  id: "fetch_url",
  name: "读取网页",
  description:
    "下载指定 URL 的网页内容并返回正文。HTML 会用 turndown 转成结构化 markdown" +
    "（保留标题/列表/代码块/表格），便于阅读。\n\n" +
    "何时用：\n" +
    "- 用户给了明确的网址（https://...），想看内容\n" +
    "- 用户说'看看这个链接''读一下这个网页'\n" +
    "- 需要读 GitHub README、MCP 安装文档、API 文档等具体页面\n" +
    "- web_search 之后拿到链接，想看具体内容\n\n" +
    "不要用于：\n" +
    "- 用户只给关键词没给网址 → 用 web_search\n" +
    "- 用户问'今天有什么新闻' → 用 web_search\n" +
    "- 本地文件路径 → 用 read_file\n\n" +
    "参数：url (必填，完整 http(s) 地址)，format (可选 markdown|raw，默认 markdown)。",
  enabled: true,
  risk: "network",
  effectKind: "read" as const,
  verificationPolicy: "none" as const,
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "要拉取的完整 URL（必须包含 https:// 或 http://）" },
      format: { type: "string", description: "markdown=自动清洗 HTML 为纯文本（默认）；raw=原文不处理" },
    },
    required: ["url"],
  },
  execute: executeFetchUrl,
};

