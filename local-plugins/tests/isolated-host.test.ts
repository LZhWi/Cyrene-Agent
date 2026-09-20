import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";
import { PluginManager, type PluginManagerOptions } from "../../src/plugins/manager";
import { createPluginPromptRegistry } from "../../src/plugins/prompts";
import { createLifecyclePublisher } from "../../src/main/plugin-host/lifecycle-publisher";
import { createPendingTurnLifecycle } from "../../src/main/plugin-host/pending-turn-lifecycle";
import type { PluginDeps } from "../../src/plugins/types";
import type { PluginConversationMessage } from "@playa0v0/cyrene-plugin-sdk";

const enabled = process.env.CYRENE_ISOLATED_HOST_SMOKE === "1";
const workspace = path.resolve(".");
const testRoot = path.join(workspace, ".test-runtime", "isolated-host");
const artifactRoot = path.join(workspace, "artifacts");

function assertTestRoot(): void {
  const relative = path.relative(workspace, testRoot);
  if (relative !== path.join(".test-runtime", "isolated-host") || path.isAbsolute(relative)) {
    throw new Error("隔离宿主测试目录越界");
  }
}

function createHarness(caseName: string, pluginIds: string[], conversationMessages: PluginConversationMessage[] = []) {
  const caseRoot = path.join(testRoot, caseName);
  const pluginRoot = path.join(caseRoot, "plugins");
  const storageRoot = path.join(caseRoot, "plugin-data");
  mkdirSync(pluginRoot, { recursive: true });
  for (const id of pluginIds) cpSync(path.join(artifactRoot, id), path.join(pluginRoot, id), { recursive: true });

  const ipc = new Map<string, (...args: unknown[]) => unknown>();
  const secretStores = new Map<string, Map<string, string>>();
  const llmCalls: unknown[] = [];
  const proactiveDeliveries: string[] = [];
  const promptRegistry = createPluginPromptRegistry();
  const hostServices = {
    createForPlugin({ pluginId }: { pluginId: string }): PluginDeps {
      const secrets = new Map<string, string>(); secretStores.set(pluginId, secrets);
      return {
        llm: { generateText: async (messages, options) => { llmCalls.push({ pluginId, messages, purpose: options?.purpose }); return "隔离模型回复"; } },
        secrets: {
          get: async (key) => secrets.get(key),
          set: async (key, value) => { secrets.set(key, value); },
          delete: async (key) => secrets.delete(key),
        },
        conversations: {
          list: async () => ({ items: [] }),
          getMessages: async (input) => ({ items: conversationMessages, range: { fromMessageId: input.fromMessageId, throughMessageId: input.throughMessageId } }),
        },
        assistantDelivery: {
          postProactiveMessage: async (text) => {
            proactiveDeliveries.push(text);
            return { conversationId: "isolated-proactive", messageId: `message-${proactiveDeliveries.length}`, at: new Date(0).toISOString() };
          },
        },
        screenObservation: {
          observe: async ({ focus } = {}) => `隔离屏幕摘要:${focus ?? ""}`,
        },
        userPresence: {
          snapshot: async () => ({ at: new Date(0).toISOString(), idleSeconds: 0, screenLocked: false }),
        },
        weatherContext: { snapshot: async () => null },
      };
    },
  };
  const options: PluginManagerOptions = {
    scanRoots: [{ path: pluginRoot, source: "user" }],
    storageRoot,
    runtime: {
      toolRegistry: { register: () => undefined, unregister: () => true },
      channelManager: { has: () => false, register: () => undefined, unregister: async () => true, startOne: async () => undefined },
      registerIpc: (channel, handler) => ipc.set(channel, handler),
      unregisterIpc: (channel) => { ipc.delete(channel); },
      promptRegistry,
      hostServices,
    },
    loadEnabledMap: () => Object.fromEntries(pluginIds.map((id) => [id, true])),
    saveEnabledMap: () => undefined,
  };
  return { manager: new PluginManager(options), options, promptRegistry, caseRoot, storageRoot, ipc, llmCalls, proactiveDeliveries };
}

