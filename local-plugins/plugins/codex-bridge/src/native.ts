import { createHash } from "node:crypto";
import type { PluginStorage, PluginLlmService } from "@playa0v0/cyrene-plugin-sdk";
import { CodexBridge, defaults, type Config } from "./bridge";
import { AppServerClient, type RpcClient } from "./client";

/** Each native conversation/workspace owns its own history, process and request cards. */
export class NativeCodeExecutor {
  private bridges = new Map<string, CodexBridge>();
  private disposed = false;
  constructor(private storage: PluginStorage, private llm?: PluginLlmService,
    private factory = async (bridge: CodexBridge, config: Config): Promise<RpcClient> => {
      const client = new AppServerClient(config.executable, config.cwd, message => bridge.event(message), reason => bridge.disconnected(reason));
      try { await client.initialize(); return client; }
      catch (error) { await client.close(); throw error; }
    }) {}

  async invoke(action: unknown, data: any) {
    if (this.disposed) throw new Error("插件已停止");
    if (!data || typeof data.sessionId !== "string" || !data.sessionId || typeof data.cwd !== "string" || !data.cwd) throw new Error("缺少原生会话或工作目录");
    const key = createHash("sha256").update(JSON.stringify([data.sessionId, data.cwd])).digest("hex").slice(0, 40);
    let bridge = this.bridges.get(key);
    if (!bridge) {
      const storage: PluginStorage = {
        rootDir: () => this.storage.rootDir(),
        get: <T>(name: string) => this.storage.get<T>(`code-${key}-${name}`),
        set: <T>(name: string, value: T) => this.storage.set(`code-${key}-${name}`, value),
      };
      bridge = new CodexBridge(storage, this.llm);
      this.bridges.set(key, bridge);
    }
    const input = data.input ?? {};
    switch (action) {
      case "state": break;
      case "connect":
        await bridge.connect({ ...defaults, ...bridge.config, cwd: data.cwd, executable: "" }, config => this.factory(bridge!, config));
        break;
      case "submit": {
        // Explicit selection only. Renderer cannot inject an executable, workspace or foreign task.
        const previous = bridge.tasks[0];
        await bridge.submit({ message: input.message, model: input.model, effort: input.effort, skillPath: input.skillPath,
          sandbox: input.sandbox, autoExplain: !!input.autoExplain,
          continueId: input.newThread || !previous?.threadId ? undefined : previous.id });
        break;
      }
      case "answer": bridge.answer(input); break;
      case "cancel": await bridge.cancel(input.id); break;
      case "sync": await bridge.sync(input.id); break;
      case "explain": await bridge.explain(input.id); break;
      default: throw new Error("不支持的原生执行操作");
    }
    return bridge.snapshot();
  }
  dispose() { this.disposed = true; for (const bridge of this.bridges.values()) bridge.dispose(); this.bridges.clear(); }
}
