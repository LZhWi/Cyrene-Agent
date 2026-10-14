import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, expect, it } from "vitest";
import { createChatStorageRecovery } from "./chat-storage-recovery";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true }); });
function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chat-recovery-")); dirs.push(dir);
  return { dir, file: path.join(dir, "index.json"), store: createChatStorageRecovery((_file, value) => Array.isArray(value)) };
}
it("preserves damaged primary, backup and tmp until approval and blocks all writes", () => {
  const { dir, file, store } = setup();
  fs.writeFileSync(file, "broken"); fs.writeFileSync(file + ".tmp", "[2]");
  fs.writeFileSync(path.join(dir, "index.last-good.json"), "[1]");
  store.inspect(file);
  expect(store.issues()[0].canRestore).toBe(true);
  expect(() => store.write(file, [])).toThrow();
  expect(fs.readFileSync(file, "utf8")).toBe("broken");
  expect(fs.readFileSync(file + ".tmp", "utf8")).toBe("[2]");
  expect(fs.readFileSync(path.join(dir, "index.last-good.json"), "utf8")).toBe("[1]");
  store.recover(file);
  expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual([2]);
  expect(fs.readdirSync(path.join(dir, "recovery"))).toHaveLength(3);
});
it("detects structural damage and missing referenced files", () => {
  const { file, store } = setup(); fs.writeFileSync(file, "{}"); store.inspect(file);
  expect(store.issues()).toHaveLength(1);
  store.recover(file, ["rebuilt"]);
  store.inspect(file + "-missing", true);
  expect(() => store.requireReady()).toThrow();
});
it("writes last-good and refuses to overwrite damage introduced after startup", () => {
  const { dir, file, store } = setup(); store.write(file, [1]);
  expect(JSON.parse(fs.readFileSync(path.join(dir, "index.last-good.json"), "utf8"))).toEqual([1]);
  fs.writeFileSync(file, "bad"); expect(() => store.write(file, [2])).toThrow();
  expect(fs.readFileSync(file, "utf8")).toBe("bad");
});
