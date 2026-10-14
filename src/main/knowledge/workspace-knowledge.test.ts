import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { contentHash } from "../learn/obsidian/obsidian-markdown";
import { buildDocumentTree } from "./document-tree";
import { WorkspaceKnowledge, type SavePageInput } from "./workspace-knowledge";

let temp: string;
let root: string;
let service: WorkspaceKnowledge;
const textbook = "# 教材\r\n概述\r\n## 方法\r\n方法需要独立样本。\r\n### 边界\r\n样本相关时不适用。\r\n```python\r\n# 不是章节\r\n```\r\n## 比较\r\n另一方法允许相关样本。\r\n";
const note = "# 复习\n## 误区\n独立不等于同分布。\n";

beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-knowledge-test-"));
  root = path.join(temp, "workspace");
  fs.mkdirSync(path.join(root, "materials"), { recursive: true });
  fs.writeFileSync(path.join(root, "materials/book.md"), textbook);
  fs.writeFileSync(path.join(root, "materials/note.md"), note);
  service = new WorkspaceKnowledge(root);
});
afterEach(() => fs.rmSync(temp, { recursive: true, force: true }));

function page(overrides: Partial<SavePageInput> = {}): SavePageInput {
  return { kind: "topic", slug: "sample-independence", title: "独立样本", body: "方法要求独立样本。[S1]\n独立不等于同分布。[S2]",
    sources: [
      { path: "materials/book.md", nodeId: "h2", contentHash: contentHash(textbook), quote: "方法需要独立样本。" },
      { path: "materials/note.md", nodeId: "h2", contentHash: contentHash(note), quote: "独立不等于同分布。" },
    ], ...overrides };
}

