import { EventEmitter } from "node:events";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { createGitWorkspaceWatcher } from "./git-workspace-watcher";

const native = vi.hoisted(() => ({ callbacks: new Map<string, (event: string, filename: string | null) => void>(), stat: vi.fn() }));
vi.mock("node:fs", async importOriginal => ({
  ...await importOriginal<typeof import("node:fs")>(),
  watch: vi.fn((root: string, _options: unknown, callback: (event: string, filename: string | null) => void) => {
    native.callbacks.set(root, callback); const handle = new EventEmitter(); return Object.assign(handle, { close: vi.fn() });
  }),
  lstatSync: native.stat,
}));
beforeEach(() => { vi.useFakeTimers(); native.callbacks.clear(); native.stat.mockReset(); });
afterEach(() => vi.useRealTimers());
const itNative = process.platform === "win32" ? it : it.skip;
itNative.each([false, true])("filters only a present refs directory change; external gitDir=%s", async external => {
  const root = "C:\\fixture", gitDir = external ? "C:\\metadata\\.git" : root + "\\.git";
  const changed = vi.fn(), watcher = createGitWorkspaceWatcher({ onWorkspaceChanged: changed, onError: vi.fn(), debounceMs: 80 });
  await watcher.subscribe({ sessionId: "s", workspaceRoot: root, gitDir });
  const emit = native.callbacks.get(external ? gitDir : root)!;
  const refs = external ? "refs" : ".git\\refs";
  native.stat.mockReturnValue({ isDirectory: () => true });
  emit("change", refs); await vi.advanceTimersByTimeAsync(230); expect(changed).not.toHaveBeenCalled();
  expect(native.stat).toHaveBeenCalledWith(expect.stringMatching(/refs$/), { throwIfNoEntry: false });
  for (const [event, filename] of [["rename", refs], ["rename", refs + "\\heads\\new"], ["change", refs + "\\heads\\new"], ["rename", refs + "\\heads\\deleted"], ["rename", refs + "\\heads\\nested\\branch"]]) {
    changed.mockClear(); emit(event, filename); await vi.advanceTimersByTimeAsync(230); expect(changed).toHaveBeenCalledWith(["s"]);
  }
  await watcher.dispose();
});
itNative.each(["missing", "file", "symlink", "denied"])("preserves refs change when status is %s", async status => {
  const changed = vi.fn(), watcher = createGitWorkspaceWatcher({ onWorkspaceChanged: changed, onError: vi.fn(), debounceMs: 80 });
  await watcher.subscribe({ sessionId: "s", workspaceRoot: "C:\\fixture", gitDir: "C:\\fixture\\.git" });
  if (status === "denied") native.stat.mockImplementation(() => { throw new Error("EACCES"); });
  else native.stat.mockReturnValue(status === "missing" ? undefined : { isDirectory: () => false });
  native.callbacks.get("C:\\fixture")!("change", ".git\\refs");
  await vi.advanceTimersByTimeAsync(230); expect(changed).toHaveBeenCalledWith(["s"]); await watcher.dispose();
});
