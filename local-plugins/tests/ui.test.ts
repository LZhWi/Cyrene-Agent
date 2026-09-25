import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
// jsdom 仅用于测试，不进入插件产物；无需启动 Electron 或读取真实 userData。
const { JSDOM } = require("jsdom");

describe("聊天界面的模型来源入口", () => {
  it("复选框不会继承文本输入框的宽度", () => {
    const css = readFileSync(path.resolve("plugins/companion-memory/static/ui.css"), "utf8");
    expect(css).toContain('input:not([type="checkbox"])');
    expect(css).toContain('input[type="checkbox"]{width:auto');
  });
  it("原生读取、模型提取、回复、对话连续性与 Moments 注入分别说明影响并要求确认", async () => {
    const root = path.resolve("plugins/companion-memory/static");
    const dom = new JSDOM(readFileSync(path.join(root, "ui.html"), "utf8"), { runScripts: "outside-only" });
    const w = dom.window, calls: any[] = [], confirmations: string[] = [];
    const state = {
      revision: 0, pending: 0, turns: [], entries: [], evidence: [],
      profiles: { l0: {}, l1: {}, l0Locked: false },
      native: { settings: { captureEnabled: false, autoExtractEnabled: false, promptInjectionEnabled: false, momentsInjectionEnabled: false, socialContextEnabled: false }, pending: 0, completed: 0 },
    };
    w.companion = { invoke: async (action: string, data: any) => {
      calls.push({ action, data });
      if (action === "state" || action === "save-native-integration") return { ok: true, data: state };
      return { ok: false, error: "unexpected" };
    } };
    w.eval(readFileSync(path.join(root, "ui.js"), "utf8"));
    const el = (id: string) => w.document.getElementById(id) as any;
    await vi.waitFor(() => expect(el("native-status").textContent).toContain("读取已关闭"));
    el("native-capture").checked = true;
    el("native-auto-extract").checked = true;
    el("native-prompt-injection").checked = true;
    el("native-social-context").checked = true;
    el("native-moments-injection").checked = true;
    w.confirm = (message: string) => { confirmations.push(message); return confirmations.length > 1; };
    await el("native-integration-form").onsubmit({ preventDefault() {} });
    expect(calls.some((call) => call.action === "save-native-integration")).toBe(false);

    confirmations.length = 0;
    w.confirm = (message: string) => { confirmations.push(message); return true; };
    el("native-capture").checked = true;
    el("native-auto-extract").checked = true;
    el("native-prompt-injection").checked = true;
    el("native-social-context").checked = true;
    el("native-moments-injection").checked = true;
    await el("native-integration-form").onsubmit({ preventDefault() {} });
    expect(confirmations).toHaveLength(5);
    expect(confirmations[0]).toContain("复制到插件私有存储");
    expect(confirmations[1]).toContain("发送给主程序当前模型");
    expect(confirmations[1]).toContain("10 个待处理轮次");
    expect(confirmations[1]).toContain("最多 2 轮前置上下文");
    expect(confirmations[2]).toContain("命中结果作为参考资料");
    expect(confirmations[3]).toContain("每个成功落盘");
    expect(confirmations[3]).toContain("额外调用一次主程序当前模型");
    expect(confirmations[4]).toContain("动态发帖决策");
    expect(confirmations[4]).toContain("对话摘录还会发送");
    expect(calls).toContainEqual({ action: "save-native-integration", data: { captureEnabled: true, autoExtractEnabled: true, promptInjectionEnabled: true, momentsInjectionEnabled: true, socialContextEnabled: true } });
    dom.window.close();
  });
  it("提取失败且接入队列为空时仍可从界面重试", async () => {
    const root = path.resolve("plugins/companion-memory/static");
    const dom = new JSDOM(readFileSync(path.join(root, "ui.html"), "utf8"), { runScripts: "outside-only" });
    const w = dom.window;
    const calls: string[] = [];
    const state = {
      revision: 0, pending: 10, turns: [], entries: [], evidence: [],
      profiles: { l0: {}, l1: {}, l0Locked: false },
      native: {
        settings: { captureEnabled: true, autoExtractEnabled: true, promptInjectionEnabled: false, momentsInjectionEnabled: false, socialContextEnabled: false },
        pending: 0, completed: 10, lastError: { eventId: "event-9", kind: "extract", at: Date.now() }, processing: false,
      },
    };
    w.companion = { invoke: async (action: string) => {
      calls.push(action);
      if (action === "retry-native-integration") state.native.processing = true;
      return { ok: true, data: state };
    } };
    w.eval(readFileSync(path.join(root, "ui.js"), "utf8"));
    const button = w.document.getElementById("native-retry") as any;
    await vi.waitFor(() => expect(button.disabled).toBe(false));
    await button.onclick();
    expect(calls).toContain("retry-native-integration");
    expect(button.disabled).toBe(true);
    dom.window.close();
  });
  it("后台复核、压缩、生命周期扫描和自动降级分别授权", async () => {
    const root = path.resolve("plugins/companion-memory/static");
    const dom = new JSDOM(readFileSync(path.join(root, "ui.html"), "utf8"), { runScripts: "outside-only" });
    const w = dom.window, calls: any[] = [], confirmations: string[] = [];
    const state = {
      revision: 0, pending: 0, turns: [], entries: [], evidence: [],
      profiles: { l0: {}, l1: {}, l0Locked: false },
      autoReview: { enabled: false, applyEnabled: false, running: false, pendingTurns: 0, turnInterval: 5, handledItemIds: [] },
      autoCompression: { enabled: false, applyEnabled: false, running: false, pendingTurns: 0, turnInterval: 20, handledCandidateIds: [] },
      autoReflection: { enabled: false, running: false, pendingTurns: 0, turnInterval: 20 },
      autoLifecycle: { enabled: false, applyEnabled: false, agingCandidates: 0, archivedCandidates: 0, intervalMs: 86_400_000 },
      autoDream: { enabled: false, applyEnabled: false, running: false, idleMs: 900_000, minIntervalMs: 86_400_000 },
    };
    w.companion = { invoke: async (action: string, data: any) => {
      calls.push({ action, data });
      if (action === "preview-capacity") return { ok: true, data: { memoryRevision: 0, lifecycleRevision: 0, token: "capacity-token", activeCount: 301, activeCap: 300, workingSetCount: 801, totalCap: 800, toAging: [{ id: "a", status: "active", weight: 0, score: 0, content: "旧记忆" }], toArchive: [] } };
      if (action === "apply-capacity") return { ok: true, data: { agingApplied: 1, archivedApplied: 0 } };
      if (action === "state" || action === "auto-review" || action === "auto-review-apply" || action === "auto-compression" || action === "auto-compression-apply" || action === "auto-reflection" || action === "auto-lifecycle" || action === "auto-lifecycle-apply" || action === "auto-dream" || action === "auto-dream-apply") return { ok: true, data: state };
      return { ok: false, error: "unexpected" };
    } };
    w.eval(readFileSync(path.join(root, "ui.js"), "utf8"));
    const el = (id: string) => w.document.getElementById(id) as any;
    await vi.waitFor(() => expect(el("auto-review-status").textContent).toContain("已关闭"));

    el("auto-review").checked = true;
    w.confirm = (message: string) => { confirmations.push(message); return false; };
    await el("auto-review").onchange();
    expect(calls.some((call) => call.action === "auto-review")).toBe(false);
    expect(el("auto-review").checked).toBe(false);
    expect(confirmations[0]).toContain("每累计 5 个成功桌面聊天轮次");
    expect(confirmations[0]).toContain("发送给当前宿主官方模型服务");
    expect(confirmations[0]).toContain("不会自动归档、合并或修改记忆");

    el("auto-review").checked = true;
    w.confirm = () => true;
    await el("auto-review").onchange();
    expect(calls).toContainEqual({ action: "auto-review", data: true });

    confirmations.length = 0;
    el("auto-review-apply").checked = true;
    w.confirm = (message: string) => { confirmations.push(message); return false; };
    await el("auto-review-apply").onchange();
    expect(calls.some((call) => call.action === "auto-review-apply")).toBe(false);
    expect(confirmations[0]).toContain("置信度至少 0.90");
    expect(confirmations[0]).toContain("直接冲突");
    el("auto-review-apply").checked = true;
    w.confirm = () => true;
    await el("auto-review-apply").onchange();
    expect(calls).toContainEqual({ action: "auto-review-apply", data: true });

    confirmations.length = 0;
    el("auto-compression").checked = true;
    w.confirm = (message: string) => { confirmations.push(message); return false; };
    await el("auto-compression").onchange();
    expect(calls.some((call) => call.action === "auto-compression")).toBe(false);
    expect(el("auto-compression").checked).toBe(false);
    expect(confirmations[0]).toContain("每累计 20 个成功桌面聊天轮次");
    expect(confirmations[0]).toContain("aging、非置顶");
    expect(confirmations[0]).toContain("不会自动创建总结、合并来源记忆或改变任何状态");

    el("auto-compression").checked = true;
    w.confirm = () => true;
    await el("auto-compression").onchange();
    expect(calls).toContainEqual({ action: "auto-compression", data: true });

    confirmations.length = 0;
    el("auto-compression-mode").value = "auto";
    w.confirm = (message: string) => { confirmations.push(message); return false; };
    await el("auto-compression-mode").onchange();
    expect(calls.some((call) => call.action === "auto-compression-apply")).toBe(false);
    expect(el("auto-compression-mode").value).toBe("manual");
    expect(confirmations[0]).toContain("至少 3 条 aging");
    expect(confirmations[0]).toContain("置信度至少 0.80");
    expect(confirmations[0]).toContain("严格撤销");
    el("auto-compression-mode").value = "auto";
    w.confirm = () => true;
    await el("auto-compression-mode").onchange();
    expect(calls).toContainEqual({ action: "auto-compression-apply", data: true });
    el("auto-compression-mode").value = "manual";
    await el("auto-compression-mode").onchange();
    expect(calls).toContainEqual({ action: "auto-compression-apply", data: false });

    confirmations.length = 0;
    el("auto-reflection").checked = true;
    w.confirm = (message: string) => { confirmations.push(message); return false; };
    await el("auto-reflection").onchange();
    expect(calls.some((call) => call.action === "auto-reflection")).toBe(false);
    expect(confirmations[0]).toContain("每累计 20 个成功桌面聊天轮次");
    expect(confirmations[0]).toContain("带原话或证据");
    expect(confirmations[0]).toContain("不会新增空字段、直接覆盖画像");
    el("auto-reflection").checked = true; w.confirm = () => true;
    await el("auto-reflection").onchange();
    expect(calls).toContainEqual({ action: "auto-reflection", data: true });

    confirmations.length = 0;
    el("auto-lifecycle").checked = true;
    w.confirm = (message: string) => { confirmations.push(message); return false; };
    await el("auto-lifecycle").onchange();
    expect(calls.some((call) => call.action === "auto-lifecycle")).toBe(false);
    expect(el("auto-lifecycle").checked).toBe(false);
    expect(confirmations[0]).toContain("每 24 小时最多一次");
    expect(confirmations[0]).toContain("只保存候选数量");
    expect(confirmations[0]).toContain("不会自动改变任何记忆状态");

    el("auto-lifecycle").checked = true;
    w.confirm = () => true;
    await el("auto-lifecycle").onchange();
    expect(calls).toContainEqual({ action: "auto-lifecycle", data: true });

    confirmations.length = 0;
    el("auto-lifecycle-apply").checked = true;
    w.confirm = (message: string) => { confirmations.push(message); return false; };
    await el("auto-lifecycle-apply").onchange();
    expect(calls.some((call) => call.action === "auto-lifecycle-apply")).toBe(false);
    expect(confirmations[0]).toContain("自动修改插件私有记忆状态");
    expect(confirmations[0]).toContain("每批都有可撤销快照");

    el("auto-lifecycle-apply").checked = true;
    w.confirm = () => true;
    await el("auto-lifecycle-apply").onchange();
    expect(calls).toContainEqual({ action: "auto-lifecycle-apply", data: true });

    await el("capacity-preview").onclick();
    expect(calls).toContainEqual({ action: "preview-capacity", data: undefined });
    expect(el("capacity-preview-result").textContent).toContain("active 301/300");
    expect(el("capacity-preview-result").textContent).toContain("旧记忆");
    confirmations.length = 0;
    w.confirm = (message: string) => { confirmations.push(message); return false; };
    await el("capacity-apply").onclick();
    expect(calls.some((call) => call.action === "apply-capacity")).toBe(false);
    expect(confirmations[0]).toContain("仅改变插件私有状态");
    w.confirm = () => true;
    await el("capacity-apply").onclick();
    expect(calls).toContainEqual({ action: "apply-capacity", data: expect.objectContaining({ memoryRevision: 0, lifecycleRevision: 0, token: "capacity-token" }) });

    confirmations.length = 0;
    el("auto-dream").checked = true;
    w.confirm = (message: string) => { confirmations.push(message); return false; };
    await el("auto-dream").onchange();
    expect(calls.some((call) => call.action === "auto-dream")).toBe(false);
    expect(el("auto-dream").checked).toBe(false);
    expect(confirmations[0]).toContain("连续 15 分钟没有新活动");
    expect(confirmations[0]).toContain("系统级真实空闲状态不可用");
    expect(confirmations[0]).toContain("先按 300/800 容量规则");
    expect(confirmations[0]).toContain("最多生成 5 组安全压缩建议");
    expect(confirmations[0]).toContain("叙事保存和压缩应用仍由各自独立设置决定");

    el("auto-dream").checked = true;
    w.confirm = () => true;
    await el("auto-dream").onchange();
    expect(calls).toContainEqual({ action: "auto-dream", data: true });

    confirmations.length = 0;
    el("auto-dream-apply").checked = true;
    w.confirm = (message: string) => { confirmations.push(message); return false; };
    await el("auto-dream-apply").onchange();
    expect(calls.some((call) => call.action === "auto-dream-apply")).toBe(false);
    expect(confirmations[0]).toContain("自动保存");
    expect(confirmations[0]).toContain("不会修改来源记忆");
    el("auto-dream-apply").checked = true;
    w.confirm = () => true;
    await el("auto-dream-apply").onchange();
    expect(calls).toContainEqual({ action: "auto-dream-apply", data: true });
    dom.window.close();
  });
  it("历史消息正文预检和来源绑定都需要确认，候选只按纯文本显示", async () => {
    const root = path.resolve("plugins/companion-memory/static");
    const dom = new JSDOM(readFileSync(path.join(root, "ui.html"), "utf8"), { runScripts: "outside-only" });
    const w = dom.window, calls: any[] = [];
    const state = { revision: 0, pending: 0, turns: [], entries: [], evidence: [], profiles: { l0: {}, l1: {}, l0Locked: false } };
    const preview = { id: "preview-1", revision: 0, conversationIds: ["s1"], counts: { ambiguous: 1 }, unique: 0, results: [{ entryId: "m1", content: "记忆", trigger: "片段", method: "ambiguous", totalCandidates: 1, candidates: [{ conversationId: "s1", messageId: "u1", at: 1000, text: '<img src=x onerror="bad()">', before: "前文", after: "后文" }] }] };
    w.companion = { invoke: async (action: string, data: any) => {
      calls.push({ action, data });
      if (action === "state") return { ok: true, data: state };
      if (action === "list-native-conversations") return { ok: true, data: [{ id: "s1", title: "会话", mode: "chat", updatedAt: "2026-09-01T00:00:00Z" }] };
      if (action === "preview-native-history") return { ok: true, data: preview };
      if (action === "review-native-history-ambiguity") return { ok: true, data: { recommended: true, multipleSupported: false, preview: { ...preview, results: [{ ...preview.results[0], recommendation: { conversationId: "s1", messageId: "u1", locateConfidence: 0.9, verifyConfidence: 0.95 } }] } } };
      if (action === "apply-native-history-selection") return { ok: true, data: { bound: 1, revision: 1, preview: { ...preview, revision: 1, counts: {}, results: [] } } };
      return { ok: false, error: "unexpected" };
    } };
    w.eval(readFileSync(path.join(root, "ui.js"), "utf8"));
    const el = (id: string) => w.document.getElementById(id) as any;
    await vi.waitFor(() => expect(el("status")).not.toBeNull());
    await el("history-load-conversations").onclick();
    expect(el("history-conversations").options).toHaveLength(1);
    el("history-conversations").options[0].selected = true;
    w.confirm = () => false;
    await el("history-preview-form").onsubmit({ preventDefault() {} });
    expect(calls.some((call) => call.action === "preview-native-history")).toBe(false);
    w.confirm = () => true;
    await el("history-preview-form").onsubmit({ preventDefault() {} });
    expect(calls).toContainEqual({ action: "preview-native-history", data: { conversationIds: ["s1"] } });
    expect(el("history-results").querySelector("img")).toBeNull();
    expect(el("history-results").textContent).toContain("<img");
    const review = el("history-results").querySelectorAll("button")[1];
    w.confirm = () => false; await review.onclick();
    expect(calls.some((call) => call.action === "review-native-history-ambiguity")).toBe(false);
    w.confirm = () => true; await review.onclick();
    expect(calls).toContainEqual({ action: "review-native-history-ambiguity", data: { previewId: "preview-1", entryId: "m1" } });
    expect(el("history-results").textContent).toContain("模型复核推荐");
    const bind = el("history-results").querySelector("button");
    w.confirm = () => false; await bind.onclick();
    expect(calls.some((call) => call.action === "apply-native-history-selection")).toBe(false);
    w.confirm = () => true; await bind.onclick();
    expect(calls).toContainEqual({ action: "apply-native-history-selection", data: { previewId: "preview-1", entryId: "m1", conversationId: "s1", messageId: "u1" } });
    dom.window.close();
  });
  it("向量导入和 Embedding 外发都要求独立确认，密钥框不会回填", async () => {
    const root = path.resolve("plugins/companion-memory/static");
    const dom = new JSDOM(readFileSync(path.join(root, "ui.html"), "utf8"), { runScripts: "outside-only" });
    const w = dom.window, calls: any[] = [];
    const state = { revision: 1, pending: 0, turns: [], entries: [], evidence: [], profiles: { l0: {}, l1: {}, l0Locked: false }, legacyImport: { sourceHash: "m" }, embedding: { enabled: false, baseUrl: "", model: "", dimensions: 1024, hasKey: true }, vectorIndex: { imported: false, entries: 0 }, defaultLegacyVectorPath: "C:\\safe\\memory-store.json" };
    w.companion = { invoke: async (action: string, data: any) => {
      calls.push({ action, data });
      if (action === "state") return { ok: true, data: state };
      if (action === "preview-legacy-vectors") return { ok: true, data: { sourceBytes: 100, sourceHash: "a".repeat(64), total: 3, userMemory: 1, usable: 1, invalid: 0, duplicateL2Ids: 0, unmatchedL2Ids: 0, dimensions: [1024], canImport: true } };
      if (action === "import-legacy-vectors") return { ok: true, data: { entries: 1, dimensions: 1024 } };
      if (action === "save-embedding" || action === "test-embedding") return { ok: true, data: { dimensions: 1024 } };
      return { ok: false, error: "unexpected" };
    } };
    w.eval(readFileSync(path.join(root, "ui.js"), "utf8")); const el = (id: string) => w.document.getElementById(id);
    await vi.waitFor(() => expect((el("vector-source") as any).value).toBe("C:\\safe\\memory-store.json"));
    w.confirm = () => false; await (el("vector-preview-form") as any).onsubmit({ preventDefault() {} });
    expect(calls.some((c) => c.action === "preview-legacy-vectors")).toBe(false);
    w.confirm = () => true; await (el("vector-preview-form") as any).onsubmit({ preventDefault() {} }); await (el("vector-import") as any).onclick();
    expect(calls.some((c) => c.action === "import-legacy-vectors" && c.data.sourceHash === "a".repeat(64))).toBe(true);
    (el("embedding-enabled") as any).checked = true; (el("embedding-url") as any).value = "https://example.invalid/v1"; (el("embedding-model") as any).value = "embed"; (el("embedding-key") as any).value = "ui-secret";
    w.confirm = () => false; await (el("embedding-form") as any).onsubmit({ preventDefault() {} }); expect(calls.some((c) => c.action === "save-embedding")).toBe(false);
    w.confirm = () => true; await (el("embedding-form") as any).onsubmit({ preventDefault() {} });
    expect(calls.some((c) => c.action === "save-embedding" && c.data.apiKey === "ui-secret")).toBe(true); expect((el("embedding-key") as any).value).toBe("");
    dom.window.close();
  });
  it("记忆正文自动补向量使用独立开关，拒绝确认时不保存授权", async () => {
    const root = path.resolve("plugins/companion-memory/static");
    const dom = new JSDOM(readFileSync(path.join(root, "ui.html"), "utf8"), { runScripts: "outside-only" });
    const w = dom.window, calls: any[] = [], confirmations: string[] = [];
    const state = {
      revision: 0, pending: 0, turns: [], entries: [], evidence: [],
      profiles: { l0: {}, l1: {}, l0Locked: false },
      embedding: { enabled: true, baseUrl: "https://example.invalid/v1", model: "embed", dimensions: 64, hasKey: true },
      vectorIndex: { imported: false, entries: 0, legacyEntries: 0, generatedEntries: 0 },
      semanticIndex: { enabled: false, pending: 0, processing: false, generatedEntries: 0 },
    };
    w.companion = { invoke: async (action: string, data: any) => {
      calls.push({ action, data });
      if (action === "state" || action === "save-semantic-index") return { ok: true, data: state };
      return { ok: false, error: "unexpected" };
    } };
    w.eval(readFileSync(path.join(root, "ui.js"), "utf8"));
    const el = (id: string) => w.document.getElementById(id) as any;
    await vi.waitFor(() => expect(el("semantic-index-status").textContent).toContain("已关闭"));
    el("semantic-index-enabled").checked = true;
    w.confirm = (message: string) => { confirmations.push(message); return false; };
    await el("semantic-index-form").onsubmit({ preventDefault() {} });
    expect(calls.some((call) => call.action === "save-semantic-index")).toBe(false);
    expect(confirmations[0]).toContain("既有缺失向量");
    expect(confirmations[0]).toContain("自动补齐");
    expect(confirmations[0]).toContain("L2 摘要正文");
    expect(confirmations[0]).toContain("不会发送原话、证据");

    el("semantic-index-enabled").checked = true;
    w.confirm = () => true;
    await el("semantic-index-form").onsubmit({ preventDefault() {} });
    expect(calls).toContainEqual({ action: "save-semantic-index", data: { enabled: true } });
    dom.window.close();
  });
  it("既有摘要补建先预检并选择范围，最终外发需要再次确认", async () => {
    const root = path.resolve("plugins/companion-memory/static");
    const dom = new JSDOM(readFileSync(path.join(root, "ui.html"), "utf8"), { runScripts: "outside-only" });
    const w = dom.window, calls: any[] = [], confirmations: string[] = [];
    const state = {
      revision: 0, pending: 0, turns: [], entries: [], evidence: [], profiles: { l0: {}, l1: {}, l0Locked: false },
      embedding: { enabled: true, baseUrl: "https://example.invalid/v1", model: "embed", dimensions: 64, hasKey: true },
      vectorIndex: { imported: false, entries: 0, legacyEntries: 0, generatedEntries: 0 },
      semanticIndex: { enabled: true, pending: 0, processing: false, generatedEntries: 0 },
    };
    const preview = { id: "backfill-1", revision: 0, eligible: 2, alreadyCurrent: 0, missing: 2, truncated: false, maxSelection: 100, entries: [{ id: "m1", content: "摘要一" }, { id: "m2", content: "摘要二" }] };
    w.companion = { invoke: async (action: string, data: any) => {
      calls.push({ action, data });
      if (action === "state") return { ok: true, data: state };
      if (action === "preview-semantic-backfill") return { ok: true, data: preview };
      if (action === "apply-semantic-backfill") return { ok: true, data: { queued: data.entryIds.length } };
      return { ok: false, error: "unexpected" };
    } };
    w.eval(readFileSync(path.join(root, "ui.js"), "utf8"));
    const el = (id: string) => w.document.getElementById(id) as any;
    await vi.waitFor(() => expect(el("semantic-index-status").textContent).toContain("已启用"));
    await el("semantic-backfill-preview").onclick();
    expect(confirmations).toHaveLength(0);
    expect(el("semantic-backfill-entries").options).toHaveLength(2);
    el("semantic-backfill-entries").options[1].selected = true;
    w.confirm = (message: string) => { confirmations.push(message); return false; };
    await el("semantic-backfill-form").onsubmit({ preventDefault() {} });
    expect(calls.some((call) => call.action === "apply-semantic-backfill")).toBe(false);
    expect(confirmations[0]).toContain("1 条既有 L2 摘要正文");
    expect(confirmations[0]).toContain("不会发送原话、证据");
    w.confirm = () => true;
    await el("semantic-backfill-form").onsubmit({ preventDefault() {} });
    expect(calls).toContainEqual({ action: "apply-semantic-backfill", data: { previewId: "backfill-1", entryIds: ["m2"] } });
    dom.window.close();
  });
  it("模型重排使用独立授权并明确排除原生注入和证据正文", async () => {
    const root = path.resolve("plugins/companion-memory/static");
    const dom = new JSDOM(readFileSync(path.join(root, "ui.html"), "utf8"), { runScripts: "outside-only" });
    const w = dom.window, calls: any[] = [], confirmations: string[] = [];
    const state = { revision: 0, pending: 0, turns: [], entries: [], evidence: [], profiles: { l0: {}, l1: {}, l0Locked: false }, reranker: { enabled: false } };
    w.companion = { invoke: async (action: string, data: any) => {
      calls.push({ action, data });
      if (action === "state" || action === "reranker") return { ok: true, data: state };
      return { ok: false, error: "unexpected" };
    } };
    w.eval(readFileSync(path.join(root, "ui.js"), "utf8"));
    const el = (id: string) => w.document.getElementById(id) as any;
    await vi.waitFor(() => expect(el("reranker-status").textContent).toContain("已关闭"));
    el("reranker-enabled").checked = true;
    w.confirm = (message: string) => { confirmations.push(message); return false; };
    await el("reranker-enabled").onchange();
    expect(calls.some((call) => call.action === "reranker")).toBe(false);
    expect(confirmations[0]).toContain("最多 12 条非置顶 L2 摘要正文");
    expect(confirmations[0]).toContain("不会发送原话、证据、历史");
    expect(confirmations[0]).toContain("不会用于原生回复注入");
    el("reranker-enabled").checked = true; w.confirm = () => true;
    await el("reranker-enabled").onchange();
    expect(calls).toContainEqual({ action: "reranker", data: true });
    dom.window.close();
  });
  it("DMAE 单独确认且说明手动搜索不更新激活值", async () => {
    const root = path.resolve("plugins/companion-memory/static");
    const dom = new JSDOM(readFileSync(path.join(root, "ui.html"), "utf8"), { runScripts: "outside-only" });
    const w = dom.window, calls: any[] = [], confirmations: string[] = [];
    const state = { revision: 0, pending: 0, turns: [], entries: [], evidence: [], profiles: { l0: {}, l1: {}, l0Locked: false }, dmae: { enabled: false, round: 0, tracked: 0, active: 0 } };
    w.companion = { invoke: async (action: string, data: any) => {
      calls.push({ action, data });
      if (action === "state" || action === "dmae") return { ok: true, data: state };
      return { ok: false, error: "unexpected" };
    } };
    w.eval(readFileSync(path.join(root, "ui.js"), "utf8"));
    const el = (id: string) => w.document.getElementById(id) as any;
    await vi.waitFor(() => expect(el("dmae-status").textContent).toContain("已关闭"));
    el("dmae-enabled").checked = true;
    w.confirm = (message: string) => { confirmations.push(message); return false; };
    await el("dmae-enabled").onchange();
    expect(calls.some((call) => call.action === "dmae")).toBe(false);
    expect(confirmations[0]).toContain("插件会在记忆真正注入");
    expect(confirmations[0]).toContain("手动搜索与预检不更新状态");
    el("dmae-enabled").checked = true; w.confirm = () => true;
    await el("dmae-enabled").onchange();
    expect(calls).toContainEqual({ action: "dmae", data: true });
    dom.window.close();
  });
  it("相似候选预检不调用模型，只能填入已有人工复核入口", async () => {
    const root = path.resolve("plugins/companion-memory/static");
    const dom = new JSDOM(readFileSync(path.join(root, "ui.html"), "utf8"), { runScripts: "outside-only" });
    const w = dom.window, calls: any[] = [];
    const entries = [
      { id: "a", content: "喜欢乌龙茶", quote: "乌龙茶", sourceAt: 1, turnId: "t1", sessionId: "s", pinned: false, status: "active" },
      { id: "b", content: "偏爱清香乌龙", quote: "清香乌龙", sourceAt: 2, turnId: "t2", sessionId: "s", pinned: false, status: "active" },
    ];
    const state = { revision: 3, pending: 0, turns: [], entries, evidence: [], profiles: { l0: {}, l1: {}, l0Locked: false } };
    w.companion = { invoke: async (action: string, data: any) => {
      calls.push({ action, data });
      if (action === "state") return { ok: true, data: state };
      if (action === "preview-related-pairs") return { ok: true, data: { revision: 3, indexed: 2, considered: 2, truncated: false, pairs: [{ leftId: "a", rightId: "b", score: 0.94 }] } };
      return { ok: false, error: "unexpected" };
    } };
    w.eval(readFileSync(path.join(root, "ui.js"), "utf8"));
    const el = (id: string) => w.document.getElementById(id) as any;
    await vi.waitFor(() => expect(el("review-left").options).toHaveLength(2));
    await el("related-pairs-preview").onclick();
    expect(calls.some((call) => call.action === "review-entries")).toBe(false);
    expect(el("related-pairs").textContent).toContain("不代表冲突");
    el("related-pairs").querySelector("button").click();
    expect(el("review-left").value).toBe("a"); expect(el("review-right").value).toBe("b");
    expect(el("status").textContent).toContain("仍会再次要求确认");
    dom.window.close();
  });
  it("压缩建议与应用分别确认，并在界面保留撤销语义", async () => {
    const root = path.resolve("plugins/companion-memory/static");
    const dom = new JSDOM(readFileSync(path.join(root, "ui.html"), "utf8"), { runScripts: "outside-only" });
    const w = dom.window, calls: any[] = [], confirmations: string[] = [];
    const entries = [
      { id: "a", content: "京都计划", quote: "想去京都", sourceAt: 1, turnId: "t1", sessionId: "s", pinned: false, status: "active" },
      { id: "b", content: "京都酒店", quote: "订好酒店", sourceAt: 2, turnId: "t2", sessionId: "s", pinned: false, status: "active" },
    ];
    const review = { id: "cr1", entries, evidence: [[], []], verdict: "mergeable", summary: "京都旅行已规划并预订酒店", reason: "同一事项", confidence: 0.82, coverageConfirmed: true, status: "pending", createdAt: 3 };
    const recent = { ...review, id: "cr2", summary: "最近已压缩的京都旅行组", status: "applied", createdAt: 2, appliedAt: 20, resultId: "summary-1" };
    const older = { ...review, id: "cr3", summary: "更早已撤销的旅行组", status: "undone", createdAt: 1, appliedAt: 10, undoneAt: 15, resultId: "summary-2" };
    const state = { revision: 4, pending: 0, turns: [], entries, evidence: [], profiles: { l0: {}, l1: {}, l0Locked: false }, compressionReviews: [review, older, recent] };
    w.companion = { invoke: async (action: string, data: any) => {
      calls.push({ action, data });
      if (action === "state") return { ok: true, data: state };
      if (action === "review-compression") return { ok: true, data: review };
      if (action === "resolve-compression") return { ok: true, data: state };
      return { ok: false, error: "unexpected" };
    } };
    w.eval(readFileSync(path.join(root, "ui.js"), "utf8"));
    const el = (id: string) => w.document.getElementById(id) as any;
    await vi.waitFor(() => expect(el("compression-entries").options).toHaveLength(2));
    for (const option of el("compression-entries").options) option.selected = true;
    w.confirm = (message: string) => { confirmations.push(message); return false; };
    await el("compression-review-form").onsubmit({ preventDefault() {} });
    expect(calls.some((call) => call.action === "review-compression")).toBe(false);
    expect(confirmations[0]).toContain("摘要、原文提示、最多三段关联证据");
    w.confirm = () => true; await el("compression-review-form").onsubmit({ preventDefault() {} });
    expect(calls).toContainEqual({ action: "review-compression", data: { entryIds: ["a", "b"], revision: 4 } });
    const apply = [...el("compression-reviews").querySelectorAll("button")].find((button: any) => button.textContent.includes("应用"));
    w.confirm = () => false; await apply.onclick();
    expect(calls.some((call) => call.action === "resolve-compression")).toBe(false);
    w.confirm = () => true; await apply.onclick();
    expect(calls).toContainEqual({ action: "resolve-compression", data: { id: "cr1", action: "apply", revision: 4 } });
    expect(el("compression-reviews").textContent).toContain("候选总结");
    expect(el("compression-reviews").textContent).toContain("置信度 0.82");
    expect(el("recent-compression-groups").textContent).toContain("最近已压缩的京都旅行组");
    expect(el("recent-compression-groups").textContent).toContain("已应用");
    expect(el("recent-compression-groups").textContent.indexOf("最近已压缩的京都旅行组")).toBeLessThan(el("recent-compression-groups").textContent.indexOf("更早已撤销的旅行组"));
    dom.window.close();
  });
  it("旧记忆预检必须由用户确认，只展示聚合结果", async () => {
    const root = path.resolve("plugins/companion-memory/static");
    const dom = new JSDOM(readFileSync(path.join(root, "ui.html"), "utf8"), { runScripts: "outside-only" });
    const w = dom.window, calls: any[] = [];
    const state = { revision: 0, pending: 0, turns: [], entries: [], evidence: [], profiles: { l0: {}, l1: {}, l0Locked: false }, defaultLegacyMemoryPath: "C:\\safe\\memory.json" };
    w.companion = { invoke: async (action: string, data: any) => {
      calls.push({ action, data });
      if (action === "state") return { ok: true, data: state };
      if (action === "preview-legacy-import") return { ok: true, data: { sourceBytes: 100, sourceHash: "a".repeat(64), entries: { total: 1, valid: 1, invalid: 0, duplicateIds: 0, summaries: 0, missingQuote: 0, missingSourceAt: 0, missingSourceReference: 0, brokenRelations: 0, statuses: { active: 1 } }, evidence: { total: 1, valid: 1, invalid: 0, orphaned: 0, deleted: 0 }, facets: { present: 1, valid: 1, invalid: 0, pending: 0 }, profiles: { l0: 1, l1: 1, invalid: 0, ignoredLegacyFields: 0 }, excluded: { embeddings: 1, facets: 0, dmaeStates: 0, dreams: 0, reflectionLogs: 0, conflictLogs: 0, pendingTurns: 0 }, runtime: { lifecycleRecords: 1, dmaeStates: 0, unmappedL2: 0, orphanedDmaeStates: 0, valid: true }, canImport: true, warnings: ["预检不会导入或修改任何数据。"] } };
      if (action === "import-legacy") return { ok: true, data: { importedEntries: 1, importedEvidence: 1, importedProfiles: 2 } };
      return { ok: false, error: "unexpected" };
    } };
    w.eval(readFileSync(path.join(root, "ui.js"), "utf8"));
    const form = w.document.getElementById("legacy-preview-form"), output = w.document.getElementById("legacy-preview");
    await vi.waitFor(() => expect((w.document.getElementById("legacy-source") as any).value).toBe("C:\\safe\\memory.json"));
    w.confirm = () => false; await (form as any).onsubmit({ preventDefault() {} });
    expect(calls.filter((call) => call.action === "preview-legacy-import")).toHaveLength(0);
    w.confirm = () => true; await (form as any).onsubmit({ preventDefault() {} });
    expect(calls).toContainEqual({ action: "preview-legacy-import", data: { sourcePath: "C:\\safe\\memory.json" } });
    expect(output.textContent).toContain("L2：1 条");
    const importButton = w.document.getElementById("legacy-import") as any;
    w.confirm = () => false; await importButton.onclick();
    expect(calls.some((call) => call.action === "import-legacy")).toBe(false);
    w.confirm = () => true; await importButton.onclick();
    expect(calls).toContainEqual({ action: "import-legacy", data: { sourcePath: "C:\\safe\\memory.json", sourceHash: "a".repeat(64), revision: 0, sourceAttested: false, preserveRuntime: false } });
    await (form as any).onsubmit({ preventDefault() {} });
    (w.document.getElementById("legacy-source-attested") as any).checked = true;
    (w.document.getElementById("legacy-preserve-runtime") as any).checked = true;
    await importButton.onclick();
    expect(calls).toContainEqual({ action: "import-legacy", data: { sourcePath: "C:\\safe\\memory.json", sourceHash: "a".repeat(64), revision: 0, sourceAttested: true, preserveRuntime: true } });
    dom.window.close();
  });
  it("L2 复核必须确认发送，归档须再次确认，支持取消", async () => {
    const root = path.resolve("plugins/companion-memory/static");
    const dom = new JSDOM(readFileSync(path.join(root, "ui.html"), "utf8"), { runScripts: "outside-only" });
    const w = dom.window, calls: any[] = [];
    const left = { id: "a", content: "左", quote: "<img src=x>", sourceAt: 1, status: "active" };
    const right = { ...left, id: "b", content: "右" };
    const state = { revision: 4, pending: 0, turns: [], profiles: { l0: {}, l1: {}, l0Locked: false }, entries: [left, right], entryReviews: [{ id: "r", left, right, verdict: "conflict", reason: "<script>x</script>", status: "pending", resolverPlan: { resolutionType: "preference_evolution", confidence: 0.9, actions: { createResolvedMemory: false, leftStatus: "archived", shouldAskUser: false, clarificationNeeded: false } } }] };
    w.companion = { invoke: async (action: string, data: any) => { calls.push({ action, data }); return { ok: true, data: state }; } };
    w.eval(readFileSync(path.join(root, "ui.js"), "utf8"));
    const el = (id: string) => w.document.getElementById(id);
    await vi.waitFor(() => expect(el("review-left").options.length).toBe(2));
    expect(el("entry-reviews").querySelector("script,img")).toBeNull();
    el("review-right").value = "b"; w.confirm = () => false;
    await el("review-form").onsubmit({ preventDefault() {} });
    expect(calls.some((c) => c.action === "review-entries")).toBe(false);
    w.confirm = () => true;
    await el("review-form").onsubmit({ preventDefault() {} });
    expect(calls).toContainEqual({ action: "review-entries", data: { leftId: "a", rightId: "b", revision: 4 } });
    w.confirm = () => false;
    await el("entry-reviews").querySelectorAll("button")[1].onclick();
    expect(calls.some((c) => c.action === "resolve-entry-review")).toBe(false);
    w.confirm = () => true;
    await el("entry-reviews").querySelectorAll("button")[1].onclick();
    expect(calls).toContainEqual({ action: "resolve-entry-review", data: { id: "r", action: "archive-left", revision: 4 } });
    await el("entry-reviews").querySelectorAll("button")[3].onclick();
    expect(calls).toContainEqual({ action: "resolve-entry-review", data: { id: "r", action: "apply-plan", revision: 4 } });
    expect(el("entry-reviews").textContent).toContain("偏好演进");
    await el("cancel-review").onclick();
    expect(calls.some((c) => c.action === "cancel-review")).toBe(true);
    dom.window.close();
  });
  it("画像变更按钮提交候选 ID 和版本，证据不解析为 HTML", async () => {
    const root = path.resolve("plugins/companion-memory/static");
    const dom = new JSDOM(readFileSync(path.join(root, "ui.html"), "utf8"), { runScripts: "outside-only" });
    const w = dom.window, calls: any[] = [];
    const fact = { content: "旧值", quote: "<img src=x>", sourceAt: 1000 };
    const state = { revision: 9, pending: 0, turns: [], entries: [], profiles: { l0: {}, l1: {}, l0Locked: false }, profileChanges: [{ id: "change1", layer: "L0", field: "preferredName", before: fact, after: { ...fact, content: "新值" }, status: "pending" }, { id: "change2", layer: "L1", field: "recentGoals", before: fact, after: { ...fact, content: "新目标" }, status: "accepted", reflection: { kind: "turn", confidence: 0.96, reason: "新近用户原话" } }, { id: "change3", layer: "L1", field: "currentProject", before: fact, after: { ...fact, content: "候选项目" }, status: "pending", reflection: { kind: "turn", confidence: 0.91, reason: "仍需用户核对" } }] };
    w.companion = { invoke: async (action: string, data: any) => { calls.push({ action, data }); return { ok: true, data: state }; } };
    w.eval(readFileSync(path.join(root, "ui.js"), "utf8"));
    const container = w.document.getElementById("profile-changes");
    await vi.waitFor(() => expect(container.querySelectorAll("button").length).toBe(5));
    expect(container.querySelector("img")).toBeNull();
    await container.querySelectorAll("button")[1].onclick();
    expect(calls).toContainEqual({ action: "resolve-profile-change", data: { id: "change1", action: "accept", revision: 9 } });
    await container.querySelectorAll("button")[0].onclick();
    expect(calls).toContainEqual({ action: "resolve-profile-change", data: { id: "change1", action: "keep", revision: 9 } });
    expect(container.textContent).toContain("模型自报置信度 0.96");
    const undo = [...container.querySelectorAll("button")].find((button: any) => button.textContent === "撤销这次采用") as any;
    w.confirm = () => false; await undo.onclick();
    expect(calls.some((call) => call.data?.action === "undo-accept")).toBe(false);
    w.confirm = () => true; await undo.onclick();
    expect(calls).toContainEqual({ action: "resolve-profile-change", data: { id: "change2", action: "undo-accept", revision: 9 } });
    const reflectedAccept = container.querySelectorAll("article")[2].querySelectorAll("button")[1] as any;
    w.confirm = () => false; await reflectedAccept.onclick();
    expect(calls.some((call) => call.data?.id === "change3" && call.data?.action === "accept")).toBe(false);
    w.confirm = () => true; await reflectedAccept.onclick();
    expect(calls).toContainEqual({ action: "resolve-profile-change", data: { id: "change3", action: "accept", revision: 9 } });
    dom.window.close();
  });
  it("记忆界面按版本提交画像修改、锁定和归档，原文以纯文本显示", async () => {
    const root = path.resolve("plugins/companion-memory/static");
    const dom = new JSDOM(readFileSync(path.join(root, "ui.html"), "utf8"), { runScripts: "outside-only" });
    const w = dom.window, calls: any[] = [];
    const state = { revision: 3, pending: 0, maintaining: false, turns: [], profiles: { l0: {}, l1: {}, l0Locked: false }, entries: [{ id: "e", content: "事实", quote: "<script>bad()</script>", sourceAt: 1000, turnId: "t", status: "active", pinned: false }] };
    w.companion = { invoke: async (action: string, data: any) => { calls.push({ action, data }); return { ok: true, data: state }; } };
    w.eval(readFileSync(path.join(root, "ui.js"), "utf8"));
    const el = (id: string) => w.document.getElementById(id);
    await vi.waitFor(() => expect(el("profiles").querySelectorAll("input").length).toBe(8));
    expect(el("entries").querySelector("script")).toBeNull();
    expect(el("query-expansion").checked).toBe(false);
    w.confirm = () => false;
    el("query-expansion").checked = true;
    await el("query-expansion").onchange();
    expect(el("query-expansion").checked).toBe(false);
    expect(calls.some((c) => c.action === "query-expansion")).toBe(false);
    w.confirm = () => true;
    el("query-expansion").checked = true;
    await el("query-expansion").onchange();
    expect(calls.some((c) => c.action === "query-expansion" && c.data === true)).toBe(true);
    el("profile-preferredName").value = "小林";
    await el("profile-preferredName").parentElement.querySelector("button").onclick();
    await vi.waitFor(() => expect(calls.some((c) => c.action === "edit-profile" && c.data.revision === 3 && c.data.content === "小林")).toBe(true));
    await el("lock").onclick();
    await vi.waitFor(() => expect(calls.some((c) => c.action === "lock-profile" && c.data.locked)).toBe(true));
    const archive = [...el("entries").querySelectorAll("button")].find((b: any) => b.textContent === "归档") as any;
    await archive.onclick();
    await vi.waitFor(() => expect(calls.some((c) => c.action === "edit-entry" && c.data.status === "archived" && c.data.revision === 3)).toBe(true));
    dom.window.close();
  });
  it("展示原配置引用/当前宿主/自定义，保存后清空密钥框，不渲染模型 HTML", async () => {
    const root = path.resolve("plugins/companion-chat/static");
    const html = readFileSync(path.join(root, "ui.html"), "utf8");
    const dom = new JSDOM(html, { runScripts: "outside-only", url: "https://isolated.invalid" });
    const w = dom.window;
    w.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
    w.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); this.dispatchEvent(new w.Event("close")); };
    const saved: any[] = [];
    w.companion = { invoke: async (action: string, data: any) => {
      if (action === "state") return { ok: true, data: {
        chat: { sessions: [{ id: "s", title: "会话", messages: [{ id: "m", role: "assistant", text: '<img src=x onerror="alert(1)">', at: 100 }] }] },
        model: { mode: "host", reuse: "file", sourcePath: "original/model-settings.json", baseUrl: "", model: "", systemPrompt: "独立提示词", hasCustomKey: false },
        life: { enabled: true, importantDatesText: "07-27 认识纪念日" },
      } };
      if (action === "save-model") { saved.push(data); return { ok: true }; }
      if (action === "save-memory-link") return { ok: true, data: { enabled: Boolean(data.enabled) } };
      if (action === "save-proactive-settings") return { ok: true, data: {
        enabled: Boolean(data.enabled), feedbackLearningEnabled: Boolean(data.feedbackLearningEnabled),
      } };
      if (action === "save-screen-monitor-settings") return { ok: true, data: { enabled: Boolean(data.enabled) } };
      if (action === "save-life-settings") return { ok: true, data: { enabled: Boolean(data.enabled), importantDatesText: data.importantDatesText } };
      return { ok: false, error: "unexpected" };
    } };
    w.eval(readFileSync(path.join(root, "ui.js"), "utf8"));
    const el = (id: string) => w.document.getElementById(id);
    await vi.waitFor(() => expect(el("messages").textContent).toContain("<img"));
    expect(el("messages").querySelector("img")).toBeNull();
    el("settings").click();
    await vi.waitFor(() => expect(el("model-dialog").hasAttribute("open")).toBe(true));
    expect(el("reuse").value).toBe("file"); expect(el("source-path").value).toBe("original/model-settings.json");
    expect(el("persona-style")).toBeNull();
    expect(el("life-enabled").checked).toBe(true); expect(el("important-dates").value).toContain("认识纪念日");
    expect(el("feedback-learning-enabled").checked).toBe(false);
    el("reuse").value = "current"; el("reuse").dispatchEvent(new w.Event("change"));
    expect(el("source-label").hidden).toBe(true);
    el("mode").value = "custom"; el("mode").dispatchEvent(new w.Event("change"));
    expect(el("custom-fields").hidden).toBe(false); expect(el("reuse-fields").hidden).toBe(true);
    el("base-url").value = "https://example.invalid/v1"; el("model").value = "test"; el("api-key").value = "fake-ui-only";
    el("feedback-learning-enabled").checked = true;
    el("model-form").dispatchEvent(new w.Event("submit", { cancelable: true }));
    await vi.waitFor(() => expect(saved).toHaveLength(1));
    expect(saved[0].mode).toBe("custom"); expect(saved[0]).not.toHaveProperty("personaStyle"); await vi.waitFor(() => expect(el("api-key").value).toBe(""));
    dom.window.close();
  });
  it("陪伴聊天 preload 只放行界面实际使用的动作", () => {
    const preload = readFileSync(path.resolve("plugins/companion-chat/static/preload.cjs"), "utf8");
    for (const action of ["state", "save-model", "save-memory-link", "save-proactive-settings", "save-screen-monitor-settings", "save-life-settings",
      "new", "send", "cancel", "sync", "memory", "extract", "send-proactive-test"]) {
      expect(preload).toContain(`\"${action}\"`);
    }
    expect(preload).toContain("if (!allowed.has(action))");
  });
  it("归档冷召回先只读展示证据，恢复必须再次确认", async () => {
    const root = path.resolve("plugins/companion-memory/static");
    const dom = new JSDOM(readFileSync(path.join(root, "ui.html"), "utf8"), { runScripts: "outside-only" });
    const w = dom.window, calls: any[] = [], confirmations: string[] = [];
    const state = { revision: 7, pending: 0, turns: [], entries: [], evidence: [], profiles: { l0: {}, l1: {}, l0Locked: false } };
    const preview = { memoryRevision: 7, query: "京都红叶", token: "a".repeat(64), reason: "archived-candidates", hotRelevantCount: 0, candidates: [{ id: "cold", content: "用户曾计划去京都看红叶", sourceAt: 1_000, quote: "用户原话：想去京都", evidence: "[关联证据] 去年提到京都红叶", lexicalScore: 6, facetMatched: false }] };
    w.companion = { invoke: async (action: string, data: any) => {
      calls.push({ action, data });
      if (action === "state" || action === "restore-archived-recall") return { ok: true, data: state };
      if (action === "preview-archived-recall") return { ok: true, data: preview };
      return { ok: false, error: "unexpected" };
    } };
    w.eval(readFileSync(path.join(root, "ui.js"), "utf8"));
    const el = (id: string) => w.document.getElementById(id) as any;
    await vi.waitFor(() => expect(el("cold-recall-restore").disabled).toBe(true));
    el("cold-recall-query").value = "京都红叶";
    await el("cold-recall-preview-form").onsubmit({ preventDefault() {} });
    expect(calls).toContainEqual({ action: "preview-archived-recall", data: { query: "京都红叶" } });
    expect(el("cold-recall-candidates").textContent).toContain("去年提到京都红叶");
    expect(el("cold-recall-candidates").querySelector("img,script")).toBeNull();
    el("cold-recall-candidates").options[0].selected = true;
    w.confirm = (message: string) => { confirmations.push(message); return false; };
    await el("cold-recall-restore-form").onsubmit({ preventDefault() {} });
    expect(calls.some((call) => call.action === "restore-archived-recall")).toBe(false);
    expect(confirmations[0]).toContain("不会修改正文、原始对话、证据、DMAE 激活值或访问统计");
    w.confirm = () => true;
    await el("cold-recall-restore-form").onsubmit({ preventDefault() {} });
    expect(calls).toContainEqual({ action: "restore-archived-recall", data: { memoryRevision: 7, query: "京都红叶", token: "a".repeat(64), entryIds: ["cold"] } });
    dom.window.close();
  });
});
