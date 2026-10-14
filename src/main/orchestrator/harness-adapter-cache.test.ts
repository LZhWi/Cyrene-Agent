import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { userData, callLLM, summarizeHistory } = vi.hoisted(() => ({
  userData: { root: "" }, callLLM: vi.fn(), summarizeHistory: vi.fn(),
}));
vi.mock("electron", () => ({ app: { getPath: () => userData.root } }));
vi.mock("./harness/harness-llm", () => ({ callLLM, summarizeHistory }));
vi.mock("./tools/registry/tool-registry", () => ({
  toolRegistry: { getEnabledTools: () => [], getById: vi.fn() },
}));
vi.mock("../permission", () => ({ checkPermission: vi.fn() }));
vi.mock("../prompts/prompt-loader", () => ({ loadPromptFile: () => "test policy" }));

import { runHarnessWithAdapter } from "./harness-adapter";
import { HarnessRunStore } from "./harness/run-store";
import { prepareHarnessRecovery } from "./harness/run-recovery";
import type { HarnessRunSession } from "./harness/run-store";

describe("adapter checkpoint cache persistence and recovery", () => {
  beforeEach(() => {
    userData.root = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-adapter-cache-"));
    callLLM.mockReset();
    summarizeHistory.mockReset();
    summarizeHistory.mockResolvedValue("## 原始任务与意图\n- 保留任务\n## 下一步\n- 继续回答");
  });
  afterEach(() => {
    const root = path.resolve(userData.root);
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("cyrene-adapter-cache-")) {
      throw new Error("Unexpected test directory");
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  it.each([false, true])("persists messages with the matching cache before the next request (compaction=%s)", async (compact) => {
    const runId = "cache-checkpoint";
    let observed: HarnessRunSession | undefined;
    callLLM.mockImplementation(async () => {
      // Inspect the real file before the next model request, not only final-state storage.
      observed = JSON.parse(fs.readFileSync(path.join(userData.root, "cyrene-runs", "sessions", `${runId}.json`), "utf8"));
      return { text: "done", toolCalls: [] };
    });
    await runHarnessWithAdapter({
      runId,
      settings: { provider: "test", baseUrl: "", model: "test", apiKey: "", contextWindowTokens: compact ? 16384 : 256000 },
      messages: compact ? Array.from({ length: 21 }, (_, i) => ({
        role: i % 2 ? "assistant" : "user", content: "旧历史".repeat(1000),
      })) : [{ role: "user", content: "hello" }],
      timeoutMs: 60000, toolSystemContent: "", soulSystemBaseContent: "", conversationMode: "work",
    } as never, new AbortController().signal, vi.fn());

    expect(callLLM).toHaveBeenCalledTimes(1);
    expect(summarizeHistory).toHaveBeenCalledTimes(compact ? 1 : 0);
    expect(observed?.cache).toEqual({ cacheEpoch: compact ? 2 : 1, epochReason: compact ? "compaction" : "run_start" });
    expect(JSON.stringify(observed?.messages).includes("cyrene_compaction_checkpoint")).toBe(compact);
    const saved = new HarnessRunStore(userData.root).get(runId)!;
    expect(saved.cache).toEqual(observed!.cache);
    // Recovery consumes the exact pre-request disk snapshot; only crash status is simulated.
    const recovered = prepareHarnessRecovery({ ...observed!, status: "interrupted" }, {});
    expect(recovered.cache).toEqual({ cacheEpoch: compact ? 3 : 2, epochReason: "recovery" });
    expect(recovered.messages).toEqual(observed!.messages);
  });
});
