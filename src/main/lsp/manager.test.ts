import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LspManager } from "./manager";
import type { ResolvedLspServer } from "./server-discovery";

const roots: string[] = [];

function workspace(): { root: string; file: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-lsp-manager-"));
  roots.push(root);
  const file = path.join(root, "src", "entry.ts");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "export const value = 1;\n", "utf8");
  return { root, file };
}

const resolvedServer: ResolvedLspServer = {
  definition: { id: "fake-lsp", extensions: [".ts"], commands: [{ command: "fake", args: [] }], rootMarkers: [], installHint: "安装 fake。" },
  executablePath: "C:\\tools\\fake.exe",
  args: [],
};

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

describe("LspManager", () => {
  it("reuses one workspace server and maps one-based hover positions", async () => {
    const { root, file } = workspace();
    const client = {
      initialize: vi.fn(async () => {}),
      touchFile: vi.fn(async () => {}),
      request: vi.fn(async () => ({ contents: "value: number" })),
      getDiagnostics: vi.fn(() => []),
      dispose: vi.fn(async () => {}),
    };
    const createClient = vi.fn(() => client);
    const manager = new LspManager({
      resolveServer: () => resolvedServer,
      createClient,
    });

    const first = await manager.execute({ operation: "hover", filePath: file, line: 3, character: 4 }, { resolvedWorkspaceRoot: root });
    const second = await manager.execute({ operation: "hover", filePath: file, line: 3, character: 4 }, { resolvedWorkspaceRoot: root });

    expect(first.items).toEqual([{ contents: "value: number" }]);
    expect(second.serverId).toBe("fake-lsp");
    expect(createClient).toHaveBeenCalledTimes(1);
    expect(client.touchFile).toHaveBeenCalledWith(file, "typescript");
    expect(client.request).toHaveBeenCalledWith("textDocument/hover", expect.objectContaining({ position: { line: 2, character: 3 } }));
  });

  it("rejects external paths before server discovery", async () => {
    const { root } = workspace();
    const resolveServer = vi.fn(() => resolvedServer);
    const manager = new LspManager({ resolveServer, createClient: vi.fn() });

    await expect(manager.execute({ operation: "hover", filePath: path.join(root, "..", "other.ts"), line: 1, character: 1 }, { resolvedWorkspaceRoot: root }))
      .rejects.toMatchObject({ code: "LSP_PATH_OUTSIDE_WORKSPACE" });
    expect(resolveServer).not.toHaveBeenCalled();
  });
});
