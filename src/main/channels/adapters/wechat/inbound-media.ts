import path from "node:path";

type InboundItemType = 1 | 2 | 3 | 4 | 5;

export interface InboundWechatItem {
  type: InboundItemType;
  image_item?: unknown;
  voice_item?: unknown;
  file_item?: {
    file_name?: unknown;
    name?: unknown;
    media?: unknown;
  };
  video_item?: {
    file_name?: unknown;
    name?: unknown;
    media?: unknown;
  };
}

export type InboundMediaKind = "image" | "voice" | "file" | "video";

export interface InboundMediaDescriptor {
  kind: InboundMediaKind;
  fileName: string;
  extension: string;
  analyzable: boolean;
}

const ANALYZABLE_FILE_EXTENSIONS = new Set([
  ".txt", ".md", ".markdown",
  ".json", ".csv", ".tsv", ".yaml", ".yml",
  ".pdf", ".docx", ".xlsx",
  ".js", ".ts", ".tsx", ".jsx", ".py", ".java", ".go", ".rs", ".cpp", ".c", ".h", ".cs",
  ".html", ".css", ".xml", ".toml", ".ini", ".env", ".log",
]);

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]);

export const SAVE_INTENT_TTL_MS = 5 * 60 * 1000;

export function getWechatDisplayName(callPreference: unknown): string {
  const name = typeof callPreference === "string" ? callPreference.trim() : "";
  return name || "伙伴";
}

function asFileName(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const trimmed = value.trim();
  return trimmed ? path.basename(trimmed) : fallback;
}

export function getFileExtension(fileName: string): string {
  return path.extname(fileName).toLowerCase();
}

export function isAnalyzableWechatFile(fileName: string): boolean {
  const ext = getFileExtension(fileName);
  return ANALYZABLE_FILE_EXTENSIONS.has(ext) || IMAGE_EXTENSIONS.has(ext);
}

export function isWechatSaveIntent(text: string): boolean {
  const normalized = text.trim().replace(/\s+/g, "");
  if (!normalized) return false;
  return /保存到桌面|存到桌面|放到桌面|代收|帮我收|帮我保存|保存文件|收一下/.test(normalized);
}

export function describeInboundWechatMedia(items: InboundWechatItem[]): InboundMediaDescriptor[] {
  const media: InboundMediaDescriptor[] = [];
  for (const item of items) {
    if (item.type === 2 && item.image_item) {
      media.push({ kind: "image", fileName: "微信图片", extension: "", analyzable: true });
    } else if (item.type === 3 && item.voice_item) {
      media.push({ kind: "voice", fileName: "微信语音", extension: "", analyzable: false });
    } else if (item.type === 4 && item.file_item) {
      const fileName = asFileName(item.file_item.file_name ?? item.file_item.name, "微信文件");
      media.push({
        kind: "file",
        fileName,
        extension: getFileExtension(fileName),
        analyzable: isAnalyzableWechatFile(fileName),
      });
    } else if (item.type === 5 && item.video_item) {
      const fileName = asFileName(item.video_item.file_name ?? item.video_item.name, "微信视频");
      media.push({
        kind: "video",
        fileName,
        extension: getFileExtension(fileName),
        analyzable: false,
      });
    }
  }
  return media;
}

export function buildUnsupportedWechatFilePrompt(username: string): string {
  return `${username}，这个文件人家还分析不了呢。如果${username}你是想让我帮你代收一下，请在 5 分钟内回复“保存到桌面”哦~~`;
}

export function buildWechatVideoPrompt(username: string): string {
  return `${username}，视频人家现在还看不了呢。如果${username}你只是想让我帮你代收，请在 5 分钟内回复“保存到桌面”哦~~`;
}

export function buildWechatSaveIntentPrompt(username: string): string {
  return `好呀，${username}，尽管把文件发过来吧。我会帮你放到桌面的“Cyrene 收件箱”里哦~~`;
}

export function buildWechatAsrMissingPrompt(username: string): string {
  return `${username}，人家现在还没有配置语音识别，暂时听不懂这条语音。可以发文字给我哦~~`;
}
