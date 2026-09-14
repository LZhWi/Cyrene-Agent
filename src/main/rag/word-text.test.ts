import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Document, Packer, Paragraph } from "docx";
import { extractWordDocumentText, isWordDocumentExt } from "./word-text";
import { ingestOneFile } from "./file-ingest";
import { prepareDocumentIndexFile } from "./document-index-worker";

describe("Word document ingestion", () => {
  it("extracts Unicode text from a generated .docx and sends it to indexing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "word-docx-ingest-"));
    const filePath = path.join(dir, "中文报告.docx");
    try {
      const buffer = await Packer.toBuffer(new Document({
        sections: [{ children: [
          new Paragraph("项目结论"),
          new Paragraph("交付日期是星期五。"),
        ] }],
      }));
      fs.writeFileSync(filePath, buffer);
      const importDocument = async (text: string) => {
        expect(text).toContain("项目结论");
        expect(text).toContain("交付日期是星期五。");
        return { importId: "word-docx", chunkCount: 1 };
      };

      await expect(ingestOneFile(filePath, importDocument)).resolves.toMatchObject({
        kind: "indexed",
        name: "中文报告.docx",
        importId: "word-docx",
        text: expect.stringContaining("交付日期是星期五。"),
      });
      await expect(prepareDocumentIndexFile(filePath)).resolves.toMatchObject({
        kind: "prepared-indexed",
        name: "中文报告.docx",
        inlineText: expect.stringContaining("项目结论"),
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("extracts Chinese text from a real legacy .doc fixture", async () => {
    const fixture = path.join(__dirname, "__fixtures__", "word-test.doc");
    const text = await extractWordDocumentText(fs.readFileSync(fixture));
    expect(text).toContain("这是一个用来测试nodejs解析Word文档");
    await expect(prepareDocumentIndexFile(fixture)).resolves.toMatchObject({
      kind: "prepared-indexed",
      name: "word-test.doc",
      inlineText: expect.stringContaining("This is a test for parsing the Word file in node."),
    });
  });

  it("reports malformed Word files without treating their binary bytes as text", async () => {
    await expect(extractWordDocumentText(Buffer.from("not a Word file")))
      .rejects.toThrow("Word 文档解析失败");
  });

  it("recognizes Word extensions case-insensitively", () => {
    expect(isWordDocumentExt(".DOC")).toBe(true);
    expect(isWordDocumentExt(".docx")).toBe(true);
    expect(isWordDocumentExt(".pdf")).toBe(false);
  });
});
