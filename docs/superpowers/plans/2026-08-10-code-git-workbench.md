# Code Git Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Code 模式接入可信的 Git 状态、轻量侧栏和只读 Diff Review，并让昔涟通过受控工具完成初始化、提交、切换分支、推送和安全回退。

**Architecture:** 主进程以会话绑定的工作区为唯一可信仓库路径，优先调用系统 Git，缺失时回退 Release 内置 MinGit；`simple-git` 负责标准 Git 命令与状态解析，项目只实现可执行文件选择、模式隔离、错误归一和 IPC 胶水。renderer 只消费结构化状态与 unified diff，使用 `react-diff-view` 渲染只读审阅，不执行 shell，也不演化为 IDE。

**Tech Stack:** Electron 43、TypeScript、React 19、Vitest、`simple-git`、`react-diff-view@3.2.1`、Git for Windows MinGit 2.55.0.3 x64

## Global Constraints

- Git 工作台只在 `code` 模式出现；`work`、`chat`、`learn` 不加载 Git 状态，也不暴露 Git 工具。
- Git 仓库根目录只允许来自 `ChatSession.workspaceBinding.workspaceRoot` 或运行时注入的 `ToolContext.resolvedWorkspaceRoot`，renderer 和模型不能提交任意根路径。
- 系统 Git 永远优先；Release Windows 才使用 `process.resourcesPath/mingit/cmd/git.exe` 作为 fallback。
- 系统 Git保留用户凭据、全局配置、Git LFS 和企业证书；MinGit 设置 `GIT_CONFIG_NOSYSTEM=1`、`GIT_CONFIG_GLOBAL=NUL`，不得读取或覆盖用户全局 Git 配置。
- 不自动执行 `git init`；只有用户明确要求后，昔涟才能调用初始化工具。
- Git 写操作继续经过现有 `checkPermission`；renderer 的侧栏按钮只把自然语言请求填入输入框，不绕过 Agent 和权限层直接执行。
- 回退只实现 `git revert --no-edit <commit>`，不提供 `reset --hard`、强推或清理未跟踪文件。
- Review 只读，默认 unified 单栏，可切换 split 双栏；不提供编辑器、终端、文件树、多标签、比较分支和 PR 状态。
- 单文件 patch 上限 2 MiB；二进制文件和超限 patch 显示明确状态，不把失败伪装为空 diff。
- `dist/renderer/react/index.html` 是构建产物，不纳入功能提交。

---

## File Structure

### Shared contracts

- Create `src/shared/code-git-types.ts`: renderer、preload、main 共用的 Git 状态、文件变更、diff 结果类型。
- Modify `src/shared/ipc-channels.ts`: 增加 `CODE_GIT_STATUS`、`CODE_GIT_DIFF`、`CODE_GIT_CHANGED`。

### Main process

- Create `src/main/code-git/git-executable.ts`: 探测系统 Git、Release MinGit 和隔离环境。
- Create `src/main/code-git/git-service.ts`: 读取状态、获取 diff、执行受控写操作并发出仓库变化通知。
- Create `src/main/code-git/code-git-ipc.ts`: 校验 session/mode，注册只读 IPC。
- Create `src/main/orchestrator/git-tools.ts`: 注册昔涟可调用的 Git 工具，复用 `GitService`。
- Modify `src/main/orchestrator/tool-registration.ts`: 显式注入并注册 Git 工具。
- Modify `src/main/index.ts`: 创建 GitService、注册 IPC、把服务传入工具注册。

### Preload and renderer

- Modify `src/preload/index.ts`: 暴露最小 `window.codeGit` 只读 API。
- Create `src/renderer/react/features/chat/components/CodeGitPanel.tsx`: Code 专属 Git 状态侧栏。
- Create `src/renderer/react/features/chat/components/CodeGitPanel.css`: 固定高度、变更列表滚动、底部动作不被挤走。
- Create `src/renderer/react/features/chat/components/CodeDiffReview.tsx`: `react-diff-view` 只读审阅抽屉。
- Create `src/renderer/react/features/chat/components/CodeDiffReview.css`: unified/split 主题和大内容滚动。
- Create `src/renderer/react/features/chat/components/code-git-presentation.ts`: renderer 的状态文案和按钮意图纯函数。
- Modify `src/renderer/react/features/chat/pages/ChatPage.tsx`: 仅在 Code 模式挂载侧栏，按 session 加载/隔离状态，支持把 Git 请求填入当前草稿。

### Release fallback