describe("document tree retrieval", () => {
  it("gives line-accurate hierarchical nodes and paginated source previews without code headings", () => {
    const outline = service.outline("materials/book.md", 0, 3);
    expect(outline.totalNodes).toBe(5);
    expect(outline.nextOffset).toBe(3);
    expect(outline.nodes[2]).toMatchObject({ nodeId: "h2", parentId: "h1", startLine: 3, endLine: 9, preview: "方法需要独立样本。" });
    expect(service.outline("materials/book.md", 3, 3).nodes[0]).toMatchObject({ nodeId: "h3", parentId: "h2", startLine: 5, endLine: 9 });
    expect(service.outline("materials/book.md", 3, 3).nextOffset).toBeNull();
  });

  it("reads selected nodes and adjacent evidence with exact original bytes and explicit continuation", () => {
    const hash = contentHash(textbook);
    const own = service.readNode("materials/book.md", "h2", hash);
    expect(own.content).toBe("## 方法\r\n方法需要独立样本。\r\n");
    const parent = service.readNode("materials/book.md", "h2", hash, true);
    expect(parent.content).toContain("样本相关时不适用。");
    expect(parent.content).not.toContain("另一方法");
    const first = service.readNode("materials/book.md", "h2", hash, true, 0, 10);
    const second = service.readNode("materials/book.md", "h2", hash, true, first.nextOffset!, 1000);
    expect(first.content + second.content).toBe(parent.content);
    expect(second.nextOffset).toBeNull();
    expect(service.readNode("materials/book.md", "h4", hash).content).toContain("另一方法允许相关样本。");
  });

  it("keeps duplicate headings separately addressable and handles unstructured text", () => {
    fs.writeFileSync(path.join(root, "duplicate.md"), "# Topic\nA\n# Topic\nB\n");
    const hash = service.outline("duplicate.md").contentHash;
    expect(service.readNode("duplicate.md", "h2", hash).content).toBe("# Topic\nB\n");
    fs.writeFileSync(path.join(root, "result.txt"), "# not a Markdown heading\nPASS\n");
    expect(service.outline("result.txt").totalNodes).toBe(1);
    expect(buildDocumentTree("")[0]).toMatchObject({ nodeId: "document", startLine: 1 });
  });

  it("rejects old node locators after source changes and nonexistent answers", () => {
    const hash = service.outline("materials/book.md").contentHash;
    expect(() => service.readNode("materials/book.md", "missing", hash)).toThrow("章节不存在");
    fs.appendFileSync(path.join(root, "materials/book.md"), "New section\n");
    expect(() => service.readNode("materials/book.md", "h2", hash)).toThrow("原文已变化");
  });

  it.each([
    ["report", "验收条件", "所有检查通过后才可交付。"],
    ["spec", "兼容约束", "旧接口需要保持兼容。"],
    ["lesson", "适用条件", "方法仅适用于独立样本。"],
  ])("navigates a long %s fixture to evidence near its end without returning its full text", (name, heading, answer) => {
    const filler = Array.from({ length: 40 }, (_, i) => `## 背景 ${i}\n${"原文说明与上下文。".repeat(80)}\n`).join("");
    const source = `# 长文档\n${filler}## ${heading}\n${answer}\n## 例外\n需要重新检查条件。\n`;
    fs.writeFileSync(path.join(root, `${name}.md`), source);
    const outline = service.outline(`${name}.md`);
    const selected = outline.nodes.find(n => n.title === heading)!;
    expect(selected).toBeDefined();
    const read = service.readNode(`${name}.md`, selected.nodeId, outline.contentHash);
    expect(read.content).toBe(`## ${heading}\n${answer}\n`);
    expect(read.startLine).toBe(source.slice(0, source.indexOf(`## ${heading}`)).split("\n").length);
    expect(JSON.stringify(outline).length).toBeLessThan(source.length);
  });

  it("rejects binary, invalid UTF-8, oversized and PDF files instead of building false outlines", () => {
    fs.writeFileSync(path.join(root, "binary.md"), Buffer.from([65, 0, 66]));
    fs.writeFileSync(path.join(root, "bad.md"), Buffer.from([0xff, 0xfe]));
    fs.writeFileSync(path.join(root, "huge.md"), "A".repeat(2 * 1024 * 1024 + 1));
    fs.writeFileSync(path.join(root, "file.pdf"), "%PDF readable text");
    for (const file of ["binary.md", "bad.md", "huge.md", "file.pdf"]) expect(() => service.outline(file)).toThrow();
  });
});

