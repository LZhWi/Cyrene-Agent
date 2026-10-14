import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";

function loadPreload() {
  let bridge: { invoke: (action: string, data?: unknown) => Promise<unknown> };
  const invoke = vi.fn(async () => ({ ok: true }));
  runInNewContext(readFileSync("plugins/companion-memory/static/preload.cjs", "utf8"), {
    require: (name: string) => {
      if (name !== "electron") throw new Error("Unexpected preload dependency");
      return { contextBridge: { exposeInMainWorld: (_key: string, value: typeof bridge) => { bridge = value; } }, ipcRenderer: { invoke } };
    },
  });
  return { invoke, bridge: bridge! };
}

describe("旧上下文和队列的独立窗口通信", () => {
  it.each(["preview-legacy-context", "import-legacy-context", "preview-legacy-pending", "restore-legacy-pending"])("允许 %s 抵达真实处理通道", async action => {
    const { bridge, invoke } = loadPreload();
    const data = { conversationIds: ["isolated-session"], sourceHash: "preview-hash" };
    await expect(bridge.invoke(action, data)).resolves.toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledExactlyOnceWith("plugin:companion-memory:ui", action, data);
  });

  it("未声明的操作仍在窗口边界拒绝", async () => {
    const { bridge, invoke } = loadPreload();
    await expect(bridge.invoke("unknown-operation")).rejects.toThrow("操作未授权");
    expect(invoke).not.toHaveBeenCalled();
  });
});
