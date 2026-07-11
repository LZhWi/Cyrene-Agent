export type ComposerAttachmentKind = "text" | "indexed" | "empty" | "unsupported" | "image" | "document";

export interface ComposerAttachmentLabelInput {
  kind: ComposerAttachmentKind;
  status?: "pending" | "done" | "error";
  chunks?: number;
}

export function getAttachmentIcon(kind: ComposerAttachmentKind): string {
  const kindLabel: Record<ComposerAttachmentKind, string> = {
    text: "📝",
    indexed: "📚",
    empty: "📄",
    image: "📷",
    document: "📄",
    unsupported: "⚠️",
  };
  return kindLabel[kind];
}

export function formatAttachmentTagDetail(file: ComposerAttachmentLabelInput): string {
  if (file.kind === "text") return "（附件）";
  if (file.kind === "indexed") return `（${file.chunks ?? 0} 段）`;
  if (file.kind === "empty") return "（空）";
  if (file.kind === "document") {
    return file.status === "done" ? "（已处理）" : file.status === "error" ? "（处理失败）" : "（待处理）";
  }
  if (file.kind === "image") {
    return file.status === "done" ? "（已分析）" : file.status === "error" ? "（分析失败）" : "（待分析）";
  }
  return "（暂不支持）";
}
