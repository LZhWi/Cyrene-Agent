import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const html = fs.readFileSync(fileURLToPath(new URL("./index.html", import.meta.url)), "utf8");

describe("screen monitor settings markup", () => {
  it("distinguishes background observation from on-demand screen access", () => {
    expect(html).toContain("后台屏幕活动观察");
    expect(html).toContain("关闭只停止后台定时观察");
    expect(html).toContain("AI 仍可按需调用屏幕观察工具");
    expect(html).toContain("原始截图不落盘");
  });
});