- Create `vendor/mingit-manifest.json`: 固定 MinGit 版本、官方 URL 和 SHA-256。
- Create `scripts/prepare-mingit.mjs`: 下载、验 hash、缓存并解压 MinGit。
- Modify `.gitignore`: 忽略下载缓存和解压后的 MinGit 目录。
- Modify `electron-builder.yml`: 把 `resources/mingit` 放入 Release 的 `mingit`。
- Modify `package.json` / `package-lock.json`: 增加依赖和 Windows 打包前的 MinGit 准备步骤。
- Create `THIRD_PARTY_NOTICES.md`: 记录 Git for Windows/MinGit 来源、版本、许可证和源码链接。

---

### Task 1: Dependencies and shared Git contract

**Files:**
- Create: `src/shared/code-git-types.ts`
- Create: `src/shared/code-git-types.test.ts`
- Modify: `src/shared/ipc-channels.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Produces: `CodeGitStatus`, `CodeGitFileChange`, `CodeGitDiffResult`, `CodeGitChangedPayload`.
- Produces IPC channels: `CODE_GIT_STATUS`, `CODE_GIT_DIFF`, `CODE_GIT_CHANGED`.

- [ ] **Step 1: Install mature dependencies**

Run:

```powershell
npm install simple-git react-diff-view@3.2.1
```

Expected: `package.json` contains both runtime dependencies and the lockfile resolves `react-diff-view` with React peer range `>=16.14.0`, which includes React 19.

- [ ] **Step 2: Write the failing shared-contract test**

```ts
import { describe, expect, it } from "vitest";
import { emptyCodeGitStatus } from "./code-git-types";

describe("emptyCodeGitStatus", () => {
  it("keeps unavailable states truthful and empty", () => {
    expect(emptyCodeGitStatus("session-1", "not_repository", "尚未初始化 Git 仓库")).toEqual({
      sessionId: "session-1",
      state: "not_repository",
      message: "尚未初始化 Git 仓库",
      executable: null,
      branch: null,
      files: [],
      summary: { added: 0, modified: 0, deleted: 0, renamed: 0, conflicted: 0 },
      ahead: 0,
      behind: 0,
    });
  });
});
```

- [ ] **Step 3: Run the test and confirm RED**

Run: `npx vitest run src/shared/code-git-types.test.ts`

Expected: FAIL because `code-git-types.ts` does not exist.

- [ ] **Step 4: Add the exact shared types**

```ts
export type CodeGitState =
  | "ready"
  | "no_workspace"
  | "git_unavailable"
  | "not_repository"
  | "error";

export type CodeGitExecutableSource = "system" | "bundled";
export type CodeGitChangeKind = "added" | "modified" | "deleted" | "renamed" | "conflicted";

export interface CodeGitFileChange {
  path: string;
  fromPath?: string;
  kind: CodeGitChangeKind;
  staged: boolean;
  unstaged: boolean;
}

export interface CodeGitStatus {
  sessionId: string;
  state: CodeGitState;
  message?: string;
  executable: { source: CodeGitExecutableSource; version: string } | null;
  branch: { current: string | null; detached: boolean; branches: string[] } | null;
  files: CodeGitFileChange[];
  summary: Record<CodeGitChangeKind, number>;
  ahead: number;
  behind: number;
}

export type CodeGitDiffResult =
  | { kind: "ready"; sessionId: string; path: string; patch: string }
  | { kind: "binary"; sessionId: string; path: string }
  | { kind: "too_large"; sessionId: string; path: string; maxBytes: number }
  | { kind: "error"; sessionId: string; path: string; message: string };

export interface CodeGitChangedPayload { sessionId: string }

export function emptyCodeGitStatus(
  sessionId: string,
  state: Exclude<CodeGitState, "ready">,
  message: string,
): CodeGitStatus {
  return {
    sessionId,
    state,
    message,
    executable: null,
    branch: null,
    files: [],
    summary: { added: 0, modified: 0, deleted: 0, renamed: 0, conflicted: 0 },
    ahead: 0,
    behind: 0,
  };
}
```

Add the three IPC constants with values `code-git:status`, `code-git:diff`, and `code-git:changed`.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npx vitest run src/shared/code-git-types.test.ts src/shared/ipc-channels-react-window.test.ts`

Expected: PASS.

Commit:

```powershell
git add package.json package-lock.json src/shared/code-git-types.ts src/shared/code-git-types.test.ts src/shared/ipc-channels.ts
git commit -m "feat: define code git contracts"
```

---

### Task 2: System Git preference and read-only Git service

**Files:**
- Create: `src/main/code-git/git-executable.ts`
- Create: `src/main/code-git/git-executable.test.ts`
- Create: `src/main/code-git/git-service.ts`
- Create: `src/main/code-git/git-service.test.ts`

**Interfaces:**
- Produces: `resolveGitExecutable(deps): Promise<ResolvedGitExecutable | null>`.
- Produces: `createGitService(deps): GitService`.
- `GitService` methods used later: `getStatusForSession(sessionId)`, `getDiffForSession(sessionId, path)`, mutation methods, and `onChanged(listener)`.

