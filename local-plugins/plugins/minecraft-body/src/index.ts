import path from "node:path";
import type { CyrenePlugin } from "@playa0v0/cyrene-plugin-sdk";
import { BodyManager } from "./manager";

export const createPlugin = (createManager = (runtime: string, data: string) => new BodyManager(runtime, data)): CyrenePlugin => ({
  register(ctx) {
    const manager = createManager(path.join(__dirname, "runtime"), ctx.storage.rootDir());
    ctx.onDispose(() => manager.close());
    const accepting = <T>(action: () => T) => { ctx.signal.throwIfAborted(); return action(); };
    ctx.registerIpc("body-status", () => accepting(() => manager.status()));
    ctx.registerIpc("body-start", (config) => accepting(() => manager.start(config)));
    ctx.registerIpc("body-action", (request) => accepting(() => manager.action(request)));
    ctx.registerIpc("body-cancel", () => accepting(() => manager.cancel()));
    ctx.registerIpc("body-stop", () => manager.stop());
    // Deliberately no tools, prompt provider, channel adapter, events or LLM service.
  },
});

export default createPlugin();