async function invoke(h: ReturnType<typeof createHarness>, pluginId: string, action: string, data?: unknown) {
  const handler = h.ipc.get(`plugin:${pluginId}:ui`);
  if (!handler) throw new Error(`缺少 ${pluginId} UI IPC`);
  return await handler(action, data) as { ok: boolean; data?: any; error?: string };
}

describe.runIf(enabled)("上游真实 PluginManager 隔离加载", () => {
  beforeAll(() => {
    assertTestRoot();
    if (!existsSync(artifactRoot)) throw new Error("请先构建插件产物");
    rmSync(testRoot, { recursive: true, force: true });
    mkdirSync(testRoot, { recursive: true });
  });
  afterAll(() => {
    assertTestRoot();
    if (existsSync(testRoot) && realpathSync(path.dirname(testRoot)) === realpathSync(path.join(workspace, ".test-runtime"))) {
      rmSync(testRoot, { recursive: true, force: true });
    }
  });

  it("只安装聊天插件时可独立回复，不创建记忆数据", async () => {
    const h = createHarness("chat-only", ["companion-chat"]);
    await h.manager.start();
    try {
      expect(h.manager.overview()).toMatchObject({ issues: [], plugins: [{ id: "companion-chat", status: "running" }] });
      const created = await invoke(h, "companion-chat", "new");
      const sent = await invoke(h, "companion-chat", "send", { sessionId: created.data, text: "隔离测试" });
      expect(sent.ok).toBe(true);
      expect(h.llmCalls).toHaveLength(1);
      expect(h.proactiveDeliveries).toEqual([]);
      expect(await invoke(h, "companion-chat", "save-screen-monitor-settings", { enabled: true })).toMatchObject({ ok: true, data: { enabled: true, running: true } });
      expect(h.llmCalls).toHaveLength(1);
      expect(await invoke(h, "companion-chat", "save-screen-monitor-settings", { enabled: false })).toMatchObject({ ok: true, data: { enabled: false, running: false } });
      expect(existsSync(path.join(h.storageRoot, "companion-memory"))).toBe(false);
    } finally { await h.manager.stop(); }
    expect(h.ipc.size).toBe(0);
  });

  it("只安装记忆插件时可完成注册和状态读取，不调用模型", async () => {
    const h = createHarness("memory-only", ["companion-memory"]);
    await h.manager.start();
    try {
      expect(h.manager.overview()).toMatchObject({ issues: [], plugins: [{ id: "companion-memory", status: "running" }] });
      expect(await invoke(h, "companion-memory", "state")).toMatchObject({ ok: true, data: { autoCompression: { enabled: false, pendingTurns: 0, turnInterval: 20 } } });
      const capacity = await invoke(h, "companion-memory", "preview-capacity");
      expect(capacity).toMatchObject({ ok: true, data: { memoryRevision: 0, lifecycleRevision: 0, activeCount: 0, workingSetCount: 0, toAging: [], toArchive: [] } });
      expect(await invoke(h, "companion-memory", "apply-capacity", capacity.data)).toMatchObject({ ok: false, error: "容量计划参数无效" });
      expect(await invoke(h, "companion-memory", "auto-compression", true)).toMatchObject({ ok: true, data: { enabled: true, turnInterval: 20 } });
      expect(await invoke(h, "companion-memory", "auto-compression-apply", true)).toMatchObject({ ok: true, data: { enabled: true, applyEnabled: true } });
      expect(await invoke(h, "companion-memory", "auto-compression", false)).toMatchObject({ ok: true, data: { enabled: false, pendingTurns: 0 } });
      expect((await invoke(h, "companion-memory", "state")).data.autoCompression).toMatchObject({ enabled: false, applyEnabled: false });
      expect(await invoke(h, "companion-memory", "auto-reflection", true)).toMatchObject({ ok: true, data: { enabled: true, turnInterval: 20 } });
      expect(await invoke(h, "companion-memory", "auto-reflection", false)).toMatchObject({ ok: true, data: { enabled: false, pendingTurns: 0 } });
      expect(await invoke(h, "companion-memory", "auto-lifecycle", true)).toMatchObject({ ok: true, data: { enabled: true, agingCandidates: 0, archivedCandidates: 0 } });
      expect(await invoke(h, "companion-memory", "auto-lifecycle-apply", true)).toMatchObject({ ok: true, data: { enabled: true, applyEnabled: true } });
      expect(await invoke(h, "companion-memory", "auto-lifecycle-apply", false)).toMatchObject({ ok: true, data: { applyEnabled: false } });
      expect(await invoke(h, "companion-memory", "auto-lifecycle", false)).toMatchObject({ ok: true, data: { enabled: false } });
      expect(await invoke(h, "companion-memory", "auto-dream", true)).toMatchObject({ ok: true, data: { enabled: true, idleMs: 900_000, minIntervalMs: 86_400_000 } });
      expect(await invoke(h, "companion-memory", "auto-dream-apply", true)).toMatchObject({ ok: true, data: { enabled: true, applyEnabled: true } });
      expect(await invoke(h, "companion-memory", "auto-compression", true)).toMatchObject({ ok: true, data: { enabled: true, suppressed: true } });
      expect((await invoke(h, "companion-memory", "state")).data.autoCompression).toMatchObject({ enabled: true, suppressed: true, pendingTurns: 0 });
      expect(await invoke(h, "companion-memory", "auto-dream", false)).toMatchObject({ ok: true, data: { enabled: false, applyEnabled: false } });
      expect((await invoke(h, "companion-memory", "state")).data.autoCompression).toMatchObject({ enabled: true, suppressed: false });
      expect(await invoke(h, "companion-memory", "auto-compression", false)).toMatchObject({ ok: true, data: { enabled: false } });
      expect(await invoke(h, "companion-memory", "auto-review", true)).toMatchObject({ ok: true, data: { enabled: true, pendingTurns: 0 } });
      expect(await invoke(h, "companion-memory", "auto-review-apply", true)).toMatchObject({ ok: true, data: { enabled: true, applyEnabled: true } });
      expect(await h.manager.setEnabled("companion-memory", false)).toEqual({ ok: true });
      expect(h.ipc.has("plugin:companion-memory:ui")).toBe(false);
      for (let index = 0; index < 5; index++) {
        await h.manager.publishHostEvent("turn:finished", { eventId: `disabled-${index}`, timestamp: "", runId: "r", mode: "chat", source: "desktop", conversationId: "c", inputMessageId: "m", status: "success" });
      }
      expect(await h.manager.setEnabled("companion-memory", true)).toEqual({ ok: true });
      expect(await invoke(h, "companion-memory", "state")).toMatchObject({ ok: true, data: { autoReview: { enabled: true, applyEnabled: true, pendingTurns: 0 } } });
      expect(await invoke(h, "companion-memory", "auto-review", false)).toMatchObject({ ok: true, data: { enabled: false } });
      expect(await invoke(h, "companion-memory", "state")).toMatchObject({ ok: true, data: { autoReview: { enabled: false, applyEnabled: false } } });
      expect(h.llmCalls).toHaveLength(0);
    } finally { await h.manager.stop(); }
    expect(h.ipc.size).toBe(0);
  });

  it("市场包替换会重载程序并保留私有数据，卸载只清理程序与运行资源", async () => {
    const h = createHarness("market-upgrade-uninstall", []), confirmReplace = vi.fn(async () => true), cleanup = vi.fn(async () => undefined);
    h.options.confirmPluginReplace = confirmReplace;
    h.options.cleanupPersistentResources = cleanup;
    const baseZip = path.join(artifactRoot, "companion-memory.zip");
    const upgradedZip = path.join(h.caseRoot, "companion-memory-upgrade-test.zip");
    const files = unzipSync(new Uint8Array(readFileSync(baseZip))), manifestPath = "companion-memory/manifest.json", manifest = JSON.parse(strFromU8(files[manifestPath]));
    const baseVersion = manifest.version as string, [major, minor, patch] = baseVersion.split(".").map(Number), upgradedVersion = `${major}.${minor}.${patch + 1}-test`;
    manifest.version = upgradedVersion;
    writeFileSync(upgradedZip, zipSync({ ...files, [manifestPath]: strToU8(JSON.stringify(manifest, null, 2)) }));

    await h.manager.start();
    try {
      expect(await h.manager.installZip(baseZip, { expectedIdentity: { id: "companion-memory", version: baseVersion }, origin: "market" })).toMatchObject({ ok: true, plugin: { id: "companion-memory", version: baseVersion } });
      expect(h.manager.list()).toEqual([expect.objectContaining({ id: "companion-memory", origin: "market", status: "disabled" })]);
      expect(await h.manager.setEnabled("companion-memory", true)).toEqual({ ok: true });
      expect(await invoke(h, "companion-memory", "edit-profile", { layer: "L0", field: "preferredName", content: "隔离升级资料", revision: 0 })).toMatchObject({ ok: true });
      const statePath = path.join(h.storageRoot, "companion-memory", "memory-state.json"), stateBefore = readFileSync(statePath, "utf8");

      expect(await h.manager.installZip(upgradedZip, { expectedIdentity: { id: "companion-memory", version: upgradedVersion }, origin: "market" })).toMatchObject({ ok: true, plugin: { id: "companion-memory", version: upgradedVersion } });
      expect(confirmReplace).toHaveBeenCalledOnce();
      expect(h.manager.list()).toEqual([expect.objectContaining({ id: "companion-memory", version: upgradedVersion, origin: "market", status: "running" })]);
      expect(await invoke(h, "companion-memory", "state")).toMatchObject({ ok: true, data: { profiles: { l0: { preferredName: { content: "隔离升级资料" } } } } });
      expect(readFileSync(statePath, "utf8")).toBe(stateBefore);
      expect(h.llmCalls).toHaveLength(0);

      expect(await h.manager.uninstall("companion-memory")).toMatchObject({ ok: true, overview: { plugins: [] } });
      expect(cleanup).toHaveBeenCalledWith("companion-memory");
      expect(existsSync(path.join(h.caseRoot, "plugins", "companion-memory"))).toBe(false);
      expect(existsSync(statePath)).toBe(true);
      expect(readFileSync(statePath, "utf8")).toBe(stateBefore);
      expect(h.ipc.has("plugin:companion-memory:ui")).toBe(false);
    } finally { await h.manager.stop(); }
    expect(h.ipc.size).toBe(0);
  });

  it("两个本地发布 ZIP 可从空宿主导入、显式启用并共同运行", async () => {
    const h = createHarness("fresh-local-zip-install", []);
    await h.manager.start();
    try {
      for (const pluginId of ["companion-memory", "companion-chat"]) {
        const manifest = JSON.parse(readFileSync(path.join(artifactRoot, pluginId, "manifest.json"), "utf8"));
        expect(await h.manager.installZip(path.join(artifactRoot, `${pluginId}.zip`))).toMatchObject({
          ok: true,
          plugin: { id: pluginId, version: manifest.version },
        });
      }
      expect(h.manager.list().map((plugin) => [plugin.id, plugin.status]).sort()).toEqual([
        ["companion-chat", "disabled"], ["companion-memory", "disabled"],
      ]);

      expect(await h.manager.setEnabled("companion-memory", true)).toEqual({ ok: true });
      expect(await h.manager.setEnabled("companion-chat", true)).toEqual({ ok: true });
      expect(h.manager.overview().issues).toEqual([]);
      expect(h.manager.list().map((plugin) => [plugin.id, plugin.status]).sort()).toEqual([
        ["companion-chat", "running"], ["companion-memory", "running"],
      ]);
      expect(await invoke(h, "companion-memory", "state")).toMatchObject({ ok: true, data: { entries: [] } });
      expect(await invoke(h, "companion-chat", "state")).toMatchObject({ ok: true, data: { memoryEnabled: false } });

      const prompt = await h.promptRegistry.build({
        source: "conversation", mode: "chat", chatBackend: "companion",
        userText: "白厄是谁", conversationId: "fresh-install", runId: "fresh-install-run",
      });
      expect(prompt).toContain("plugin:companion-chat:life-context");
      expect(prompt).toContain("plugin:companion-chat:worldbook");
    } finally { await h.manager.stop(); }
    expect(h.ipc.size).toBe(0);
  });

  it("两个构建产物按 life、memory、WorldBook 的显式优先级拼接", async () => {
    const h = createHarness("prompt-provider-order", ["companion-chat", "companion-memory"]);
    await h.manager.start();
    try {
      const sourcePath = path.join(h.caseRoot, "memory.json");
      writeFileSync(sourcePath, JSON.stringify({
        l0: { preferredName: "", occupation: "", longTermInterests: "", language: "", permanentNote: "", updatedAt: 10 },
        l1: { recentGoals: "", recentPreferences: "", currentProject: "", generatedAt: 10 },
        l2: [{ id: "synthetic-tea", content: "用户偏爱乌龙茶", createdAt: 10, sourceAt: 10, status: "active", sourceQuote: "我喜欢乌龙茶", sourceConversationId: "synthetic" }],
        evidence: [],
      }));
      const preview = await invoke(h, "companion-memory", "preview-legacy-import", { sourcePath });
      const state = await invoke(h, "companion-memory", "state");
      expect(await invoke(h, "companion-memory", "import-legacy", {
        sourcePath, sourceHash: preview.data.sourceHash, revision: state.data.revision,
      })).toMatchObject({ ok: true });
      expect(await invoke(h, "companion-memory", "save-native-integration", {
        captureEnabled: false, autoExtractEnabled: false, promptInjectionEnabled: true,
        momentsInjectionEnabled: false, socialContextEnabled: false,
      })).toMatchObject({ ok: true });

      const prompt = await h.promptRegistry.build({
        source: "conversation", mode: "chat", chatBackend: "companion",
        userText: "白厄也喜欢乌龙茶吗", conversationId: "chat-order", runId: "run-order",
      });
      const life = prompt.indexOf("plugin:companion-chat:life-context");
      const memory = prompt.indexOf("plugin:companion-memory:memory-context");
      const worldbook = prompt.indexOf("plugin:companion-chat:worldbook");
      expect(life).toBeGreaterThanOrEqual(0);
      expect(memory).toBeGreaterThan(life);
      expect(worldbook).toBeGreaterThan(memory);
      expect(prompt).toContain("用户偏爱乌龙茶");
      expect(prompt).toContain("【白厄 / Phainon】");
    } finally { await h.manager.stop(); }
    expect(h.ipc.size).toBe(0);
  });

  it("两个插件显式联动后完成合成记忆检索注入、回复保存且不推进关闭的 DMAE", async () => {
    const h = createHarness("linked", ["companion-chat", "companion-memory"]);
    await h.manager.start();
    try {
      expect(h.manager.overview().issues).toEqual([]);
      expect(h.manager.list().map((p) => [p.id, p.status]).sort()).toEqual([
        ["companion-chat", "running"], ["companion-memory", "running"],
      ]);
      const sourcePath = path.join(h.caseRoot, "memory.json");
      writeFileSync(sourcePath, JSON.stringify({
        l0: { preferredName: "", occupation: "", longTermInterests: "", language: "", permanentNote: "", updatedAt: 10 },
        l1: { recentGoals: "", recentPreferences: "", currentProject: "", generatedAt: 10 },
        l2: [{ id: "synthetic-tea", content: "用户偏爱乌龙茶", createdAt: 10, sourceAt: 10, status: "active", sourceQuote: "我喜欢乌龙茶", sourceConversationId: "synthetic" }],
        evidence: [],
      }));
      const preview = await invoke(h, "companion-memory", "preview-legacy-import", { sourcePath });
      expect(preview).toMatchObject({ ok: true, data: { canImport: true } });
      const empty = await invoke(h, "companion-memory", "state");
      const imported = await invoke(h, "companion-memory", "import-legacy", { sourcePath, sourceHash: preview.data.sourceHash, revision: empty.data.revision });
      expect(imported).toMatchObject({ ok: true, data: { importedEntries: 1 } });
      const before = await invoke(h, "companion-memory", "state");
      expect(before.data.dmae).toMatchObject({ enabled: false, round: 0, tracked: 0 });

      expect((await invoke(h, "companion-chat", "save-memory-link", { enabled: true })).ok).toBe(true);
      const recalledSession = await invoke(h, "companion-chat", "new");
      const reply = await invoke(h, "companion-chat", "send", { sessionId: recalledSession.data, text: "乌龙茶" });
      expect(reply.ok).toBe(true);
      const chatCall = [...h.llmCalls].reverse().find((call: any) => call.pluginId === "companion-chat") as any;
      const injected = chatCall.messages.find((message: any) => message.role === "system" && message.content.includes("以下是检索资料"));
      expect(injected.content).toContain("用户偏爱乌龙茶");
      const chatState = await invoke(h, "companion-chat", "state");
      expect(chatState.data.chat.sessions.find((session: any) => session.id === recalledSession.data).messages.at(-1)).toMatchObject({ role: "assistant", text: "隔离模型回复", status: "complete" });
      const after = await invoke(h, "companion-memory", "state");
      expect(after.data.dmae).toEqual(before.data.dmae);
      expect(h.llmCalls.filter((call: any) => call.pluginId === "companion-memory")).toHaveLength(0);
      expect(readFileSync(path.join(h.storageRoot, "companion-memory", "memory-state.json"), "utf8")).toContain("用户偏爱乌龙茶");
    } finally { await h.manager.stop(); }
    expect(h.ipc.size).toBe(0);
  });

  it("原生 Chat 落盘确认后摄取合成轮次，并在下一轮通过官方 Provider 注入历史", async () => {
    const h = createHarness("native-turn-to-prompt", ["companion-memory"], [
      { id: "user-1", role: "user", text: "我喜欢乌龙茶", at: "2026-09-13T09:00:00Z" },
      { id: "assistant-1", role: "assistant", text: "记住了", at: "2026-09-13T09:00:01Z" },
    ]);
    await h.manager.start();
    const lifecycle = createPendingTurnLifecycle({ publisher: createLifecyclePublisher({
      publish: (event, payload) => h.manager.publishHostEvent(event, payload),
      eventId: () => "synthetic-native-turn",
      now: () => new Date("2026-09-13T09:00:02Z"),
    }) });
    try {
      expect(await invoke(h, "companion-memory", "save-native-integration", {
        captureEnabled: true, autoExtractEnabled: false, promptInjectionEnabled: true,
        momentsInjectionEnabled: false,
      })).toMatchObject({ ok: true });
      lifecycle.beginTurn({ runId: "run-1", conversationId: "chat-1", mode: "chat",
        inputMessageId: "user-1", assistantMessageId: "assistant-1", chatBackend: "companion", startedAt: Date.now() });
      lifecycle.settleTerminal("run-1", { status: "success" });
      const promptInput = { source: "conversation" as const, mode: "chat" as const,
        chatBackend: "companion" as const, userText: "乌龙茶", conversationId: "chat-1" };
      expect(await h.promptRegistry.build(promptInput)).toBe("");
      expect((await invoke(h, "companion-memory", "state")).data.turns).toHaveLength(0);

      lifecycle.confirmPersistence("run-1", { finalMessageId: "assistant-1" });
      await vi.waitFor(async () => {
        expect((await invoke(h, "companion-memory", "state")).data.native.completed).toBe(1);
      });
      const state = await invoke(h, "companion-memory", "state");
      expect(state.data.turns).toEqual([expect.objectContaining({
        id: "host:synthetic-native-turn", sessionId: "chat-1", origin: "host",
        inputMessageId: "user-1", finalMessageId: "assistant-1",
      })]);
      const prompt = await h.promptRegistry.build(promptInput);
      expect(prompt).toContain("我喜欢乌龙茶");
      expect(prompt).toContain("助手（非用户事实）：记住了");
      expect(await h.promptRegistry.build({ ...promptInput, mode: "work" })).toBe("");
      expect(h.llmCalls).toHaveLength(0);
    } finally { lifecycle.disposeAll(); await h.manager.stop(); }
  });
});