- [ ] **Step 1: Write resolver tests for source priority and isolated MinGit**

```ts
it("prefers a working system Git over bundled MinGit", async () => {
  const result = await resolveGitExecutable({
    systemCommand: "git",
    bundledPath: "C:\\app\\resources\\mingit\\cmd\\git.exe",
    probe: vi.fn(async (candidate) => candidate === "git" ? "git version 2.55.0" : null),
  });
  expect(result).toMatchObject({ command: "git", source: "system", version: "2.55.0" });
});

it("uses isolated bundled MinGit only when system Git is unavailable", async () => {
  const probe = vi.fn(async (candidate) => candidate === "git" ? null : "git version 2.55.0.windows.3");
  const result = await resolveGitExecutable({
    systemCommand: "git",
    bundledPath: "C:\\app\\resources\\mingit\\cmd\\git.exe",
    probe,
  });
  expect(result).toMatchObject({
    source: "bundled",
    env: { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "NUL" },
  });
});
```

- [ ] **Step 2: Run resolver tests and confirm RED**

Run: `npx vitest run src/main/code-git/git-executable.test.ts`

Expected: FAIL because the resolver is absent.

- [ ] **Step 3: Implement executable resolution without shell strings**

Use `execFile(command, ["--version"], { windowsHide: true, timeout: 3000 })`. In development resolve bundled Git from `path.join(app.getAppPath(), "resources", "mingit", "cmd", "git.exe")`; in packaged builds use `path.join(process.resourcesPath, "mingit", "cmd", "git.exe")`. Probe `git` first on every process start, then the bundled path.

```ts
export interface ResolvedGitExecutable {
  command: string;
  source: "system" | "bundled";
  version: string;
  env?: NodeJS.ProcessEnv;
}

export async function resolveGitExecutable(deps: ResolveGitExecutableDeps): Promise<ResolvedGitExecutable | null> {
  const systemVersion = await deps.probe(deps.systemCommand);
  if (systemVersion) return { command: deps.systemCommand, source: "system", version: parseVersion(systemVersion) };

  const bundledVersion = await deps.probe(deps.bundledPath);
  if (!bundledVersion) return null;
  return {
    command: deps.bundledPath,
    source: "bundled",
    version: parseVersion(bundledVersion),
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "NUL" },
  };
}
```

- [ ] **Step 4: Write GitService tests with injected session and Git client adapters**

Cover these exact cases:

```ts
it.each(["work", "chat", "learn"])("rejects %s sessions", async (mode) => {
  const service = makeService({ session: { id: "s", mode, workspaceBinding: { workspaceRoot: "C:\\repo" } } });
  await expect(service.getStatusForSession("s")).resolves.toMatchObject({ state: "error" });
});

it("returns not_repository instead of an empty ready repository", async () => {
  const service = makeService({ mode: "code", isRepo: false });
  await expect(service.getStatusForSession("s")).resolves.toMatchObject({ state: "not_repository", files: [] });
});

it("normalizes status, branches, ahead and behind", async () => {
  const service = makeService({
    mode: "code",
    isRepo: true,
    status: {
      current: "main", ahead: 2, behind: 1,
      created: ["new.ts"], modified: ["changed.ts"], deleted: ["old.ts"],
      renamed: [{ from: "a.ts", to: "b.ts" }], conflicted: ["conflict.ts"],
      staged: ["new.ts"], files: [],
    },
    branches: { all: ["main", "feature/x"] },
  });
  const result = await service.getStatusForSession("s");
  expect(result).toMatchObject({ state: "ready", ahead: 2, behind: 1 });
  expect(result.files.map((file) => file.kind)).toEqual(["added", "modified", "deleted", "renamed", "conflicted"]);
});

it("rejects absolute and parent-traversal diff paths", async () => {
  const service = makeService({ mode: "code", isRepo: true });
  await expect(service.getDiffForSession("s", "..\\secret.txt")).resolves.toMatchObject({ kind: "error" });
  await expect(service.getDiffForSession("s", "C:\\secret.txt")).resolves.toMatchObject({ kind: "error" });
});
```

- [ ] **Step 5: Run service tests and confirm RED**

Run: `npx vitest run src/main/code-git/git-service.test.ts`

Expected: FAIL because `createGitService` is absent.

- [ ] **Step 6: Implement the minimum read service**

Create one `simple-git` client per request with `baseDir` fixed to the trusted workspace and `binary` fixed to the resolved executable. Use `checkIsRepo()`, `status()`, and `branchLocal()`; do not accept a renderer-supplied root. For diff, accept only a normalized relative path already present in the current status:

