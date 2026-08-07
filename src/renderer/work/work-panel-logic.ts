/**
 * Work 面板纯逻辑层（无 DOM / 无样式依赖，可在 node 环境单测）。
 *
 * work-panel.ts 的 mountWorkPanel 消费这里的函数；渲染相关代码全部留在装配层。
 */
import type { WorkRunAttachment, WorkSession } from "../../shared/work-types";

export type PendingAttachment = {
  name: string;
  kind: "document" | "image" | "unsupported";
  filePath?: string;
  mime?: string;
  reason?: string;
};

export type ProcessedDocument = {
  name: string;
  kind: "text" | "indexed" | "empty" | "unsupported" | "error";
  text?: string;
  reason?: string;
  retrievedChunks?: Array<{ text: string; fileName?: string; chunkIndex?: number }>;
};

export function formatTime(value: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  }).format(value);
}

export function planStepLabel(status: string): string {
  if (status === "completed") return "完成";
  if (status === "running") return "进行中";
  if (status === "failed") return "失败";
  return "待处理";
}

export function attachmentKindLabel(kind: "document" | "image" | "unsupported"): string {
  return kind === "image" ? "图片" : kind === "document" ? "文档" : "不支持";
}

/** code/learn 会话在会话列表里显示的模式角标；work 模式无角标。 */
export function sessionModeBadge(mode: string | undefined): { icon: string; title: string } | null {
  if (mode === "code") return { icon: "💻", title: "Code 模式" };
  if (mode === "learn") return { icon: "📖", title: "Learn 模式" };
  return null;
}

export type WorkPanelMode = "work" | "code" | "learn";

/**
 * 会话列表按当前模式过滤：旧数据缺 mode 字段视为 work。
 * 保持 updatedAt 排序由调用方传入顺序决定，这里只做筛选。
 */
export function sessionsForMode<T extends { mode?: string }>(sessions: T[], mode: WorkPanelMode): T[] {
  return sessions.filter((session) => (session.mode ?? "work") === mode);
}

/** 空态文案随模式变化：work/code/learn 各自一句。 */
export function emptyStateCopyFor(mode: WorkPanelMode): { title: string; detail: string } {
  if (mode === "code") {
    return { title: "开始一项代码工作", detail: "绑定代码目录后，可只读分析目录内的代码。" };
  }
  if (mode === "learn") {
    return { title: "开始一项学习任务", detail: "绑定笔记或学习材料目录后，可获得讲解与练习。" };
  }
  return { title: "开始一项独立工作", detail: "这里不会读取聊天或主动消息的历史与记忆。" };
}

/** 会话标题下的提示文案：code/learn 展示绑定目录状态，work 展示隔离说明。 */
export function sessionHintFor(session: WorkSession | null): { text: string; title: string } {
  const mode = session?.mode;
  if (mode === "code" || mode === "learn") {
    const label = mode === "code" ? "💻 Code 模式" : "📖 Learn 模式";
    const dir = session?.boundDir
      ? `绑定：${session.boundDir}`
      : "未绑定目录（文件工具不可用）";
    return { text: `${label} · 只读 · ${dir}`, title: session?.boundDir ?? "" };
  }
  return { text: "独立历史 · 独立记忆 · 严格工作流", title: "" };
}

export interface AttachmentProcessor {
  processDocuments(filePaths: string[], query: string): Promise<ProcessedDocument[]>;
  captionImage(filePath: string): Promise<{ ok: boolean; caption?: string; error?: string }>;
}

/**
 * 把待发送附件转成 run 入参：文档走索引/全文抽取，图片走 VLM 描述，
 * 不支持的格式原样标 error。失败项保留 reason 供会话侧展示。
 */
export async function prepareRunAttachments(
  files: PendingAttachment[],
  processor: AttachmentProcessor,
  query: string,
): Promise<WorkRunAttachment[]> {
  const prepared: WorkRunAttachment[] = [];
  const documents = files.filter((file) => file.kind === "document" && file.filePath);
  if (documents.length > 0) {
    const results = await processor.processDocuments(documents.map((file) => file.filePath!), query);
    for (const result of results) {
      const chunks = result.retrievedChunks?.map((chunk) => {
        const label = chunk.fileName
          ? `${chunk.fileName}${typeof chunk.chunkIndex === "number" ? ` #${chunk.chunkIndex + 1}` : ""}`
          : result.name;
        return `[${label}] ${chunk.text}`;
      }).join("\n");
      const content = result.kind === "text" ? result.text : chunks;
      prepared.push({
        name: result.name,
        kind: "document",
        status: content ? "done" : "error",
        ...(content ? { content } : {}),
        ...(!content ? { reason: result.reason || "文档为空或无法读取" } : {}),
      });
    }
  }

  for (const file of files) {
    if (file.kind === "image" && file.filePath) {
      const result = await processor.captionImage(file.filePath);
      prepared.push({
        name: file.name,
        kind: "image",
        status: result.ok && result.caption ? "done" : "error",
        ...(result.caption ? { content: result.caption } : {}),
        ...(!result.caption ? { reason: result.error || "图片分析失败" } : {}),
      });
    } else if (file.kind === "unsupported") {
      prepared.push({ name: file.name, kind: "unsupported", status: "error", reason: file.reason || "不支持的附件格式" });
    }
  }
  return prepared;
}
