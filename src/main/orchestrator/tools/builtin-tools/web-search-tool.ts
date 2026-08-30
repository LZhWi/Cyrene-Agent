// ── 工具：web_search（博查搜索）─────────────────────────
// 联网搜索：给关键词，返回搜索结果（标题/链接/摘要）。博查 API 返回 AI 友好的结构化数据。
// key 通过 setSearchConfig 注入（避免 import index.ts 造成循环依赖）。
//
// 原样迁自 built-in-tools.ts（纯搬移，逻辑未改）。注册方式调整：本模块导出
// webSearchTool 常量，由 built-in-tools.ts facade 在原注册位置统一 toolRegistry.register，
// 显式保证 registry 插入顺序（= 工具目录 prompt 生成顺序，门禁见
// built-in-tools.snapshot.test.ts）。

import type { ToolDefinition } from "../registry/tool-registry";
import type { ToolContext } from "../registry/tool-context";

// ── 工具 5：web_search（博查搜索）─────────────────────────
// 联网搜索：给关键词，返回搜索结果（标题/链接/摘要）。博查 API 返回 AI 友好的结构化数据。
// key 通过 setSearchConfig 注入（避免 import index.ts 造成循环依赖）。

const SEARCH_TIMEOUT_MS = 20_000;

/** 注入的搜索配置获取器。 */
let searchEngineGetter: (() => string) | null = null;
let searchBochaKeyGetter: (() => string) | null = null;
let searchTavilyKeyGetter: (() => string) | null = null;
let searchAnySearchKeyGetter: (() => string) | null = null;

/**
 * index.ts 启动时调用，注入搜索引擎/各源key 的读取器。
 * engine: "off" | "bocha" | "tavily" | "volcano" | "minimax"
 */
export function setSearchConfig(
  engineGetter: () => string,
  bochaKeyGetter: () => string,
  tavilyKeyGetter: () => string,
  anySearchKeyGetter: () => string,
): void {
  searchEngineGetter = engineGetter;
  searchBochaKeyGetter = bochaKeyGetter;
  searchTavilyKeyGetter = tavilyKeyGetter;
  searchAnySearchKeyGetter = anySearchKeyGetter;
}

interface BochaResult {
  name: string;
  url: string;
  snippet: string;
  summary?: string;
  siteName?: string;
}

/** 搜索结果统一结构 */
interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  source?: string;
}

/** 搜索输出统一结构（ToolCallResult.output 的 JSON） */
interface WebSearchOutput {
  success: true;
  query: string;
  resultCount: number;
  results: WebSearchResult[];
}

/** snippet 最大长度 */
const MAX_SNIPPET_LEN = 500;

/** 截断 snippet */
function truncateSnippet(text: string): string {
  const clean = text.replace(/\s+/g, " ").trim();
  return clean.length > MAX_SNIPPET_LEN ? clean.slice(0, MAX_SNIPPET_LEN) + "..." : clean;
}

