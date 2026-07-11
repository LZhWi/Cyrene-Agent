import path from "node:path";
import type { AguiRunInput } from "../agui-bridge";
import type { IncomingMessage } from "./types";

type AttachmentInputs = Pick<AguiRunInput, "attachments" | "imageAttachments">;

export function buildChannelAttachmentInputs(msg: IncomingMessage): AttachmentInputs {
  const attachments: NonNullable<AguiRunInput["attachments"]> = [];
  const imageAttachments: NonNullable<AguiRunInput["imageAttachments"]> = [];

  for (const item of msg.attachments ?? []) {
    if (!item.filePath) continue;
    const name = item.caption || path.basename(item.filePath);
    if (item.kind === "image") {
      imageAttachments.push({ name, filePath: item.filePath, mime: item.mime });
    } else if (item.kind === "file") {
      attachments.push({
        name,
        text: `用户通过${channelName(msg.channel)}发送了文件：${item.filePath}`,
      });
    }
  }

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
