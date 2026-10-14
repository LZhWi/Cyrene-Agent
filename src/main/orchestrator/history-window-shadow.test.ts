import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs/promises";
import * as os from "os";
import * as path from "path";
const runtime = vi.hoisted(() => ({ dir: "" }));
vi.mock("../runtime/runtime-paths", () => ({ getUserDataDir: () => runtime.dir }));
import { flushHistoryWindowShadow, presentHistoryWindow, recordHistoryWindowShadow } from "./history-window-shadow";

const hit = { text: "前文。".repeat(110) + "我要给你造一副身体。" + "后文。".repeat(110),
  createdAt: 1, score: 0.2, metadata: { sessionId: "s", turnId: "t", role: "user" } };
function evidence(text = "我要给你造一副身体。", relevanceScore = 1) {
  return { candidates: [{ ...hit, text, metadata: { ...hit.metadata,
    retrievalExpansion: "sentence_window", retrievalParentText: hit.text } }],
  ranked: [{ text, score: 1, relevanceScore }] };
}

describe("sentence window shadow", () => {
  beforeEach(async () => { runtime.dir = await fs.mkdtemp(path.join(os.tmpdir(), "window-shadow-")); });
  afterEach(async () => {
    await flushHistoryWindowShadow();
    vi.unstubAllEnvs(); vi.restoreAllMocks();
    await fs.rm(runtime.dir, { recursive: true, force: true });
  });
  it("locates a late anchor and returns only contiguous original text without mutating evidence", () => {
    const input = evidence(); const before = JSON.stringify({ hit, input });
    const result = presentHistoryWindow(hit, input);
    expect(result.reason).toBe("existing_window");
    expect(result.text).toContain("我要给你造一副身体。");
    expect(result.text).toBe(hit.text.slice(result.start, result.end));
    expect(result.text.length).toBeLessThanOrEqual(300);
    expect(JSON.stringify({ hit, input })).toBe(before);
  });
  it("falls back for missing, ambiguous, weak or wrong-session evidence", () => {
    for (const input of [{}, evidence("不存在"), evidence("前文。"), evidence(undefined, -7),
      { ...evidence(), candidates: evidence().candidates.map(c => ({ ...c, metadata: { ...c.metadata, sessionId: "other" } })) }]) {
      expect(presentHistoryWindow(hit, input).text).toBe(hit.text.slice(0, 300));
    }
  });
  it("preserves short messages and guards a shorter prefix", () => {
    expect(presentHistoryWindow({ ...hit, text: "短句。" }, {}).reason).toBe("short_unchanged");
    const original = { ...hit, text: "开头。" + "长".repeat(400) };
    const input = { candidates: [{ ...evidence("开头。").candidates[0], metadata: {
      ...evidence().candidates[0].metadata, retrievalParentText: original.text } }], ranked: evidence("开头。").ranked };
    expect(presentHistoryWindow(original, input).reason).toBe("prefix_subset_guard");
  });
  it("logs paired routed selections, rotates bounded logs and supports disabling", async () => {
    const input = { userQuery: "query", toolQuery: "query", source: "auto_injection" as const,
      finalK: 12, days: 90, selected: Array.from({ length: 8 }, () => hit), evidence: evidence() };
    recordHistoryWindowShadow(input); await flushHistoryWindowShadow();
    const file = path.join(runtime.dir, "logs", "history-window-shadow.jsonl");
    const record = JSON.parse(await fs.readFile(file, "utf8"));
    expect(record.finalK).toBe(12); expect(record.selectedCount).toBe(8);
    expect(record.rows).toHaveLength(8);
    expect(record.rows[0].official.text).toBe(hit.text.slice(0, 300) + "...");
    expect(record.rows[0].shadow.text).toContain("我要给你造一副身体。");
    await fs.writeFile(file, "x".repeat(10 * 1024 * 1024));
    recordHistoryWindowShadow(input); await flushHistoryWindowShadow();
    expect((await fs.stat(file + ".1")).size).toBe(10 * 1024 * 1024);
    const before = await fs.readFile(file, "utf8");
    vi.stubEnv("CYRENE_HISTORY_WINDOW_SHADOW", "0");
    recordHistoryWindowShadow(input); await flushHistoryWindowShadow();
    expect(await fs.readFile(file, "utf8")).toBe(before);
  });
  it("swallows IO and presentation failures", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await fs.writeFile(path.join(runtime.dir, "logs"), "blocked");
    const input = { userQuery: "q", toolQuery: "q", source: "tool" as const,
      finalK: 5, days: 90, selected: [hit], evidence: {} };
    expect(() => recordHistoryWindowShadow(input)).not.toThrow();
    await expect(flushHistoryWindowShadow()).resolves.toBeUndefined();
    const broken = { ...hit, get text(): string { throw new Error("broken observation"); } };
    expect(() => recordHistoryWindowShadow({ ...input, selected: [broken] })).not.toThrow();
  });
});
