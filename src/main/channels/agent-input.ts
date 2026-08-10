import path from "node:path";
import type { AguiRunInput } from "../agui-bridge";
import { setTurnAttachedImages } from "../chat/image-caption";
import type { IncomingMessage } from "./types";

type AttachmentInputs = Pick<AguiRunInput, "attachments" | "imageAttachments">;

export interface ChannelAttachmentInputOptions {
  imageMode?: "direct" | "caption";
  captionImage?: (filePath: string) => Promise<{ ok: boolean; caption?: string; error?: string }>;
}

export async function buildChannelAttachmentInputs(
  msg: IncomingMessage,
  options: ChannelAttachmentInputOptions = {},
): Promise<AttachmentInputs> {
  const attachments: NonNullable<AguiRunInput["attachments"]> = [];
  const imageAttachments: NonNullable<AguiRunInput["imageAttachments"]> = [];
  const imageMode = options.imageMode ?? "direct";
  const turnImages: string[] = [];

  for (const item of msg.attachments ?? []) {
    if (!item.filePath) continue;
    const name = item.caption || path.basename(item.filePath);
    if (item.kind === "image") {
      if (imageMode === "direct") {
        imageAttachments.push({ name, filePath: item.filePath, mime: item.mime });
      } else {
        turnImages.push(item.filePath);
        const result = options.captionImage
          ? await options.captionImage(item.filePath)
          : { ok: false, error: "未配置视觉模型，无法分析图片" };
        const text = result.ok && result.caption
          ? result.caption
          : `图片分析失败：${result.error || "图片分析失败"}。请诚实说明暂时无法看清这张图。`;
        attachments.push({
          name,
          text: `【图片视觉信息】\n用户通过${channelName(msg.channel)}发送了图片：${name}\n${text}\n如需仔细看图片的某个方面，调用 ask_attached_image 工具并用 focus 指定。`,
        });
      }
    } else if (item.kind === "file") {
      attachments.push({
        name,
        text: `用户通过${channelName(msg.channel)}发送了文件：${item.filePath}`,
      });
    }
  }

  // 覆盖写入当轮图片登记（无图消息清空，防追问工具读旧图）
  setTurnAttachedImages(turnImages);

  return {
    attachments: attachments.length > 0 ? attachments : undefined,
    imageAttachments: imageAttachments.length > 0 ? imageAttachments : undefined,
  };
}

function channelName(channel: IncomingMessage["channel"]): string {
  switch (channel) {
    case "wechat": return "微信";
    case "feishu": return "飞书";
    default: return channel;
  }
}
