import type { CyrenePlugin, PluginTool } from "@playa0v0/cyrene-plugin-sdk";

let running = false;

const healthTool: PluginTool = {
  id: "plugin-template_health",
  name: "检查插件模板状态",
  description: "仅在需要验证插件开发环境或模板是否正常加载时使用。",
  enabled: true,
  risk: "safe",
  effectKind: "read",
  verificationPolicy: "none",
  inputSchema: {
    type: "object",
    properties: {},
    required: [],
  },
  async execute() {
    return running ? "插件模板运行正常" : "插件模板尚未启动";
  },
};

const plugin: CyrenePlugin = {
  register(ctx) {
    running = true;
    ctx.registerTool(healthTool);

    // 所有插件自有状态都必须在停止阶段复位，避免刷新后遗留旧实例状态。
    ctx.onDispose(() => {
      running = false;
    });
  },
  unregister() {
    // unregister 需要幂等；宿主可能在清理回调之后再次调用它。
    running = false;
  },
};

export = plugin;
