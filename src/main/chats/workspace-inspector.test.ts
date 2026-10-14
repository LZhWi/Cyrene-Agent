import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { listInspectorFiles, readInspectorFile } from "./workspace-inspector";

const roots: string[] = [];
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "cyrene-inspector-"));
  roots.push(root);
  const workspace = path.join(root, "workspace");
  await fs.mkdir(workspace); await fs.writeFile(path.join(root, "outside.txt"), "private outside data");
  return { root, workspace };
}
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

describe("workspace inspector reads", () => {
  it("rejects paths and junctions escaping the bound workspace", async () => {
    const { root, workspace } = await fixture();
    await expect(readInspectorFile(workspace, "../outside.txt")).rejects.toThrow("工作区");
    await expect(readInspectorFile(workspace, path.join(root, "outside.txt"))).rejects.toThrow("相对路径");
    await fs.symlink(root, path.join(workspace, "escape"), process.platform === "win32" ? "junction" : "dir");
    await expect(readInspectorFile(workspace, "escape/outside.txt")).rejects.toThrow("工作区");
    expect((await listInspectorFiles(workspace, "")).entries).toEqual([]);
  });
  it("pages large directories without losing entries and excludes dependency folders", async () => {
    const { workspace } = await fixture();
    await fs.mkdir(path.join(workspace, "node_modules")); await fs.mkdir(path.join(workspace, ".git"));
    await Promise.all(Array.from({ length: 205 }, (_, index) => fs.writeFile(path.join(workspace, `${String(index).padStart(3, "0")}.txt`), "fixture")));
    const first = await listInspectorFiles(workspace, ""); const second = await listInspectorFiles(workspace, "", 200);
    expect(first.entries).toHaveLength(200); expect(first.hasMore).toBe(true);
    expect(second.entries).toHaveLength(5); expect(second.hasMore).toBe(false);
    expect(new Set([...first.entries, ...second.entries].map((entry) => entry.path)).size).toBe(205);
  });
  it("returns source as text without rendering HTML and rejects binary/oversize files", async () => {
    const { workspace } = await fixture();
    const text = '<script>window.chatStore.delete("all")</script>\n文本';
    await fs.writeFile(path.join(workspace, "page.html"), text);
    expect(await readInspectorFile(workspace, "page.html")).toEqual({ kind: "text", content: text });
    await fs.writeFile(path.join(workspace, "binary.dat"), Buffer.from([0, 1, 2]));
    await expect(readInspectorFile(workspace, "binary.dat")).rejects.toThrow("二进制");
    await fs.writeFile(path.join(workspace, "large.txt"), Buffer.alloc(512 * 1024 + 1, 65));
    await expect(readInspectorFile(workspace, "large.txt")).rejects.toThrow("过大");
  });
});
