import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { createPluginStorage } from "../../src/plugins/storage";
import { createRecoverableMemoryStorage } from "../plugins/companion-memory/src/recoverable-storage";
import { createMemory } from "../plugins/companion-memory/src/memory";

const fault = vi.hoisted(() => ({ renameTarget: "" }));
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, renameSync: (from: fs.PathLike, to: fs.PathLike) => {
    if (to === fault.renameTarget) throw new Error("simulated rename failure");
    return actual.renameSync(from, to);
  } };
});

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  fault.renameTarget = "";
  for (const root of roots.splice(0)) {
    if (path.dirname(root) !== path.resolve(os.tmpdir()) || !path.basename(root).startsWith("memory-recovery-")) throw new Error("测试目录越界");
    fs.rmSync(root, { recursive: true, force: true });
  }
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-recovery-")); roots.push(root);
  const controller = new AbortController(), log = vi.fn();
  const ctx = { storage: createPluginStorage(root), signal: controller.signal, log } as any;
  const load = () => createRecoverableMemoryStorage(ctx);
  const file = (name: string) => path.join(root, name);
  return { root, ctx, load, controller, log, file, store: load() };
}
const dmae = { version: 1, round: 0, states: {} };

it("saves a validated last-good snapshot and restores corrupt or missing primary on restart", () => {
  const f = fixture(); f.store.set("dmae-state", dmae);
  const good = fs.readFileSync(f.file("dmae-state.last-good.json"));
  fs.writeFileSync(f.file("dmae-state.json"), "broken primary");
  fs.writeFileSync(f.file("dmae-state.json.tmp"), "interrupted bytes");
  expect(f.load().get("dmae-state")).toEqual(dmae);
  const preserved = fs.readdirSync(f.root).filter(n => n.includes(".recovery-")).map(n => fs.readFileSync(f.file(n), "utf8"));
  expect(preserved).toContain("broken primary"); expect(preserved).toContain("interrupted bytes");
  expect(fs.readFileSync(f.file("dmae-state.json"))).toEqual(good);
  fs.unlinkSync(f.file("dmae-state.json"));
  expect(f.load().get("dmae-state")).toEqual(dmae);
});

it("rejects schema-invalid primary even if it parses as JSON", () => {
  const f = fixture(); f.store.set("dmae-state", dmae);
  fs.writeFileSync(f.file("dmae-state.json"), JSON.stringify({ version: 1, round: -1, states: {} }));
  expect(f.load().get("dmae-state")).toEqual(dmae);
  expect(() => f.store.set("dmae-state", { ...dmae, round: -1 })).toThrow();
});

it("restores the actual history recall state key using history schema validation", () => {
  const f = fixture(), key = "history-retrieval-recall-state";
  const value = { version: 1, entries: { message: { weight: 1, lastRecalledAt: 1 } } };
  f.store.set(key, value);
  fs.writeFileSync(f.file(key + ".json"), JSON.stringify({ version: 1, entries: { message: { weight: -1 } } }));
  expect(f.load().get(key)).toEqual(value);
});

it("preserves every byte and refuses empty fallback when both copies are invalid", () => {
  const f = fixture();
  const names = ["dmae-state.json", "dmae-state.last-good.json", "dmae-state.json.tmp"];
  names.forEach((n,i) => fs.writeFileSync(f.file(n), `broken-${i}`));
  const before = names.map(n => fs.readFileSync(f.file(n)));
  expect(() => f.load().get("dmae-state")).toThrow("原文件保持不变");
  expect(() => f.store.set("dmae-state", dmae)).toThrow("拒绝");
  expect(names.map(n => fs.readFileSync(f.file(n)))).toEqual(before);
  expect(fs.readdirSync(f.root).sort()).toEqual(names.sort());
});

