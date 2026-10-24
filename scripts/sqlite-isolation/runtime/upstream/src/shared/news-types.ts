/** 项目公告：主进程从远端取回的消息条目与版本信息 */

export interface NewsItem {
  /** 条目 id，用于记录已读；默认取日期，重复或缺失时退到序号 */
  id: string;
  /** 条目日期，形如 2026-09-26；公告没写时为空 */
  date: string;
  /** 条目标题 */
  title: string;
  /** 条目正文（Markdown） */
  body: string;
}

export interface NewsPayload {
  locale: string;
  /** 公告条目，顺序与远端文件里出现的顺序一致 */
  items: NewsItem[];
  /** 内容版本：公告里显式声明的标记优先，否则为正文指纹 */
  version: string;
  /** 最近一次成功拉取的时间戳（毫秒） */
  fetchedAt: number;
}

export interface NewsResult extends NewsPayload {
  ok: boolean;
  /** 拉取失败的原因，成功时为空 */
  error: string;
}

/** 渲染端通过 contextBridge 暴露的 window.news */
export interface NewsApi {
  /** 取指定语言的公告条目；主进程内部有缓存，没有缓存时才真正发起请求 */
  get: (locale: string) => Promise<NewsResult>;
  /** 主进程定时比对到新版本时推送；返回取消订阅函数 */
  onUpdated: (callback: (payload: NewsPayload) => void) => () => void;
}