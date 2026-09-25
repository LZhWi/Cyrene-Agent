import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Document, Packer, Paragraph } from "docx";
import { ingestOneFile } from "./file-ingest";
import { extractWordDocumentText, isWordDocumentExt } from "./word-text";

describe("Word document ingestion", () => {
  it("extracts Unicode from generated docx and indexes it", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "word-docx-ingest-"));
    const filePath = path.join(dir, "中文报告.docx");
    try {
      const buffer = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph("项目结论"), new Paragraph("交付日期是星期五。")] }] }));
      fs.writeFileSync(filePath, buffer);
      await expect(ingestOneFile(filePath, async (text) => {
        expect(text).toContain("交付日期是星期五。");
        return { importId: "word-docx", chunkCount: 1 };
      })).resolves.toMatchObject({ kind: "indexed", importId: "word-docx", text: expect.stringContaining("项目结论") });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects malformed Word files and recognizes extensions", async () => {
    await expect(extractWordDocumentText(Buffer.from("not a Word file"))).rejects.toThrow("Word 文档解析失败");
    expect(isWordDocumentExt(".DOC")).toBe(true);
    expect(isWordDocumentExt(".docx")).toBe(true);
    expect(isWordDocumentExt(".pdf")).toBe(false);
  });
});
