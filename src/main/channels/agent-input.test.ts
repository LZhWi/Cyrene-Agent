import { describe, expect, it } from "vitest";
import { buildChannelAttachmentInputs } from "./agent-input";
import type { IncomingMessage } from "./types";

describe("buildChannelAttachmentInputs", () => {
  it("maps downloaded channel images to direct image attachments and files to context attachments", () => {
    const msg: IncomingMessage = {
      channel: "wechat",
      senderId: "wx-user-1",
      chatId: "wx-user-1",
      text: "看看这些",
      attachments: [
        { kind: "image", filePath: "C:/cache/pic.png", mime: "image/png", caption: "微信图片" },
        { kind: "file", filePath: "C:/cache/report.pdf", mime: "application/pdf", caption: "report.pdf" },
      ],
      at: new Date(0),
    };

    expect(buildChannelAttachmentInputs(msg)).toEqual({
      attachments: [
        { name: "report.pdf", text: "用户通过微信发送了文件：C:/cache/report.pdf" },
      ],
      imageAttachments: [
        { name: "微信图片", filePath: "C:/cache/pic.png", mime: "image/png" },
      ],
    });
  });
});
