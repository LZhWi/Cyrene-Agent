import type { CyrenePlugin } from "@playa0v0/cyrene-plugin-sdk";
import { DecisionSession } from "./session";
import { example, scenarios } from "./scenarios";

export const createPlugin = (): CyrenePlugin => ({
  register(ctx) {
    const session = new DecisionSession();
    ctx.onDispose(() => { session.stop(); });
    ctx.registerIpc("decision-status", () => session.status());
    ctx.registerIpc("decision-examples", () => scenarios.map(({ id, name, expected }) => ({ id, name, expected })));
    ctx.registerIpc("decision-example", (id) => example(String(id), Date.now()));
    ctx.registerIpc("decision-preview", (observation) => { ctx.signal.throwIfAborted(); return session.preview(observation); });
    ctx.registerIpc("decision-feedback", (id, status) => { ctx.signal.throwIfAborted(); return session.feedback(id, status); });
    ctx.registerIpc("decision-stop", () => session.stop());
    ctx.registerIpc("decision-reset", () => { ctx.signal.throwIfAborted(); return session.reset(); });
  },
});
export default createPlugin();
