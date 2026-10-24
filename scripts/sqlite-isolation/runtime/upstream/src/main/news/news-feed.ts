/**
 * 项目公告：把 Gitee 仓库里的一段 Markdown 文本取回本地。
 *
 * 应用启动后拉一次，之后每 6 小时对一次版本；只有版本变化才通知窗口，
 * 避免频繁打扰。正文渲染、已读记录都在渲染端，这里只负责"取回来"。
 */
import { IPC } from "../../shared/ipc-channels";
import type { NewsItem, NewsPayload, NewsResult } from "../../shared/news-types";
import type { IpcScope } from "../application/ipc-scope";
import { reactChatWindow } from "../windows/window-state";

/** 公告仓库地址：文本文件放在 main 分支根目录下 */
const NEWS_RAW_BASE = "https://gitee.com/playa0/cyrene-announcement/raw/main/";
/** 界面语言 → 仓库里的公告文件名；以后要加语言只在这里补一行 */
const NEWS_FILES: Record<string, string> = {
  "zh-CN": "news.zh-CN.md",
  en: "news.en.md",
};
/** 单次请求超时 */
const NEWS_TIMEOUT_MS = 10_000;
/** 启动拉一次之后，每 6 小时对一次版本 */
const NEWS_POLL_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** 正文上限：仓库里误放大文件时不至于撑爆内存 */
const NEWS_MAX_CHARS = 64 * 1024;
/** 公告可用 <!-- news-version: 20260926 --> 显式声明版本；未声明时退回正文指纹 */
const NEWS_VERSION_PATTERN = /<!--\s*news-version\s*:\s*([^\s>]+)\s*-->/i;
/** 每条消息用 <!-- item: 日期 | 标题 --> 开头，正文里写什么都行 */
const NEWS_ITEM_PATTERN = /<!--\s*item\s*:\s*([^|>]*?)\s*\|\s*([^>]*?)\s*-->/gi;

type NewsFetch = (
  input: string,
  init: { signal: AbortSignal },
) => Promise<{ ok: boolean; status: number; text: () => Promise<string> }>;

interface NewsEntry {
  items: NewsItem[];
  version: string;
  fetchedAt: number;
}

/** 把远端 Markdown 切成一条条消息：认 <!-- item: 日期 | 标题 --> 标记 */
function parseNews(markdown: string): NewsItem[] {
  // 版本标记本身不展示
  const content = markdown.replace(NEWS_VERSION_PATTERN, "").trim();
  if (!content) return [];

  const markers = [...content.matchAll(NEWS_ITEM_PATTERN)];
  if (markers.length === 0) {
    // 没写条目标记时整篇作为一条，卡片只显示正文
    return [{ id: "single", date: "", title: "", body: content }];
  }

  const used = new Set<string>();
  return markers.map((marker, index) => {
    const bodyStart = (marker.index ?? 0) + marker[0].length;
    const bodyEnd = index + 1 < markers.length ? (markers[index + 1].index ?? content.length) : content.length;
    const date = marker[1]?.trim() ?? "";
    const title = marker[2]?.trim() ?? "";
    // 日期即 id；重复或缺失时退到序号，避免两条消息共用一条已读记录
    let id = date || `item-${index + 1}`;
    if (used.has(id)) id = `${id}-${index + 1}`;
    used.add(id);
    return { id, date, title, body: content.slice(bodyStart, bodyEnd).trim() };
  });
}

/** 未声明版本时的正文指纹：改一个字就算新公告 */
function fingerprint(text: string): string {
  let hash = 5381;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0;
  }
  return `h${hash.toString(36)}`;
}

function readVersion(text: string): string {
  return NEWS_VERSION_PATTERN.exec(text)?.[1] ?? fingerprint(text);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function defaultFetch(input: string, init: { signal: AbortSignal }) {
  // electron 在单测环境不可用，延迟到运行时加载
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { net } = require("electron") as typeof import("electron");
  return net.fetch(input, init);
}

export function createNewsFeedService(options: {
  /** 版本变化时把新公告推给渲染端 */
  broadcast: (payload: NewsPayload) => void;
  fetchImpl?: NewsFetch;
  timeoutMs?: number;
  intervalMs?: number;
}) {
  const fetchImpl = options.fetchImpl ?? defaultFetch;
  const timeoutMs = options.timeoutMs ?? NEWS_TIMEOUT_MS;
  const intervalMs = options.intervalMs ?? NEWS_POLL_INTERVAL_MS;
  /** 已成功拉到过的语言，直接给缓存 */
  const cache = new Map<string, NewsEntry>();
  /** 渲染端问过的语言才纳入定时刷新，不拉用户根本用不到的文件 */
  const watched = new Set<string>();
  let timer: ReturnType<typeof setInterval> | null = null;

  async function readRemote(locale: string): Promise<NewsEntry> {
    const file = NEWS_FILES[locale];
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetchImpl(`${NEWS_RAW_BASE}${file}`, { signal: controller.signal });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = (await response.text()).slice(0, NEWS_MAX_CHARS);
      return { items: parseNews(text), version: readVersion(text), fetchedAt: Date.now() };
    } finally {
      clearTimeout(deadline);
    }
  }

  async function poll(): Promise<void> {
    for (const locale of [...watched]) {
      try {
        const next = await readRemote(locale);
        const previous = cache.get(locale);
        cache.set(locale, next);
        // 版本没变就不打扰渲染端，变了才推一次
        if (!previous || previous.version !== next.version) {
          options.broadcast({ locale, ...next });
        }
      } catch {
        // 单次失败保留已有缓存，等下个周期再试
      }
    }
  }

  function startTimer(): void {
    if (timer) return;
    timer = setInterval(() => void poll(), intervalMs);
    // 定时器不阻止进程退出
    timer.unref?.();
  }

  async function get(locale: string): Promise<NewsResult> {
    if (!NEWS_FILES[locale]) {
      return { ok: false, error: `不支持的公告语言：${locale}`, locale, items: [], version: "", fetchedAt: 0 };
    }
    watched.add(locale);
    startTimer();
    const cached = cache.get(locale);
    if (cached) return { ok: true, error: "", locale, ...cached };
    try {
      const entry = await readRemote(locale);
      cache.set(locale, entry);
      return { ok: true, error: "", locale, ...entry };
    } catch (error) {
      return { ok: false, error: errorMessage(error), locale, items: [], version: "", fetchedAt: 0 };
    }
  }

  function dispose(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { get, dispose };
}

/** 注册公告 IPC：渲染端 invoke 取正文，主进程在版本变化时反向推送 */
export function registerNewsIpc(ipc: IpcScope): void {
  const service = createNewsFeedService({
    broadcast: (payload) => {
      const win = reactChatWindow;
      if (!win || win.isDestroyed()) return;
      win.webContents.send(IPC.NEWS_UPDATED, payload);
    },
  });
  ipc.handle(IPC.NEWS_GET, (_event, locale: unknown) =>
    service.get(typeof locale === "string" && locale ? locale : "zh-CN"),
  );
}