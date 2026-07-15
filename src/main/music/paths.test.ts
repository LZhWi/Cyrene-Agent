import { describe, it, expect, vi } from "vitest";
import * as path from "node:path";

const repoPath = path.resolve("/repo");
const userDataPath = path.resolve("/userdata");

vi.mock("electron", () => ({
  app: {
    isPackaged: false,
    getAppPath: () => repoPath,
    getPath: (k: string) => k === "userData" ? userDataPath : "/tmp",
  },
}));

import { resolveMusicPaths } from "./paths";

describe("resolveMusicPaths (dev)", () => {
  it("uses repo-root vendor dir in development", () => {
    const p = resolveMusicPaths();
    expect(p.vendorDir).toBe(path.join(repoPath, "vendor", "cloud-music-mcp"));
    expect(p.runtimeDir).toBe(path.join(userDataPath, "music", "netease", "runtime"));
    expect(p.accountPath).toBe(path.join(userDataPath, "music", "netease", "account.enc"));
  });
});
