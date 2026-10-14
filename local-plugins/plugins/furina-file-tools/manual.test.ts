import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginAgentRunOptions, PluginAgentRunResult } from "@playa0v0/cyrene-plugin-sdk";
import { createManualController } from "./src/manual";
import type { Job, LocalApi } from "./src/client";

let directory: string;
beforeEach(async () => {
  const parent = path.resolve(".test-runtime", "furina-manual");
  await mkdir(parent, { recursive: true });
  directory = await mkdtemp(path.join(parent, "run-"));
  await mkdir(path.join(directory, "workspace"));
  await writeFile(path.join(directory, "workspace", "input.png"), "fixture");
  await writeFile(path.join(directory, "workspace", "input.html"), "<h1>Fixture</h1>");
  await writeFile(path.join(directory, "outside.png"), "outside");
});
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

const success: PluginAgentRunResult = { text: "已处理", terminal: { status: "success", externalEffectsMayContinue: false }, rounds: 2 };

function harness() {
  const root = path.join(directory, "workspace");
  const stop = new AbortController();
  const runGoal = vi.fn<(options: PluginAgentRunOptions) => Promise<PluginAgentRunResult>>();
  let current: Job;
  const request = vi.fn(async (route: string, value?: unknown) => {
    const data = value as { request_id?: string; workspace: string };
    if (route === "/jobs") current = { id: data.request_id!, workspace: data.workspace, status: "processing", artifacts: [] };
    if (route === "/jobs/get") current = { ...current, status: "completed", artifacts: [{ path: path.join(root, "output.jpg"), size: 10 }] };
    if (route === "/jobs/cancel") current = { ...current, status: "cancelled" };
    return current;
  });
  const pickFiles = vi.fn(async () => [path.join(root, "input.png")]);
  const showFile = vi.fn();
  const controller = createManualController({
    context: { signal: stop.signal, deps: { llm: { generateText: async () => { throw new Error("Unexpected model call"); }, runGoal } } },
    api: () => ({ request: request as unknown as LocalApi["request"] }),
    pickWorkspace: async () => root, pickFiles, showFile,
  });
  const choose = async () => { await controller.handle("choose-workspace"); await controller.handle("choose-files", "image-convert"); };
  return { controller, choose, request, runGoal, pickFiles, showFile, stop, root };
}

