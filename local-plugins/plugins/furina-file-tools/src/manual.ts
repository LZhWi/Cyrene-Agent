import { randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { PluginAgentRunResult, PluginContext, PluginTool } from "@playa0v0/cyrene-plugin-sdk";
import type { Job, LocalApi } from "./client";

export const FILE_TOOLS = ["image-compress", "image-resize", "image-convert", "pdf-merge", "pdf-split", "html-to-pdf", "html-to-image"];
const terminal = (job?: Job) => !job || ["completed", "failed", "cancelled"].includes(job.status);

export interface ManualDeps {
  context: Pick<PluginContext, "signal" | "deps">;
  api(): Pick<LocalApi, "request">;
  pickWorkspace(): Promise<string | undefined>;
  pickFiles(root: string, kind: "pdf" | "html" | "image", multiple: boolean): Promise<string[] | undefined>;
  showFile(file: string): void;
}

export function createManualController(deps: ManualDeps) {
  let root = "";
  let inputs: string[] = [];
  let job: Job | undefined;
  let submitting = false;
  let modelAbort: AbortController | undefined;
  const model = { running: false, text: "", error: "", event: "" };

  const assertIdle = () => {
    deps.context.signal.throwIfAborted();
    if (submitting || model.running || !terminal(job)) throw new Error("请等待当前任务结束或先取消任务");
  };
  const refresh = async () => {
    if (job && !terminal(job)) job = await deps.api().request<Job>("/jobs/get", { id: job.id, workspace: job.workspace }, deps.context.signal);
  };
  const state = () => ({ workspace: root, inputs: [...inputs], job, model: { ...model },
    modelAvailable: typeof deps.context.deps.llm?.runGoal === "function" });
  const selection = async (value: unknown) => {
    const request = value as { tool?: unknown; parameters?: unknown } | undefined;
    if (!request || typeof request.tool !== "string" || !FILE_TOOLS.includes(request.tool)) throw new Error("请选择支持的工具");
    if (!root || inputs.length === 0) throw new Error("请先选择工作区和文件");
    if (request.tool === "pdf-merge" ? inputs.length < 2 || inputs.length > 32 : inputs.length !== 1) throw new Error("PDF合并需2到32个文件，其余工具需1个文件");
    for (const input of inputs) {
      const file = await realpath(input);
      const relative = path.relative(root, file);
      if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative) || !(await stat(file)).isFile()) throw new Error("文件必须位于所选工作区内");
      const extensions = request.tool.startsWith("pdf-") ? [".pdf"] : request.tool.startsWith("html-") ? [".html", ".htm"] : [".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff", ".gif", ".ico"];
      if (!extensions.includes(path.extname(file).toLowerCase())) throw new Error("文件格式与所选工具不匹配");
    }
    const params = request.parameters ?? {};
    if (typeof params !== "object" || params === null || Array.isArray(params)) throw new Error("参数必须是对象");
    const allowed: Record<string, string[]> = { "image-compress": ["quality", "max_width"], "image-resize": ["width", "height", "keep_ratio"],
      "image-convert": ["format"], "pdf-merge": [], "pdf-split": ["ranges"],
      "html-to-pdf": ["method", "landscape", "wait_ms"], "html-to-image": ["method", "width", "height", "wait_ms"] };
    const parameters = structuredClone(params) as Record<string, unknown>;
    if (Object.keys(parameters).some((key) => !allowed[request.tool as string].includes(key))) throw new Error("工具参数不匹配");
    for (const key of ["quality", "width", "height", "max_width"]) {
      if (key in parameters && (!Number.isInteger(parameters[key]) || (parameters[key] as number) < 1 || (parameters[key] as number) > (key === "quality" ? 95 : 16384))) throw new Error(`${key} 参数超出范围`);
    }
    if ("keep_ratio" in parameters && typeof parameters.keep_ratio !== "boolean") throw new Error("保持比例参数无效");
    if (request.tool === "image-resize" && !("width" in parameters) && !("height" in parameters)) throw new Error("请填写宽度或高度");
    if (request.tool === "image-convert" && !["png", "jpg", "webp", "bmp", "tiff"].includes(String(parameters.format))) throw new Error("请选择输出格式");
    if (request.tool === "pdf-split" && (typeof parameters.ranges !== "string" || parameters.ranges.length > 1024 || !/^[1-9]\d*(?:-[1-9]\d*)?(?:,[1-9]\d*(?:-[1-9]\d*)?)*$/.test(parameters.ranges))) throw new Error("页码格式应为1-3,5，页码从1开始");
    if (request.tool.startsWith("html-")) {
      if (!["render", "extract"].includes(String(parameters.method ?? "render"))) throw new Error("请选择网页排版或原图提取方式");
      if ("landscape" in parameters && typeof parameters.landscape !== "boolean") throw new Error("横向参数无效");
      if ("wait_ms" in parameters && (!Number.isInteger(parameters.wait_ms) || (parameters.wait_ms as number) < 0 || (parameters.wait_ms as number) > 30000)) throw new Error("等待时间应为0到30000毫秒");
      if (parameters.method === "extract" && Object.keys(parameters).some((key) => key !== "method")) throw new Error("原图提取无需网页渲染参数");
    }
    return { request_id: randomUUID(), workspace: root, tool: request.tool, inputs: [...inputs], parameters };
  };
  type Selection = Awaited<ReturnType<typeof selection>>;
  const submit = async (request: Selection, signal: AbortSignal) => {
    signal.throwIfAborted();
    const api = deps.api();
    try {
      job = await api.request<Job>("/jobs", request, signal);
      return job;
    } catch (error) {
      await api.request("/jobs/cancel", { id: request.request_id, workspace: request.workspace }).catch(() => undefined);
      throw error;
    }
  };
  const cancel = async () => {
    modelAbort?.abort();
    if (job && !terminal(job)) job = await deps.api().request<Job>("/jobs/cancel", { id: job.id, workspace: job.workspace }, deps.context.signal);
  };

  return {
    stop() { modelAbort?.abort(); },
    async handle(action: string, data?: unknown): Promise<unknown> {
      deps.context.signal.throwIfAborted();
      if (action === "state") { await refresh(); return state(); }
      if (action === "choose-workspace") {
        assertIdle();
        const selected = await deps.pickWorkspace();
        deps.context.signal.throwIfAborted();
        if (selected) {
          const directory = await realpath(selected);
          if (!(await stat(directory)).isDirectory()) throw new Error("工作区不是目录");
          root = directory; inputs = [];
        }
        return state();
      }
      if (action === "choose-files") {
        assertIdle();
        if (!root) throw new Error("请先选择工作区");
        if (typeof data !== "string" || !FILE_TOOLS.includes(data)) throw new Error("工具无效");
        const selected = await deps.pickFiles(root, data.startsWith("pdf-") ? "pdf" : data.startsWith("html-") ? "html" : "image", data === "pdf-merge");
        deps.context.signal.throwIfAborted();
        if (selected) {
          const files = await Promise.all(selected.map((file) => realpath(file)));
          for (const file of files) {
            const relative = path.relative(root, file);
            if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("请选择工作区内的文件");
          }
          inputs = files;
        }
        return state();
      }
      if (action === "move-file") {
        assertIdle();
        const move = data as { index: number; direction: number };
        if (!move || !Number.isInteger(move.index) || ![-1, 1].includes(move.direction) || !inputs[move.index] || !inputs[move.index + move.direction]) throw new Error("文件顺序无效");
        const target = move.index + move.direction;
        [inputs[move.index], inputs[target]] = [inputs[target], inputs[move.index]];
        return state();
      }
      if (action === "cancel") { await cancel(); return state(); }
      if (action === "show-file") {
        await refresh();
        if (job?.status !== "completed" || typeof data !== "string" || !job.artifacts.some((artifact) => artifact.path === data)) throw new Error("只能定位当前已完成任务的产物");
        deps.showFile(data); return state();
      }
      if (action === "submit" || action === "model-start") {
        assertIdle();
        submitting = true;
        try {
          const request = await selection(data);
          if (action === "submit") {
            model.text = ""; model.error = ""; model.event = "";
            await submit(request, deps.context.signal);
          } else {
            const runGoal = deps.context.deps.llm?.runGoal;
            if (!runGoal) throw new Error("当前宿主不支持模型任务，请更新宿主或使用直接执行");
            job = undefined;
            modelAbort = new AbortController();
            const signal = AbortSignal.any([deps.context.signal, modelAbort.signal]);
            Object.assign(model, { running: true, text: "", error: "", event: "正在交给模型" });
            let submitted: Promise<Job> | undefined;
            const selectedTool: PluginTool = {
              id: "furina-file-tools_selected", name: "执行用户已指定的文件操作",
              description: `执行用户已确认的 ${request.tool}。文件和参数已固定，无需填写参数；重复调用只返回同一个任务。`,
              enabled: true, modes: ["work"], risk: "fs-write", effectKind: "mutation", verificationPolicy: "artifact",
              inputSchema: { type: "object", properties: {}, required: [] },
              async execute() { return JSON.stringify(await (submitted ??= submit(request, signal))); },
            };
            const selectedStatus: PluginTool = {
              id: "furina-file-tools_selected_status", name: "查询已指定操作的结果",
              description: "查询刚刚提交的同一个文件任务，取得产物路径或失败原因。",
              enabled: true, modes: ["work"], risk: "safe", effectKind: "read", verificationPolicy: "none",
              inputSchema: { type: "object", properties: {}, required: [] },
              async execute() {
                signal.throwIfAborted();
                if (!submitted) throw new Error("请先执行已指定的文件操作");
                await submitted; await refresh(); return JSON.stringify(job);
              },
            };
            const finish = (result: PluginAgentRunResult) => {
              model.text = result.text;
              if (!submitted) model.error = "模型未调用已指定工具，未处理文件";
              else if (result.terminal.status !== "success") model.error = result.terminal.reason || `模型任务状态：${result.terminal.status}`;
            };
            void Promise.resolve().then(() => runGoal({
              runId: randomUUID(), purpose: "furina-manual-selected", signal, maxRounds: 12, maxWallMs: 300_000,
              goal: `用户已手动指定文件处理操作，请调用 furina-file-tools_selected，再查询结果并说明产物路径。不得替换操作或只给教程。选择信息：${JSON.stringify(request)}`,
              tools: [selectedTool, selectedStatus],
              onEvent(event) { model.event = event.kind === "round_started" ? `模型正在处理（第${event.round}轮）` : `${event.kind === "tool_started" ? "正在调用" : "已调用"}：${event.toolName}`; },
            })).then(finish).catch((error: unknown) => { model.error = error instanceof Error ? error.message : "模型任务失败"; })
              .finally(() => { model.running = false; modelAbort = undefined; });
          }
          return state();
        } finally { submitting = false; }
      }
      throw new Error("操作未授权");
    },
  };
}