it("validates complete memory state and recovers turns, evidence and profiles together", () => {
  const f = fixture(); const memory = createMemory(f.store);
  memory.ingest({ id: "t", sessionId: "c", user: "fact", assistant: "reply", userAt: 1, assistantAt: 2 });
  const saved = f.store.get("memory-state");
  fs.writeFileSync(f.file("memory-state.json"), JSON.stringify({ version: 2, turns: [], entries: [], processed: [] }));
  expect(f.load().get("memory-state")).toEqual(saved);
  expect(createMemory(f.load()).view().turns).toHaveLength(1);
});

it("does not overwrite data corrupted after load or let stopped plugins recover it", () => {
  const f = fixture(); f.store.set("dmae-state", dmae);
  fs.writeFileSync(f.file("dmae-state.json"), "broken");
  expect(() => f.store.set("dmae-state", { ...dmae, round: 1 })).toThrow("重新加载恢复");
  f.controller.abort(); expect(() => f.load().get("dmae-state")).toThrow("已停止");
  expect(fs.readFileSync(f.file("dmae-state.json"), "utf8")).toBe("broken");
});

it("rejects a non-file recovery path without replacing it", () => {
  const f = fixture(); f.store.set("dmae-state", dmae);
  const linked = f.file("dmae-state.last-good.json"); fs.unlinkSync(linked);
  fs.mkdirSync(linked);
  expect(() => f.load().get("dmae-state")).toThrow("普通文件");
  expect(fs.statSync(linked).isDirectory()).toBe(true);
});

it("keeps the committed primary and backup intact when the primary rename fails", () => {
  const f = fixture(); f.store.set("dmae-state", dmae);
  const before = fs.readFileSync(f.file("dmae-state.json"));
  fault.renameTarget = f.file("dmae-state.json");
  expect(() => f.store.set("dmae-state", { ...dmae, round: 1 })).toThrow("rename failure");
  expect(fs.readFileSync(f.file("dmae-state.json"))).toEqual(before);
  expect(fs.readFileSync(f.file("dmae-state.last-good.json"))).toEqual(before);
  expect(fs.readdirSync(f.root).some(name => name.includes(".tmp-"))).toBe(false);
});

it("retains the previous backup and reports a backup failure after the primary commits", () => {
  const f = fixture(); f.store.set("dmae-state", dmae);
  fault.renameTarget = f.file("dmae-state.last-good.json");
  expect(() => f.store.set("dmae-state", { ...dmae, round: 1 })).not.toThrow();
  expect(JSON.parse(fs.readFileSync(f.file("dmae-state.json"), "utf8")).round).toBe(1);
  expect(JSON.parse(fs.readFileSync(f.file("dmae-state.last-good.json"), "utf8")).round).toBe(0);
  expect(f.log).toHaveBeenCalledWith(expect.stringContaining("last-good 更新失败"));
});

it.skipIf(!process.env.MEMORY_RECOVERY_FIXTURE)("restores isolated real memory, vectors and DMAE without modifying source snapshots", () => {
  const source = path.resolve(process.env.MEMORY_RECOVERY_FIXTURE!);
  const f = fixture();
  const cases = [["memory-state", "lifeMemory"], ["vector-index", "lifeVectors"], ["dmae-state", "lifeDmae"]];
  const hash = (file: string) => createHash("sha256").update(fs.readFileSync(file)).digest("hex");
  const originals = cases.map(([, name]) => hash(path.join(source, name + ".json")));
  for (const [key, name] of cases) {
    const snapshot = path.join(source, name + ".json"), primary = f.file(key + ".json");
    fs.copyFileSync(snapshot, primary);
    const initial = f.load().get(key);
    expect(initial).toEqual(JSON.parse(fs.readFileSync(snapshot, "utf8")));
    fs.writeFileSync(primary, JSON.stringify({ version: -1 }));
    expect(f.load().get(key)).toEqual(initial);
    expect(hash(primary)).toBe(hash(snapshot));
  }
  expect(cases.map(([, name]) => hash(path.join(source, name + ".json")))).toEqual(originals);
});
