import { describe, expect, it } from "vitest";
import { formatAttachmentTagDetail } from "./attachment-labels";

describe("formatAttachmentTagDetail", () => {
  it("把 pending document 显示为待处理文档，而不是暂不支持", () => {
    expect(formatAttachmentTagDetail({ kind: "document", status: "pending" })).toBe("（待处理）");
  });
});