```ts
export interface GitService {
  getStatusForSession(sessionId: string): Promise<CodeGitStatus>;
  getDiffForSession(sessionId: string, relativePath: string): Promise<CodeGitDiffResult>;
  initRepository(ctx: TrustedGitContext): Promise<string>;
  commit(ctx: TrustedGitContext, message: string, paths: string[]): Promise<string>;
  switchBranch(ctx: TrustedGitContext, branch: string, create: boolean): Promise<string>;
  push(ctx: TrustedGitContext, remote?: string): Promise<string>;
  revert(ctx: TrustedGitContext, commit: string): Promise<string>;
  onChanged(listener: (payload: CodeGitChangedPayload) => void): () => void;
}

export interface TrustedGitContext {
  sessionId: string;
  mode: "code";
  workspaceRoot: string;
}
```

Tracked/staged files use `git diff --no-ext-diff HEAD -- <path>`. Untracked files use `git diff --no-index -- /dev/null <absolute-file>` and treat exit code `1` as a successful diff result. Set the process output ceiling to `2 * 1024 * 1024` bytes; classify a larger result as `too_large`, and a `Binary files ... differ` patch as `binary`.

- [ ] **Step 7: Verify Task 2 and commit**

Run:

```powershell
npx vitest run src/main/code-git/git-executable.test.ts src/main/code-git/git-service.test.ts
npm run build:main
```

Expected: all tests PASS and main TypeScript build exits 0.

Commit:

```powershell
git add src/main/code-git
git commit -m "feat: add trusted code git service"
```

---

### Task 3: IPC and preload boundary

**Files:**
- Create: `src/main/code-git/code-git-ipc.ts`
- Create: `src/main/code-git/code-git-ipc.test.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: `GitService.getStatusForSession` and `GitService.getDiffForSession`.
- Produces renderer API: `window.codeGit.getStatus(sessionId)`, `getDiff(sessionId, path)`, `onChanged(callback)`.

- [ ] **Step 1: Write failing IPC tests**

```ts
it("passes only sessionId and repository-relative path to GitService", async () => {
  registerCodeGitIpc({ ipcMain: fakeIpcMain, service });
  await handlers.get(IPC.CODE_GIT_STATUS)?.({}, "session-1");
  await handlers.get(IPC.CODE_GIT_DIFF)?.({}, { sessionId: "session-1", path: "src/a.ts" });
  expect(service.getStatusForSession).toHaveBeenCalledWith("session-1");
  expect(service.getDiffForSession).toHaveBeenCalledWith("session-1", "src/a.ts");
});

it("broadcasts only the changed session identity", () => {
  changedListener?.({ sessionId: "session-1" });
  expect(send).toHaveBeenCalledWith(IPC.CODE_GIT_CHANGED, { sessionId: "session-1" });
});
```

- [ ] **Step 2: Confirm RED**

Run: `npx vitest run src/main/code-git/code-git-ipc.test.ts`

Expected: FAIL because the registrar is absent.

- [ ] **Step 3: Register the narrow IPC boundary**

Reject empty session IDs and empty/absolute diff paths before calling the service. Broadcast `CODE_GIT_CHANGED` through `BrowserWindow.getAllWindows()` and include only `{ sessionId }`.

Expose this preload object:

```ts
const codeGitApi = {
  getStatus: (sessionId: string) => ipcRenderer.invoke(IPC.CODE_GIT_STATUS, sessionId),
  getDiff: (sessionId: string, path: string) => ipcRenderer.invoke(IPC.CODE_GIT_DIFF, { sessionId, path }),
  onChanged: (callback: (payload: CodeGitChangedPayload) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: CodeGitChangedPayload) => callback(payload);
    ipcRenderer.on(IPC.CODE_GIT_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC.CODE_GIT_CHANGED, listener);
  },
};
contextBridge.exposeInMainWorld("codeGit", codeGitApi);
```

Create and register one service instance after `registerChatsIpc()` and before `registerAllTools()`.

- [ ] **Step 4: Verify and commit**

Run:

```powershell
npx vitest run src/main/code-git/code-git-ipc.test.ts
npm run build:main
npm run build:preload
```

Expected: PASS / exit 0.

Commit:

```powershell
git add src/main/code-git/code-git-ipc.ts src/main/code-git/code-git-ipc.test.ts src/preload/index.ts src/main/index.ts
git commit -m "feat: expose code git read api"
```

---

### Task 4: Code-only Git side panel

**Files:**
- Create: `src/renderer/react/features/chat/components/code-git-presentation.ts`
- Create: `src/renderer/react/features/chat/components/code-git-presentation.test.ts`
- Create: `src/renderer/react/features/chat/components/CodeGitPanel.tsx`
- Create: `src/renderer/react/features/chat/components/CodeGitPanel.css`
- Modify: `src/renderer/react/features/chat/pages/ChatPage.tsx`

**Interfaces:**
- Consumes: `CodeGitStatus` and `window.codeGit`.
- Produces: `CodeGitPanel({ sessionId, onOpenDiff, onRequestAgentAction })`.

- [ ] **Step 1: Write failing presentation tests**

```ts
it("summarizes only real changes", () => {
  expect(buildGitPanelSummary(statusWith({ added: 2, modified: 3, deleted: 1 }))).toBe("6 个变更");
});

