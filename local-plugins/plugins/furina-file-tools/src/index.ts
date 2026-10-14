import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { CyrenePlugin, PluginTool, PluginToolContext } from "@playa0v0/cyrene-plugin-sdk";
import { LocalApi, validateConfig, type Job } from "./client";
import { createManualController, FILE_TOOLS } from "./manual";
import { createPanel } from "./panel";

export const MODES = ["work", "code", "learn"] as const;
export const TOOL_IDS = FILE_TOOLS;

export function requireMode(context?: PluginToolContext): void {
  if (!context?.mode || !(MODES as readonly string[]).includes(context.mode)) {
    throw new Error("Furina 文件工具仅支持 work/code/learn 模式");
  }
}

async function workspace(context?: PluginToolContext): Promise<string> {
  requireMode(context);
  if (!context?.resolvedWorkspaceRoot) throw new Error("请先为当前会话选择工作区");
  const root = await realpath(context.resolvedWorkspaceRoot);
  if (!(await stat(root)).isDirectory()) throw new Error("工作区不是目录");
  return root;
}

export const createPlugin = (): CyrenePlugin => {
  let openPanel: (() => Promise<void>) | undefined;
  return {
  async open() {
    if (!openPanel) throw new Error("请先启用 Furina 文件工具插件");
    await openPanel();
  },
  register(ctx) {
    let api: LocalApi | undefined;
    const getApi = () => {
      ctx.signal.throwIfAborted();
      return api ??= new LocalApi(validateConfig(ctx.storage.get("connection")), path.join(ctx.storage.rootDir(), "api-jobs"));
    };
    ctx.onDispose(async () => { await api?.close(); });
    const panel = createPanel(ctx, __dirname);
    openPanel = () => panel.open();
    const manual = createManualController({ context: ctx, api: getApi,
      pickWorkspace: () => panel.pickWorkspace(), pickFiles: (root, kind, multiple) => panel.pickFiles(root, kind, multiple),
      showFile: (file) => panel.showFile(file) });
    ctx.onDispose(() => { manual.stop(); openPanel = undefined; });
    ctx.registerIpc("open-panel", () => panel.open());
    ctx.registerIpc("ui", async (action, data) => {
      try {
        if (typeof action !== "string") throw new Error("操作无效");
        return { ok: true, data: await manual.handle(action, data) };
      } catch (error) { return { ok: false, error: error instanceof Error ? error.message : "操作失败" }; }
    });
    ctx.registerIpc("connection-get", () => ctx.storage.get("connection") ?? { sourceRoot: "", python: "" });
    ctx.registerIpc("connection-save", async (value) => {
      ctx.signal.throwIfAborted();
      const config = validateConfig(value);
      await api?.close();
      api = undefined;
      ctx.storage.set("connection", config);
      return { ok: true };
    });

    const register = (definition: Omit<PluginTool, "enabled" | "modes" | "needsContext">) => {
      const execute = definition.execute;
      ctx.registerTool({ ...definition, enabled: true, modes: [...MODES], needsContext: true,
        async execute(args, context) {
          // Tool modes can be overridden by the host. Keep an execution guard
          // too, without changing the host or companion chat implementation.
          requireMode(context);
          ctx.signal.throwIfAborted();
          context?.signal?.throwIfAborted();
          return execute(args, context);
        },
      });
    };
    const signal = (context?: PluginToolContext) => context?.signal
      ? AbortSignal.any([ctx.signal, context.signal]) : ctx.signal;
    register({
      id: "furina-file-tools_catalog", name: "查看 Furina 文件工具",
      description: "查看本机 FurinaKit API 状态及图片/PDF/HTML 工具的参数。只用于 work/code/learn。",
      risk: "safe", effectKind: "read", verificationPolicy: "none",
      inputSchema: { type: "object", properties: {}, required: [] },
      async execute(_args, context) {
        const service = await getApi().request("/health", undefined, signal(context));
        const catalog = await getApi().request("/tools", undefined, signal(context));
        return JSON.stringify({ service, catalog });
      },
    });
    register({
      id: "furina-file-tools_submit", name: "处理本地图片、PDF 或 HTML",
      description: "调用 FurinaKit 处理工作区内文件，返回任务ID；用 status 查询产物。图片压缩输出白底JPEG；缩放传width或height；转换传format；PDF合并至少两个文件；拆分传ranges。html-to-pdf/html-to-image支持method=render（默认，静态网页排版导出PDF/PNG）或extract（提取img原图，合成PDF或保留原图片）；仅加载内嵌及工作区本地资源。产物写入 .furinakit-output/任务ID/。",
      risk: "fs-write", effectKind: "mutation", verificationPolicy: "artifact",
      inputSchema: { type: "object", properties: {
        tool: { type: "string", enum: TOOL_IDS },
        inputs: { type: "array", items: { type: "string" }, description: "当前工作区内的文件路径，HTML工具传一个.html/.htm文件；顺序用于PDF合并" },
        parameters: { type: "object", properties: {
          quality: { type: "integer", description: "JPEG质量1..95，默认75" },
          max_width: { type: "integer", description: "压缩时最大宽度1..16384" },
          width: { type: "integer", description: "缩放宽度1..16384" },
          height: { type: "integer", description: "缩放高度1..16384" },
          keep_ratio: { type: "boolean", description: "保持比例，默认true" },
          format: { type: "string", enum: ["png", "jpg", "webp", "bmp", "tiff"] },
          ranges: { type: "string", description: "PDF页码从1开始，例如1-3,5" },
          method: { type: "string", enum: ["render", "extract"], description: "HTML导出方式，默认render；extract时仅传method" },
          landscape: { type: "boolean", description: "HTML按网页排版导出PDF时横向，默认false" },
          wait_ms: { type: "integer", description: "HTML网页渲染等待0..30000毫秒，默认1500" },
        } },
      }, required: ["tool", "inputs"] },
      async execute(args, context) {
        const root = await workspace(context);
        const id = randomUUID();
        const requestSignal = signal(context);
        const connection = getApi();
        try {
          return JSON.stringify(await connection.request<Job>("/jobs", {
            request_id: id, workspace: root, tool: args.tool, inputs: args.inputs, parameters: args.parameters ?? {},
          }, requestSignal));
        } catch (error) {
          // A submit may have reached the server before the client was aborted.
          // Cancel the known ID without submitting a second job.
          await connection.request("/jobs/cancel", { id, workspace: root }).catch(() => undefined);
          throw error;
        }
      },
    });
    for (const action of ["status", "cancel"] as const) {
      register({
        id: `furina-file-tools_${action}`, name: action === "status" ? "查询 Furina 任务" : "取消 Furina 任务",
        description: action === "status" ? "查询当前工作区的 Furina 文件任务状态、失败原因和生成文件路径。" : "取消当前工作区的 Furina 文件处理任务。",
        risk: action === "status" ? "safe" : "fs-write",
        effectKind: action === "status" ? "read" : "mutation", verificationPolicy: "none",
        inputSchema: { type: "object", properties: { id: { type: "string", description: "submit返回的任务ID" } }, required: ["id"] },
        async execute(args, context) {
          const root = await workspace(context);
          if (typeof args.id !== "string") throw new Error("id必须是任务ID");
          const job = await getApi().request<Job>(action === "status" ? "/jobs/get" : "/jobs/cancel", { id: args.id, workspace: root }, signal(context));
          return JSON.stringify(job);
        },
      });
    }
  },
  };
};

const plugin = createPlugin();
export default plugin;
