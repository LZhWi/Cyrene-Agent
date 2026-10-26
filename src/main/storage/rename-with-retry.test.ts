import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renameWithRetrySync } from "./rename-with-retry";

vi.mock("node:fs", async (original) => ({ ...await original<typeof import("node:fs")>() }));

describe("renameWithRetrySync", () => {
  let root: string;
  let source: string;
  let target: string;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "rename-retry-"));
    source = path.join(root, "state.tmp");
    target = path.join(root, "state.json");
    fs.writeFileSync(source, "new");
    fs.writeFileSync(target, "old");
  });
  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(["EPERM", "EACCES", "EBUSY"])("retries %s without removing the old file", (code) => {
    const rename = vi.spyOn(fs, "renameSync").mockImplementationOnce(() => {
      expect(fs.readFileSync(target, "utf8")).toBe("old");
      throw Object.assign(new Error("busy"), { code });
    });
    renameWithRetrySync(source, target);
    expect(rename.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(fs.readFileSync(target, "utf8")).toBe("new");
    expect(fs.existsSync(source)).toBe(false);
  });

  it("bounds retries and preserves both files when the target remains unavailable", () => {
    const error = Object.assign(new Error("busy"), { code: "EPERM" });
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw error; });
    const wait = vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
    expect(() => renameWithRetrySync(source, target)).toThrow(error);
    expect(rename).toHaveBeenCalledTimes(5);
    expect(wait.mock.calls.map(call => call[3])).toEqual([1, 2, 4, 8]);
    expect(fs.readFileSync(target, "utf8")).toBe("old");
    expect(fs.readFileSync(source, "utf8")).toBe("new");
  });

  it("does not retry unrelated I/O errors", () => {
    const error = Object.assign(new Error("disk failed"), { code: "EIO" });
    const rename = vi.spyOn(fs, "renameSync").mockImplementation(() => { throw error; });
    expect(() => renameWithRetrySync(source, target)).toThrow(error);
    expect(rename).toHaveBeenCalledTimes(1);
    expect(fs.readFileSync(target, "utf8")).toBe("old");
  });
});
