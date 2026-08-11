import { describe, expect, it } from "vitest";
import { parseRecognizedText } from "./vlm-locator";

describe("parseRecognizedText", () => {
  it("解析 Markdown 包裹的 OCR JSON", () => {
    const result = parseRecognizedText('```json\n{"items":[{"text":"货币战争","confidence":0.95,"x":10,"y":20,"width":30,"height":40}]}\n```');
    expect(result).toEqual({
      rawText: "货币战争",
      items: [{ text: "货币战争", confidence: 0.95, bounds: { x: 10, y: 20, width: 30, height: 40 } }],
    });
  });

  it("跳过 JSON 前面的说明和无效条目", () => {
    const result = parseRecognizedText('说明 {"example":true}\n{"items":[{"text":"忍无可忍","x":100,"y":200,"width":300,"height":40},{"text":"","x":0,"y":0,"width":1,"height":1}]}');
    expect(result?.rawText).toBe("忍无可忍");
    expect(result?.items).toHaveLength(1);
  });

  it("无法解析时返回 null", () => {
    expect(parseRecognizedText("没有 JSON")).toBeNull();
  });

  it("兼容 VLM 直接返回 OCR 条目数组", () => {
    const result = parseRecognizedText('[{"text":"本场对局首领","confidence":0.95,"x":440,"y":668,"width":120,"height":30}]');
    expect(result?.rawText).toBe("本场对局首领");
    expect(result?.items).toHaveLength(1);
  });
});
