import type { CyrenePlugin } from "@playa0v0/cyrene-plugin-sdk";
import { createWindow, strictStorage } from "../../shared/runtime";
import { AppServerClient } from "./client";
import { CodexBridge } from "./bridge";
import { NativeCodeExecutor } from "./native";

let openWindow: (() => Promise<void>) | undefined;
const plugin: CyrenePlugin = {
  register(ctx) {
    const bridge = new CodexBridge(strictStorage(ctx), ctx.deps.llm);
    const native = new NativeCodeExecutor(strictStorage(ctx), ctx.deps.llm);
    ctx.registerIpc("native", async (action, data) => {
      if (ctx.signal.aborted) return { ok: false, error: "插件已停止" };
      try { return { ok: true, data: await native.invoke(action, data) }; }
      catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    });
    const window = createWindow(ctx, __dirname, "Codex 任务工作台 · 测试版");
    let currentClient: AppServerClient | undefined;
    openWindow = window.open;
    ctx.registerIpc("ui", async (action, data: any) => {
      if (ctx.signal.aborted) return { ok: false, error: "插件已停止" };
      try {
        let result: unknown;
        switch (action) {
          case "state": result = bridge.snapshot(); break;
          case "connect":
            await bridge.connect(data, async config => {
              const client = new AppServerClient(config.executable, config.cwd,
                message => { if (currentClient === client) bridge.event(message); },
                reason => { if (currentClient === client) bridge.disconnected(reason); });
              currentClient = client;
              try { await client.initialize(); return client; }
              catch (error) { client.close(); throw error; }
            });
            result = bridge.snapshot(); break;
          case "submit": result = await bridge.submit(data); break;
          case "answer": bridge.answer(data); break;
          case "cancel": await bridge.cancel(data.id); break;
          case "sync": await bridge.sync(data.id); break;
          case "explain": await bridge.explain(data.id); break;
          default: throw new Error("不支持的操作");
        }
        return { ok: true, data: result };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : String(error) }; }
    });
    ctx.onDispose(() => { native.dispose(); bridge.dispose(); currentClient = undefined; window.close(); openWindow = undefined; });
  },
  async open() { await openWindow?.(); },
};
export = plugin;
