import { expect, it, vi } from "vitest";
import { pathToFileURL } from "node:url";
import path from "node:path";
vi.mock("node:fs/promises", () => ({ stat: vi.fn(async (p: string) => {
  if (p.includes("missing")) throw new Error("missing");
  return { isFile: () => !p.includes("directory") };
}) }));
vi.mock("../rag/file-ingest", () => ({ describePendingAttachment: (p: string) => ({ name: path.basename(p), filePath: p, kind: "document" }) }));
import { describeClipboardFileUris } from "./clipboard-file-uris";
it("uses the normal attachment descriptor, rejects remote URIs and skips missing/duplicate/directory entries", async () => {
  const url = (name: string) => pathToFileURL(path.resolve(name)).href;
  const items = await describeClipboardFileUris(["# comment", url("report.txt"), url("report.txt"), url("missing.txt"), url("directory"), "file://remote/share/a.txt", "https://example.com", "invalid"].join("\r\n"));
  expect(items).toEqual([{ name: "report.txt", filePath: path.resolve("report.txt"), kind: "document" }]);
});