describe("source-backed workspace knowledge", () => {
  it("persists linked cross-document knowledge through Vault IO and checks freshness on every read", async () => {
    const saved = await service.savePage(page());
    expect(saved.path).toBe("cyrene-knowledge/topic/sample-independence.md");
    expect(saved.evidenceStatus).toBe("quotes_validated");
    expect(saved.content).toContain("../../materials/book.md");
    expect(service.readPage("topic", "sample-independence")).toMatchObject({ stale: false, contentHash: saved.contentHash });
    expect((await service.listPages("同分布")).pages[0].title).toBe("独立样本");
    fs.appendFileSync(path.join(root, "materials/book.md"), "变更");
    const stale = service.readPage("topic", "sample-independence");
    expect(stale).toMatchObject({ stale: true, evidenceStatus: "stale" });
    expect(stale.sources.map(s => s.status)).toEqual(["stale_or_unavailable", "current"]);
    fs.unlinkSync(path.join(root, "materials/note.md"));
    expect(service.readPage("topic", "sample-independence").sources[1].status).toBe("stale_or_unavailable");
  });

  it("rejects unsupported claims about source text, missing citations and changed source versions", async () => {
    await expect(service.savePage(page({ sources: [] }))).rejects.toThrow("必须附原文证据");
    await expect(service.savePage(page({ body: "No citations" }))).rejects.toThrow("正文须");
    await expect(service.savePage(page({ body: "[S1] [S2] [S3]" }))).rejects.toThrow("正文须");
    const badQuote = page();
    badQuote.sources[0].quote = "方法不需要独立样本。";
    await expect(service.savePage(badQuote)).rejects.toThrow("引文不在");
    const wrongNode = page();
    wrongNode.sources[0].nodeId = "h4";
    await expect(service.savePage(wrongNode)).rejects.toThrow("引文不在");
    const oldSource = page();
    oldSource.sources[0].contentHash = "old";
    await expect(service.savePage(oldSource)).rejects.toThrow("来源已变化");
    expect(fs.existsSync(path.join(root, "cyrene-knowledge"))).toBe(false);
  });

  it("requires read-before-update and serializes concurrent compare-and-swap writes", async () => {
    const saved = await service.savePage(page());
    await expect(service.savePage(page())).rejects.toThrow("先读取本页");
    const results = await Promise.allSettled([
      service.savePage(page({ body: "Version A [S1] [S2]", expectedContentHash: saved.contentHash })),
      new WorkspaceKnowledge(root).savePage(page({ body: "Version B [S1] [S2]", expectedContentHash: saved.contentHash })),
    ]);
    expect(results.map(r => r.status)).toEqual(["fulfilled", "rejected"]);
    expect(service.readPage("topic", "sample-independence").content).toContain("Version A");
  });

  it("does not overwrite unmanaged pages or recursively cite derived pages", async () => {
    await service.savePage(page());
    const outline = service.outline("cyrene-knowledge/topic/sample-independence.md");
    await expect(service.savePage(page({ slug: "recursive", body: "[S1]", sources: [{ path: outline.path,
      contentHash: outline.contentHash, nodeId: "document", quote: "独立样本" }] }))).rejects.toThrow("派生知识页");
    fs.writeFileSync(path.join(root, "cyrene-knowledge/topic/manual.md"), "# My original note\n");
    await expect(service.savePage(page({ slug: "manual" }))).rejects.toThrow("不能自动覆盖");
    expect(fs.readFileSync(path.join(root, "cyrene-knowledge/topic/manual.md"), "utf8")).toBe("# My original note\n");
    const listed = await service.listPages();
    expect(listed.pages).toHaveLength(1);
    expect(listed.unavailableCount).toBe(1);
    expect(listed.unavailablePages![0].path).toBe("cyrene-knowledge/topic/manual.md");
  });

  it.each(["decision", "progress", "lesson"] as const)("stores %s without evidence as explicitly unverified", async kind => {
    const saved = await service.savePage(page({ kind, slug: "task-record", body: "待完成，未运行测试。", sources: [] }));
    expect(saved.evidenceStatus).toBe("unverified_record");
    expect(service.readPage(kind, "task-record").evidenceStatus).toBe("unverified_record");
  });

  it("isolates workspaces and rejects paths outside their roots including absent files below junctions", async () => {
    await service.savePage(page());
    const other = path.join(temp, "other");
    fs.mkdirSync(other);
    expect((await new WorkspaceKnowledge(other).listPages()).pages).toEqual([]);
    for (const bad of ["../outside.md", path.join(other, "outside.md"), ".git/config", ".OBSIDIAN/config.md"]) {
      expect(() => service.outline(bad)).toThrow();
    }
    fs.symlinkSync(other, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    expect(() => service.outline("linked/absent.md")).toThrow("工作区之外");
    fs.symlinkSync(other, path.join(root, "cyrene-knowledge/progress"), process.platform === "win32" ? "junction" : "dir");
    await expect(service.savePage(page({ kind: "progress", slug: "escape", body: "Record", sources: [] }))).rejects.toThrow("工作区之外");
    expect(fs.readdirSync(other)).toEqual([]);
  });

  it("does not write a queued mutation after cancellation", async () => {
    const controller = new AbortController();
    const pending = new WorkspaceKnowledge(root, controller.signal).savePage(page());
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(fs.existsSync(path.join(root, "cyrene-knowledge"))).toBe(false);
  });
});
