import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  assertRunDirectory,
  createChildEnvironment,
  createRunDirectory,
  ensureRunSubdirectory,
  resolveProjectLayout,
  snapshotTree,
} from "../scripts/isolation-boundary.mjs";

const localRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

describe("完整宿主隔离边界", () => {
  it("原目录和嵌套上游工作树都锚定同一个正式版保护根", () => {
    const direct = resolveProjectLayout(path.join("E:\\Philia093 demo", "Cyrene-Agent-N"));
    const latest = resolveProjectLayout(path.join("E:\\Philia093 demo", "Cyrene-Agent-N", ".upstream-latest"));
    expect(latest.originalProjectRoot).toBe(direct.originalProjectRoot);
    expect(latest.originalProjectRoot).toBe(path.join("E:\\Philia093 demo", "Cyrene-Agent"));
    expect(() => resolveProjectLayout(path.join("E:\\Philia093 demo", "Cyrene-Agent-N", "other"))).toThrow();
  });

  it("每次创建独立目录，拒绝越界和符号链接", () => {
    const parent = path.join(localRoot, ".test-runtime");
    fs.mkdirSync(parent, { recursive: true });
    const fixture = fs.mkdtempSync(path.join(parent, "boundary-test-"));
    try {
      const fakeLocalRoot = path.join(fixture, "Cyrene-Agent-N", "local-plugins");
      fs.mkdirSync(fakeLocalRoot, { recursive: true });
      const first = createRunDirectory(fakeLocalRoot, "full-electron-host");
      const second = createRunDirectory(fakeLocalRoot, "full-electron-host");
      expect(first).not.toBe(second);
      expect(() => assertRunDirectory(fakeLocalRoot, "full-electron-host", first)).not.toThrow();
      const latestLocalRoot = path.join(fixture, "Cyrene-Agent-N", ".upstream-latest", "local-plugins");
      fs.mkdirSync(latestLocalRoot, { recursive: true });
      const latest = createRunDirectory(latestLocalRoot, "full-electron-host");
      expect(() => assertRunDirectory(latestLocalRoot, "full-electron-host", latest)).not.toThrow();
      expect(() => ensureRunSubdirectory(first, "../outside")).toThrow();
      const link = path.join(first, "linked");
      fs.symlinkSync(path.join(fixture, "Cyrene-Agent-N"), link, "junction");
      expect(() => ensureRunSubdirectory(first, "linked/escape")).toThrow();
    } finally {
      const resolved = path.resolve(fixture);
      if (path.dirname(resolved) !== path.resolve(parent) || !path.basename(resolved).startsWith("boundary-test-")) {
        throw new Error("测试夹具清理路径越界");
      }
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });

  it("只修改子进程环境并重定向主目录、AppData、临时目录", () => {
    const base = { APPDATA: "C:\\real", USERPROFILE: "C:\\real-user" };
    const root = path.join(localRoot, ".test-runtime", `run-1-${crypto.randomUUID()}`);
    const env = createChildEnvironment(base, root, false);
    expect(base.APPDATA).toBe("C:\\real");
    for (const name of ["APPDATA", "LOCALAPPDATA", "USERPROFILE", "HOME", "TEMP", "TMP", "TMPDIR", "HF_HOME", "npm_config_cache"]) {
      expect(path.relative(root, env[name as keyof typeof env]).startsWith("..")).toBe(false);
    }
    expect(env.CYRENE_ISOLATED_RUN_ROOT).toBe(root);
  });

  it("完整目录快照能发现创建、改写和删除", () => {
    const parent = path.join(localRoot, ".test-runtime");
    fs.mkdirSync(parent, { recursive: true });
    const fixture = fs.mkdtempSync(path.join(parent, "boundary-test-"));
    try {
      const initial = snapshotTree(fixture);
      const file = path.join(fixture, "memory.json");
      fs.writeFileSync(file, "first");
      const created = snapshotTree(fixture);
      expect(created).not.toBe(initial);
      fs.writeFileSync(file, "second");
      const changed = snapshotTree(fixture);
      expect(changed).not.toBe(created);
      fs.unlinkSync(file);
      expect(snapshotTree(fixture)).not.toBe(changed);
      fs.symlinkSync(fixture, path.join(fixture, "linked"), "junction");
      expect(() => snapshotTree(fixture)).toThrow();
    } finally {
      const resolved = path.resolve(fixture);
      if (path.dirname(resolved) !== path.resolve(parent) || !path.basename(resolved).startsWith("boundary-test-")) {
        throw new Error("测试夹具清理路径越界");
      }
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });

  it("内容快照可核对副本且能发现副本内容变化", () => {
    const parent = path.join(localRoot, ".test-runtime");
    fs.mkdirSync(parent, { recursive: true });
    const fixture = fs.mkdtempSync(path.join(parent, "boundary-test-"));
    try {
      const source = path.join(fixture, "source");
      const copy = path.join(fixture, "copy");
      fs.mkdirSync(source);
      fs.writeFileSync(path.join(source, "memory.json"), "first");
      fs.cpSync(source, copy, { recursive: true });
      expect(snapshotTree(copy, { contentOnly: true })).toBe(snapshotTree(source, { contentOnly: true }));
      fs.writeFileSync(path.join(copy, "memory.json"), "second");
      expect(snapshotTree(copy, { contentOnly: true })).not.toBe(snapshotTree(source, { contentOnly: true }));
    } finally {
      const resolved = path.resolve(fixture);
      if (path.dirname(resolved) !== path.resolve(parent) || !path.basename(resolved).startsWith("boundary-test-")) {
        throw new Error("测试夹具清理路径越界");
      }
      fs.rmSync(resolved, { recursive: true, force: true });
    }
  });
});