describe("Furina manual entry points", () => {
  it("accepts HTML for direct rendering and preserves the selected HTML operation for the model", async () => {
    const h = harness();
    await h.controller.handle("choose-workspace");
    h.pickFiles.mockResolvedValue([path.join(h.root, "input.html")]);
    await h.controller.handle("choose-files", "html-to-pdf");
    await h.controller.handle("submit", { tool: "html-to-pdf", parameters: { method: "render", landscape: true } });
    expect(h.runGoal).not.toHaveBeenCalled();
    expect(h.request.mock.calls[0][1]).toMatchObject({ tool: "html-to-pdf", inputs: [path.join(h.root, "input.html")], parameters: { method: "render", landscape: true } });
    await h.controller.handle("state");
    h.runGoal.mockImplementation(async (options) => { await options.tools[0].execute({ tool: "pdf-merge" }); await options.tools[1].execute({}); return success; });
    await h.controller.handle("model-start", { tool: "html-to-image", parameters: { method: "extract" } });
    await vi.waitFor(() => expect(h.request.mock.calls.filter(([route]) => route === "/jobs")).toHaveLength(2));
    expect(h.request.mock.calls.filter(([route]) => route === "/jobs")[1][1]).toMatchObject({ tool: "html-to-image", parameters: { method: "extract" } });
    await vi.waitFor(async () => expect((await h.controller.handle("state") as { model: { running: boolean } }).model.running).toBe(false));
  });

  it("rejects rendering parameters in extraction mode before API or model invocation", async () => {
    const h = harness(); await h.controller.handle("choose-workspace");
    h.pickFiles.mockResolvedValue([path.join(h.root, "input.html")]);
    await h.controller.handle("choose-files", "html-to-image");
    await expect(h.controller.handle("model-start", { tool: "html-to-image", parameters: { method: "extract", width: 500 } })).rejects.toThrow("无需");
    await expect(h.controller.handle("submit", { tool: "html-to-pdf", parameters: { wait_ms: -1 } })).rejects.toThrow("等待时间");
    expect(h.runGoal).not.toHaveBeenCalled(); expect(h.request).not.toHaveBeenCalled();
  });
  it("direct execution uses only the local API and displays verified artifacts", async () => {
    const h = harness(); await h.choose();
    const result = await h.controller.handle("submit", { tool: "image-convert", parameters: { format: "jpg" } }) as { job: Job };
    expect(result.job.status).toBe("processing");
    expect(h.runGoal).not.toHaveBeenCalled();
    expect(h.request).toHaveBeenCalledWith("/jobs", expect.objectContaining({ tool: "image-convert", workspace: h.root, inputs: [path.join(h.root, "input.png")], parameters: { format: "jpg" } }), expect.any(AbortSignal));
    await expect(h.controller.handle("show-file", path.join(directory, "outside.png"))).rejects.toThrow("产物");
    await h.controller.handle("show-file", path.join(h.root, "output.jpg"));
    expect(h.showFile).toHaveBeenCalledWith(path.join(h.root, "output.jpg"));
    expect(h.runGoal).not.toHaveBeenCalled();
  });

  it("model invocation freezes the selected operation and submits only once", async () => {
    const h = harness(); await h.choose();
    h.runGoal.mockImplementation(async (options) => {
      expect(options.tools.map((tool) => tool.id)).toEqual(["furina-file-tools_selected", "furina-file-tools_selected_status"]);
      await options.tools[0].execute({ tool: "pdf-merge", inputs: ["outside"] });
      await options.tools[0].execute({});
      await options.tools[1].execute({});
      return success;
    });
    await h.controller.handle("model-start", { tool: "image-convert", parameters: { format: "jpg" } });
    await vi.waitFor(async () => {
      const value = await h.controller.handle("state") as { model: { running: boolean; error: string }; job: Job };
      expect(value.model.running).toBe(false); expect(value.model.error).toBe(""); expect(value.job.status).toBe("completed");
    });
    expect(h.runGoal).toHaveBeenCalledOnce();
    expect(h.request.mock.calls.filter(([route]) => route === "/jobs")).toHaveLength(1);
    expect(h.request.mock.calls.find(([route]) => route === "/jobs")![1]).toMatchObject({ tool: "image-convert", parameters: { format: "jpg" } });
  });

  it("reports when a model responds without calling the tool", async () => {
    const h = harness(); await h.choose(); h.runGoal.mockResolvedValue(success);
    await h.controller.handle("model-start", { tool: "image-convert", parameters: { format: "jpg" } });
    await vi.waitFor(async () => expect((await h.controller.handle("state") as { model: { error: string } }).model.error).toContain("未处理文件"));
    expect(h.request).not.toHaveBeenCalled();
  });

  it("rejects invalid parameters before calling either API or model", async () => {
    const h = harness(); await h.choose();
    await expect(h.controller.handle("model-start", { tool: "image-resize", parameters: { width: 0 } })).rejects.toThrow("范围");
    await expect(h.controller.handle("submit", { tool: "image-convert", parameters: { format: "exe" } })).rejects.toThrow("格式");
    expect(h.runGoal).not.toHaveBeenCalled(); expect(h.request).not.toHaveBeenCalled();
  });

  it("rejects outside files and cancels only the selected task", async () => {
    const h = harness(); await h.choose();
    h.pickFiles.mockResolvedValue([path.join(directory, "outside.png")]);
    await expect(h.controller.handle("choose-files", "image-convert")).rejects.toThrow("工作区内");
    await h.controller.handle("submit", { tool: "image-convert", parameters: { format: "jpg" } });
    await h.controller.handle("cancel");
    expect(h.request).toHaveBeenLastCalledWith("/jobs/cancel", expect.objectContaining({ workspace: h.root }), expect.any(AbortSignal));
  });

  it("stopping a model task prevents a late tool call", async () => {
    const h = harness(); await h.choose();
    let options: PluginAgentRunOptions | undefined;
    h.runGoal.mockImplementation(async (value) => { options = value; await new Promise<void>((resolve) => value.signal!.addEventListener("abort", () => resolve(), { once: true })); return { ...success, terminal: { status: "cancelled", externalEffectsMayContinue: false } }; });
    await h.controller.handle("model-start", { tool: "image-convert", parameters: { format: "jpg" } });
    await vi.waitFor(() => expect(options).toBeDefined());
    await h.controller.handle("cancel");
    await expect(options!.tools[0].execute({})).rejects.toThrow();
    expect(h.request).not.toHaveBeenCalled();
  });
});
