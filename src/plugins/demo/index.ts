import type { CyrenePlugin } from "../types";

export const demoPlugin: CyrenePlugin = {
  register(ctx) {
    ctx.registerTool({
      id: "demo_hello",
      name: "演示问候",
      description: "返回一句来自演示插件的问候语",
      enabled: true,
      inputSchema: { type: "object", properties: {}, required: [] },
      execute: async () => "来自演示插件的问候 👋",
    });
    ctx.registerIpc("ping", () => "pong");
    ctx.log("演示插件已注册");
  },
  unregister() {
    console.log("[plugin:demo] 演示插件已卸载");
  },
};

export default demoPlugin;
