import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { writeFileAtomic, writeFileAtomicSync, writeJsonAtomicSync } from "./atomic-file";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("atomic file writes", () => {
  it("creates parent directories and replaces existing content", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-atomic-"));
    roots.push(root);
    const target = path.join(root, "nested", "settings.json");
    writeFileAtomicSync(target, "old");
    writeJsonAtomicSync(target, { value: "new" });
    expect(JSON.parse(fs.readFileSync(target, "utf8"))).toEqual({ value: "new" });
    expect(fs.readdirSync(path.dirname(target))).toEqual(["settings.json"]);
  });

  it("leaves unrelated existing data intact when a write cannot start", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-atomic-"));
    roots.push(root);
    const stable = path.join(root, "settings.json");
    fs.writeFileSync(stable, "stable", "utf8");
    const blockedParent = path.join(root, "blocked");
    fs.writeFileSync(blockedParent, "not-a-directory", "utf8");
    expect(() => writeFileAtomicSync(path.join(blockedParent, "value.json"), "new")).toThrow();
    expect(fs.readFileSync(stable, "utf8")).toBe("stable");
  });

  it("asynchronously replaces binary content without leaving a temporary file", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-atomic-"));
    roots.push(root);
    const target = path.join(root, "nested", "audio.bin");
    await writeFileAtomic(target, Buffer.from("first"));
    await writeFileAtomic(target, Buffer.from("second"));
    expect(fs.readFileSync(target, "utf8")).toBe("second");
    expect(fs.readdirSync(path.dirname(target))).toEqual(["audio.bin"]);
  });

  it("uses distinct temporary files for concurrent writes to one target", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-atomic-"));
    roots.push(root);
    const target = path.join(root, "audio.bin");
    await Promise.all([
      writeFileAtomic(target, Buffer.alloc(128 * 1024, 1)),
      writeFileAtomic(target, Buffer.alloc(128 * 1024, 2)),
    ]);
    const content = fs.readFileSync(target);
    expect([1, 2]).toContain(content[0]);
    expect(content.every((value) => value === content[0])).toBe(true);
    expect(fs.readdirSync(root)).toEqual(["audio.bin"]);
  });
});