it("chooses commit before push when the tree is dirty", () => {
  expect(buildGitActionIntent(statusWith({ files: [{ path: "a.ts" }], ahead: 2 }))).toEqual({
    label: "提交变更",
    prompt: "请检查当前 Git 变更，并在确认合适后提交。",
  });
});

it("chooses push when clean commits are ahead", () => {
  expect(buildGitActionIntent(statusWith({ files: [], ahead: 2 }))).toEqual({
    label: "推送 2 个提交",
    prompt: "请把当前分支尚未推送的 2 个提交推送到远端。",
  });
});
```

- [ ] **Step 2: Confirm RED, then implement the pure presentation helper**

Run: `npx vitest run src/renderer/react/features/chat/components/code-git-presentation.test.ts`

Expected before implementation: FAIL. After adding exact state-to-copy mappings: PASS.

Required state copy:

```text
no_workspace    → 尚未绑定代码目录
git_unavailable → 未检测到可用 Git
not_repository  → 这个目录还不是 Git 仓库
error           → Git 状态暂时不可用
ready clean     → 工作区干净
```

- [ ] **Step 3: Build the compact Code panel**

Use the existing `工作中.png` mascot. The panel contains exactly three sections: `变更`、`分支`、`提交或推送`。Do not add `本地`、比较分支或 PR 状态。

Layout contract:

```css
.cy-code-git {
  position: fixed;
  width: 260px;
  height: min(420px, calc(100vh - 96px));
  display: flex;
  flex-direction: column;
}
.cy-code-git__files {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}
.cy-code-git__footer { flex-shrink: 0; }
```

The branch and commit/push rows call `onRequestAgentAction(prompt)`; they do not invoke Git IPC mutations directly. File rows call `onOpenDiff(file.path)`.

- [ ] **Step 4: Bind panel state to the active Code session**

In `ChatPage.tsx`:

```tsx
{mode === "code" && activeSessionId && (
  <CodeGitPanel
    sessionId={activeSessionId}
    onOpenDiff={setReviewPath}
    onRequestAgentAction={(prompt) =>
      setDrafts((current) => ({ ...current, [scopeKey]: prompt }))
    }
  />
)}
```

The component must refetch when `sessionId` changes, ignore stale promise results with an effect-local cancelled flag, subscribe to `CODE_GIT_CHANGED`, filter by matching session ID, and expose a manual refresh button.

- [ ] **Step 5: Verify and commit**

Run:

```powershell
npx vitest run src/renderer/react/features/chat/components/code-git-presentation.test.ts src/renderer/react/features/chat/pages/ChatPage.test.ts
npm run build:renderer
```

Expected: tests PASS; Code build contains the Git panel; Work/Chat/Learn branches contain no `CodeGitPanel` mount.

Commit:

```powershell
git add src/renderer/react/features/chat/components/CodeGitPanel.tsx src/renderer/react/features/chat/components/CodeGitPanel.css src/renderer/react/features/chat/components/code-git-presentation.ts src/renderer/react/features/chat/components/code-git-presentation.test.ts src/renderer/react/features/chat/pages/ChatPage.tsx
git commit -m "feat: show code git workspace panel"
```

---

### Task 5: Read-only Diff Review

**Files:**
- Create: `src/renderer/react/features/chat/components/CodeDiffReview.tsx`
- Create: `src/renderer/react/features/chat/components/CodeDiffReview.css`
- Create: `src/renderer/react/features/chat/components/code-diff-view-model.ts`
- Create: `src/renderer/react/features/chat/components/code-diff-view-model.test.ts`
- Modify: `src/renderer/react/features/chat/pages/ChatPage.tsx`

**Interfaces:**
- Consumes: `window.codeGit.getDiff(sessionId, path)`.
- Produces: `CodeDiffReview({ sessionId, path, open, onClose })`.

- [ ] **Step 1: Write failing diff view-model tests**

```ts
it("parses a unified patch into react-diff-view files", () => {
  const model = buildCodeDiffViewModel({
    kind: "ready",
    sessionId: "s",
    path: "src/a.ts",
    patch: "diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n",
  });
  expect(model.kind).toBe("ready");
  if (model.kind === "ready") expect(model.files[0].hunks).toHaveLength(1);
});

