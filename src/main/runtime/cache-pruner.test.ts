import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { pruneDirectoryByMtimeSync } from "./cache-pruner";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("cache pruning", () => {
  it("does nothing while total size is below the cap", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-cache-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "a"), Buffer.alloc(4));
    expect(pruneDirectoryByMtimeSync(root, 10, 6)).toEqual({ beforeBytes: 4, afterBytes: 4, removed: 0 });
  });

  it("removes oldest files until reaching the target", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-cache-"));
    roots.push(root);
    for (const [index, name] of ["old", "middle", "new"].entries()) {
      const file = path.join(root, name);
      fs.writeFileSync(file, Buffer.alloc(4));
      const at = new Date(1_000 + index * 1_000);
      fs.utimesSync(file, at, at);
    }
    expect(pruneDirectoryByMtimeSync(root, 10, 6)).toEqual({ beforeBytes: 12, afterBytes: 4, removed: 2 });
    expect(fs.readdirSync(root)).toEqual(["new"]);
  });
});
