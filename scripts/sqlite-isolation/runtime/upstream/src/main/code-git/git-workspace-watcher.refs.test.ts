import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it, vi } from "vitest";
import { createGitWorkspaceWatcher } from "./git-workspace-watcher";
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const itNative = process.platform === "win32" ? it : it.skip;
itNative.each([false, true])("ignores refs metadata but reports ref lifecycle; external gitDir=%s", async external => {
  const base = realpathSync.native(mkdtempSync(path.join(tmpdir(), "cyrene-refs-")));
  const root = path.join(base, "workspace"), gitDir = external ? path.join(base, "metadata", ".git") : path.join(root, ".git");
  const refs = path.join(gitDir, "refs"), branch = path.join(refs, "heads", "topic"), nested = path.join(refs, "heads", "feature", "nested");
  mkdirSync(root, { recursive: true }); mkdirSync(path.dirname(branch), { recursive: true });
  writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main\n");
  const changed = vi.fn(), watcher = createGitWorkspaceWatcher({ onWorkspaceChanged: changed, onError: vi.fn(), debounceMs: 80 });
  const change = async (operation: () => void) => {
    const previous = changed.mock.calls.length; operation(); const deadline = Date.now() + 2_000;
    while (changed.mock.calls.length === previous && Date.now() < deadline) await sleep(20);
    expect(changed.mock.calls.length).toBeGreaterThan(previous);
    await sleep(300);
  };
  try {
    await watcher.subscribe({ sessionId: "s", workspaceRoot: root, gitDir }); await sleep(400);
    const beforeMetadata = changed.mock.calls.length;
    const stamp = new Date(Date.now() + 1_000); utimesSync(refs, stamp, stamp); await sleep(400);
    expect(changed).toHaveBeenCalledTimes(beforeMetadata);
    await change(() => writeFileSync(branch, "1111111\n"));
    await change(() => writeFileSync(branch, "2222222\n"));
    await change(() => renameSync(branch, branch + "-renamed"));
    await change(() => rmSync(branch + "-renamed"));
    await change(() => { mkdirSync(path.dirname(nested), { recursive: true }); writeFileSync(nested, "3333333\n"); });
    await change(() => renameSync(path.dirname(nested), path.join(refs, "heads", "renamed-feature")));
    await change(() => rmSync(path.join(refs, "heads", "renamed-feature"), { recursive: true }));
    await change(() => renameSync(refs, refs + "-old"));
    await change(() => renameSync(refs + "-old", refs));
    await change(() => rmSync(refs, { recursive: true }));
  } finally { await watcher.dispose(); await sleep(100); rmSync(base, { recursive: true, force: true }); }
}, 15_000);