it.each(["binary", "too_large", "error"])("preserves %s as an explicit state", (kind) => {
  expect(buildCodeDiffViewModel(makeDiffResult(kind)).kind).toBe(kind);
});
```

- [ ] **Step 2: Confirm RED, then implement with `parseDiff`**

Run: `npx vitest run src/renderer/react/features/chat/components/code-diff-view-model.test.ts`

Expected before implementation: FAIL. Implement `buildCodeDiffViewModel` with `parseDiff` from `react-diff-view`, then expect PASS.

- [ ] **Step 3: Implement the review drawer**

Import `react-diff-view/style/index.css` once. Render each parsed file with `Diff` and `Hunk`:

```tsx
<Diff
  viewType={viewType}
  diffType={file.type}
  hunks={file.hunks}
>
  {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
</Diff>
```

Use an Ant Design `Drawer` only as the shell. Header contains file path, `单栏` / `双栏` toggle, and close button. There is no editable textarea, contentEditable region, save button, terminal or repository tree. Default `viewType` is `unified`; switching to `split` preserves the same parsed patch.

- [ ] **Step 4: Mount the drawer per active session**

Reset `reviewPath` to `null` whenever mode or active session changes. If a late diff response belongs to the previous session, discard it. Closing the drawer does not mutate Git state.

- [ ] **Step 5: Verify and commit**

Run:

```powershell
npx vitest run src/renderer/react/features/chat/components/code-diff-view-model.test.ts
npm run build:renderer
```

Expected: PASS / exit 0, with no TypeScript or CSS import error from React 19.

Commit:

```powershell
git add src/renderer/react/features/chat/components/CodeDiffReview.tsx src/renderer/react/features/chat/components/CodeDiffReview.css src/renderer/react/features/chat/components/code-diff-view-model.ts src/renderer/react/features/chat/components/code-diff-view-model.test.ts src/renderer/react/features/chat/pages/ChatPage.tsx
git commit -m "feat: add read-only git diff review"
```

---

### Task 6: Controlled Git tools for Cyrene

**Files:**
- Create: `src/main/orchestrator/git-tools.ts`
- Create: `src/main/orchestrator/git-tools.test.ts`
- Modify: `src/main/orchestrator/tool-registration.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: mutation methods on `GitService` and trusted `ToolContext`.
- Produces tools: `git_status`, `git_init`, `git_commit`, `git_switch_branch`, `git_push`, `git_revert`.

- [ ] **Step 1: Write failing registration and trust-boundary tests**

```ts
it("rejects Git mutation outside Code mode", async () => {
  const tools = createCodeGitTools(service);
  await expect(tools.git_init.execute({}, {
    mode: "work",
    conversationId: "s",
    resolvedWorkspaceRoot: "C:\\repo",
    userQuery: "init",
  })).rejects.toThrow("Git 工具只允许在 Code 模式使用");
});

it("ignores model paths and uses the runtime workspace", async () => {
  const tools = createCodeGitTools(service);
  await tools.git_commit.execute({ message: "feat: x", paths: ["src/a.ts"] }, codeContext("C:\\trusted"));
  expect(service.commit).toHaveBeenCalledWith(
    expect.objectContaining({ workspaceRoot: "C:\\trusted" }),
    "feat: x",
    ["src/a.ts"],
  );
});

it("does not expose reset hard or force push", () => {
  const ids = Object.keys(createCodeGitTools(service));
  expect(ids).not.toContain("git_reset");
  expect(JSON.stringify(createCodeGitTools(service))).not.toContain("force");
});
```

- [ ] **Step 2: Confirm RED**

Run: `npx vitest run src/main/orchestrator/git-tools.test.ts`

Expected: FAIL because Git tools are absent.

- [ ] **Step 3: Implement six narrow tools**

Use these risks and effects:

| Tool | Risk | Effect | Required input |
|---|---|---|---|
| `git_status` | `fs-read` | `read` | none |
| `git_init` | `fs-write` | `mutation` | none |
| `git_commit` | `fs-write` | `mutation` | `message`, non-empty `paths` |
| `git_switch_branch` | `fs-write` | `mutation` | `branch`, optional `create=false` |
| `git_push` | `shell` | `external_side_effect` | optional `remote=origin` |
| `git_revert` | `fs-write` | `mutation` | full commit hash |

Every tool sets `needsContext: true`. `requireCodeGitContext(ctx)` must require `ctx.mode === "code"`, a non-empty `ctx.conversationId`, and a non-empty `ctx.resolvedWorkspaceRoot`. No tool schema contains `workspaceRoot`.

`git_commit` runs `git add -A -- <validated paths>` and then `git commit -m <message>`. `git_push` never adds `--force`. `git_revert` accepts `/^[0-9a-f]{7,40}$/i` and runs `git revert --no-edit <hash>`.

- [ ] **Step 4: Inject GitService through explicit tool registration**

Change:

```ts
export function registerAllTools(deps: { codeGitService: GitService }): void {
  registerCodeGitTools(deps.codeGitService);
  // existing registrations remain unchanged
}
```

Call it from `main/index.ts` with the same service instance used by IPC. Each successful mutation calls the service change emitter; IPC broadcasts the matching conversation ID and only that Code panel refreshes.

- [ ] **Step 5: Verify and commit**

Run:

```powershell
npx vitest run src/main/orchestrator/git-tools.test.ts src/main/orchestrator/harness/tool-dispatcher.test.ts
npm run build:main
```

Expected: PASS / exit 0.

Commit:

```powershell
git add src/main/orchestrator/git-tools.ts src/main/orchestrator/git-tools.test.ts src/main/orchestrator/tool-registration.ts src/main/index.ts
git commit -m "feat: add controlled git tools for code mode"
```

---

### Task 7: Reproducible Windows MinGit fallback

**Files:**
- Create: `vendor/mingit-manifest.json`
- Create: `scripts/prepare-mingit.mjs`
- Create: `scripts/prepare-mingit.test.mjs`
- Create: `THIRD_PARTY_NOTICES.md`
- Modify: `.gitignore`
- Modify: `electron-builder.yml`
- Modify: `package.json`
- Modify: `package-lock.json`

**Interfaces:**
- Consumes: bundled path contract `process.resourcesPath/mingit/cmd/git.exe` from Task 2.
- Produces: reproducibly prepared `resources/mingit/cmd/git.exe` for Windows packaging.

- [ ] **Step 1: Add the pinned official manifest**

```json
{
  "name": "Git for Windows MinGit",
  "version": "2.55.0.3",
  "url": "https://github.com/git-for-windows/git/releases/download/v2.55.0.windows.3/MinGit-2.55.0.3-64-bit.zip",
  "sha256": "f48e2d2dc74a24454adc6d8fd0ac25bf9c2386f19cfb06202b9465aaad4f9f05"
}
```

- [ ] **Step 2: Write failing checksum/cache tests**

Export `sha256File`, `needsDownload`, and `prepareMinGit` from the script. Test with a temp directory and a fake downloader:

```js
test("rejects an archive whose sha256 differs from the manifest", async () => {
  await assert.rejects(
    prepareMinGit({ manifest: { ...manifest, sha256: "0".repeat(64) }, cacheDir, outputDir, download, extract }),
    /SHA-256 mismatch/,
  );
});

test("reuses an extracted matching git.exe", async () => {
  await fs.mkdir(path.join(outputDir, "cmd"), { recursive: true });
  await fs.writeFile(path.join(outputDir, "cmd", "git.exe"), "fake");
  const result = await prepareMinGit({ manifest, cacheDir, outputDir, download, extract, probe: async () => true });
  assert.equal(result, "cached");
  assert.equal(download.mock.calls.length, 0);
});
```

- [ ] **Step 3: Implement download, SHA verification and extraction**

Use Node `fetch`, `crypto.createHash("sha256")`, and the mature `extract-zip` package. Download to `.cache/mingit/<asset>.partial`, verify the exact digest, atomically rename to `.zip`, extract to a temporary sibling directory, verify `cmd/git.exe --version`, then rename into `resources/mingit`. Delete only task-owned `.partial` and temporary extraction paths on failure.

- [ ] **Step 4: Wire packaging and license notice**

Add:

```yaml
extraResources:
  - from: resources/bin/cyrene-screenshot.exe
    to: bin/cyrene-screenshot.exe
  - from: resources/mingit
    to: mingit
```

Add scripts:

```json
{
  "prepare:mingit": "node scripts/prepare-mingit.mjs",
  "package:win:dir": "npm run build && npm run build:screenshot-helper && npm run prepare:mingit && electron-builder --win --dir"
}
```

Ignore `.cache/mingit/` and `resources/mingit/`. In `THIRD_PARTY_NOTICES.md`, record MinGit 2.55.0.3, Git for Windows source URL, GPL-2.0 license, and note that the packaged MinGit archive retains its own license files.

- [ ] **Step 5: Verify fallback package and commit**

Run:

```powershell
node --test scripts/prepare-mingit.test.mjs
npm run prepare:mingit
& 'resources\mingit\cmd\git.exe' --version
npm run package:win:dir
& 'release\win-unpacked\resources\mingit\cmd\git.exe' --version
```

Expected: both Git version commands report `2.55.0.windows.3`; the package build exits 0.

Commit only the manifest, script, tests, notice, lock/config changes; do not commit `.cache/mingit`, `resources/mingit`, or `release`.

```powershell
git add vendor/mingit-manifest.json scripts/prepare-mingit.mjs scripts/prepare-mingit.test.mjs THIRD_PARTY_NOTICES.md .gitignore electron-builder.yml package.json package-lock.json
git commit -m "build: bundle mingit fallback for windows"
```

---

### Task 8: Cross-mode regression and manual acceptance

**Files:**
- Modify only if a failing regression exposes a product-code defect.

**Interfaces:**
- Verifies the complete Code Git boundary; produces no new feature API.

- [ ] **Step 1: Run targeted suites**

```powershell
npx vitest run src/shared/code-git-types.test.ts src/main/code-git src/main/orchestrator/git-tools.test.ts src/renderer/react/features/chat/components/code-git-presentation.test.ts src/renderer/react/features/chat/components/code-diff-view-model.test.ts src/renderer/react/features/chat/pages/ChatPage.test.ts
```

Expected: all targeted tests PASS.

- [ ] **Step 2: Run full automated verification**

```powershell
npm test
npm run build:main
npm run build:preload
npm run build:renderer
git diff --check
```

Expected: full tests PASS, all three builds exit 0, and `git diff --check` has no output.

- [ ] **Step 3: Manually accept the read-only slice**

Use one Code session bound to a Git repository containing added, modified, deleted and renamed files:

1. Open the Code session: panel shows the current branch and exact changed-file count.
2. Switch to Work, Chat and Learn: Git panel disappears and no Git-status request is issued.
3. Return to Code: the same session state reloads; switching to another Code session shows that session's repository only.
4. Click a tracked file: unified review opens; switching to split preserves the same hunks.
5. Click an untracked file: it appears as a full-file addition.
6. Open a binary or larger-than-2-MiB diff: UI shows the explicit binary/too-large state.
7. Remove Git from PATH in a packaged test environment: bundled MinGit reports ready.
8. Use a folder without `.git`: panel says `这个目录还不是 Git 仓库`, not `工作区干净`.

- [ ] **Step 4: Manually accept Agent mutations**

In Code mode, ask昔涟 to perform these actions in a disposable repository:

1. `请初始化这个目录为 Git 仓库` → permission policy applies, then panel refreshes to ready.
2. `请把 src/a.ts 提交，消息为 feat: add a` → only that path is staged and committed.
3. `请创建并切换到 feature/review` → current branch updates after tool completion.
4. `请推送当前分支` → permission policy applies; no `--force` is used.
5. `请回退提交 <hash>` → produces a revert commit and preserves unrelated working-tree files.
6. Repeat each request in Work/Learn/Chat → Git tool is unavailable or rejects the non-Code context.

- [ ] **Step 5: Final boundary review**

Confirm the diff contains none of these forbidden capabilities: direct renderer shell execution, renderer-provided workspace root, `git reset --hard`, force push, automatic `git init`, Work-mode Git UI, code editor, terminal, compare-branch UI, or PR status.

If Task 8 requires no product-code fixes, no extra commit is needed. If it finds a defect, add a failing regression test, make the minimum fix, rerun Steps 1–2, and commit the exact affected files with `fix: harden code git acceptance`.

---

## Execution Order and Review Gates

1. **Gate A — Git read foundation:** Tasks 1–3. Reviewer confirms source priority, trusted path boundary and truthful error states.
2. **Gate B — Usable Code UI:** Task 4. Reviewer confirms the compact three-section panel before Review styling begins.
3. **Gate C — Read-only Review:** Task 5. At this point the first user-visible slice is complete and independently shippable for source users with system Git.
4. **Gate D — Agent write operations:** Task 6. Reviewer checks permission semantics and destructive-command exclusions.
5. **Gate E — Release reliability:** Task 7. Reviewer verifies hash-pinned MinGit packaging and licensing.
6. **Gate F — Whole feature:** Task 8. Full regression plus manual cross-mode acceptance.

## Self-Review Results

- Spec coverage: system Git priority, bundled MinGit fallback, Code-only UI, structured status, unified/split diff, Agent Git tools, permissions, truthful degraded states and exactly scoped refresh all map to Tasks 2–8.
- Reuse check: `simple-git` replaces home-grown status parsing; `react-diff-view` replaces diff parsing/rendering; `extract-zip` replaces custom ZIP extraction. Custom code remains only for Cyrene trust boundaries, IPC, presentation and packaging policy.
- Type consistency: `CodeGitStatus`, `CodeGitDiffResult`, `GitService`, `TrustedGitContext` and `CodeGitChangedPayload` have one definition and are consumed with the same names in all later tasks.
- Deferred work is explicit: editing, terminal, file tree, compare branches, PR workflows, force push, hard reset and Git UI outside Code are outside this plan.