/** 博查搜索：调 /v1/web-search，返回结构化 JSON。 */
async function bochaSearch(query: string, key: string, signal?: AbortSignal): Promise<string> {
  const url = "https://api.bochaai.com/v1/web-search";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
  // 组合父 signal 和超时 signal
  const combinedSignal = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
  try {
    const resp = await fetch(url, {
      method: "POST",
      signal: combinedSignal,
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        query,
        count: 8,
        summary: true,
      }),
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const raw = await resp.json() as {
      webPages?: { value?: BochaResult[] };
      data?: { webPages?: { value?: BochaResult[] } };
    };
    const bochaResults = raw.data?.webPages?.value ?? raw.webPages?.value ?? [];
    const results: WebSearchResult[] = bochaResults.map((r) => ({
      title: r.name,
      url: r.url,
      snippet: truncateSnippet(r.summary || r.snippet || ""),
      ...(r.siteName ? { source: r.siteName } : {}),
    }));
    const output: WebSearchOutput = {
      success: true,
      query,
      resultCount: results.length,
      results,
    };
    return JSON.stringify(output);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`搜索失败：${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

/** Tavily 搜索：调 /search，返回结构化 JSON。 */
async function tavilySearch(query: string, key: string, signal?: AbortSignal): Promise<string> {
  const url = "https://api.tavily.com/search";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
  // 组合父 signal 和超时 signal
  const combinedSignal = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
  try {
    const resp = await fetch(url, {
      method: "POST",
      signal: combinedSignal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        api_key: key,
        query,
        max_results: 8,
        include_answer: true,
      }),
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const data = await resp.json() as {
      answer?: string;
      results?: Array<{ title: string; url: string; content: string }>;
    };
    const tavilyResults = data.results ?? [];
    const results: WebSearchResult[] = tavilyResults.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: truncateSnippet(data.answer && r.content ? `${data.answer}\n${r.content}` : r.content || ""),
    }));
    const output: WebSearchOutput = {
      success: true,
      query,
      resultCount: results.length,
      results,
    };
    return JSON.stringify(output);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`搜索失败：${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

/** AnySearch 搜索：调 /v1/search，返回结构化 JSON。 */
async function anySearchSearch(query: string, key: string, signal?: AbortSignal): Promise<string> {
  const url = "https://api.anysearch.com/v1/search";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), SEARCH_TIMEOUT_MS);
  // 组合父 signal 和超时 signal
  const combinedSignal = signal ? AbortSignal.any([signal, ctrl.signal]) : ctrl.signal;
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (key) headers.Authorization = `Bearer ${key}`;
  try {
    const resp = await fetch(url, {
      method: "POST",
      signal: combinedSignal,
      headers,
      body: JSON.stringify({
        query,
        max_results: 8,
      }),
    });
    if (!resp.ok) {
      throw new Error(`HTTP ${resp.status}`);
    }
    const data = await resp.json() as {
      data: { results?: Array<{ title: string; url: string; content: string; snippet: string }> };
    };
    const rawResults = data.data.results ?? [];
    const results: WebSearchResult[] = rawResults.map((r) => ({
      title: r.title,
      url: r.url,
      snippet: truncateSnippet(r.content || r.snippet || ""),
    }));
    const output: WebSearchOutput = {
      success: true,
      query,
      resultCount: results.length,
      results,
    };
    return JSON.stringify(output);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`搜索失败：${msg}`);
  } finally {
    clearTimeout(timer);
  }
}

async function executeWebSearch(args: Record<string, unknown>, ctx?: ToolContext): Promise<string> {
  const engine = searchEngineGetter?.() ?? "off";
  if (engine === "off") {
    throw new Error("E_SEARCH_NOT_ENABLED");
  }

  const query = String(args.query ?? "").trim();
  if (!query) {
    throw new Error("E_SEARCH_QUERY_EMPTY");
  }

  if (engine === "bocha") {
    const key = searchBochaKeyGetter?.() ?? "";
    if (!key) {
      throw new Error("E_SEARCH_KEY_MISSING");
    }
    return bochaSearch(query, key, ctx?.signal);
  }

  if (engine === "tavily") {
    const key = searchTavilyKeyGetter?.() ?? "";
    if (!key) {
      throw new Error("E_SEARCH_KEY_MISSING");
    }
    return tavilySearch(query, key, ctx?.signal);
  }

  if (engine === "anySearch") {
    const key = searchAnySearchKeyGetter?.() ?? "";
    return anySearchSearch(query, key, ctx?.signal);
  }
  throw new Error(`E_SEARCH_ENGINE_NOT_SUPPORTED:${engine}`);
}

export const webSearchTool: ToolDefinition = {
  id: "web_search",
  name: "联网搜索",
  description:
    "搜索互联网获取实时信息。返回搜索结果的标题、链接和摘要。\n\n" +
    "何时用：\n" +
    "- 用户问'最近有什么新闻''搜一下 xxx 怎么用''xxx 是什么'\n" +
    "- 用户问的事需要联网才能知道（股价、赛事、最新技术）\n" +
    "- 用户只给关键词，没给具体网址\n\n" +
    "不要用于：\n" +
    "- 用户已经给了明确网址 -> 用 fetch_url\n" +
    "- 用户问本机文件 -> read_file / list_dir\n" +
    "- 能凭已有知识直接回答的简单问题\n\n" +
    "参数：query（必填，搜索关键词）。",
  enabled: true,
  risk: "network",
  effectKind: "read" as const,
  verificationPolicy: "none" as const,
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "搜索关键词" },
    },
    required: ["query"],
  },
  execute: executeWebSearch,
};

