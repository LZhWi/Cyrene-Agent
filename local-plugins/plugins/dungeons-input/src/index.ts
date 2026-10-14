import path from "node:path";
import type { CyrenePlugin } from "@playa0v0/cyrene-plugin-sdk";
import { InputManager } from "./manager";

export const createPlugin = (create = () => new InputManager(path.join(__dirname, "runtime"))): CyrenePlugin => ({
  register(ctx) {
    const manager = create();
    ctx.onDispose(() => manager.close());
    ctx.registerIpc("input-status", () => manager.status());
    ctx.registerIpc("input-probe", () => manager.probe());
    ctx.registerIpc("input-start", () => { ctx.signal.throwIfAborted(); return manager.start(); });
    ctx.registerIpc("input-pulse", (request) => { ctx.signal.throwIfAborted(); return manager.pulse(request); });
    ctx.registerIpc("input-cancel", () => manager.cancel());
    ctx.registerIpc("input-stop", () => manager.stop());
    ctx.registerIpc("follow-observe", (request) => { ctx.signal.throwIfAborted(); return manager.follow(request, true); });
    ctx.registerIpc("follow-start", (request) => { ctx.signal.throwIfAborted(); return manager.follow(request); });
  },
});
export default createPlugin();
