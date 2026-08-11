# Code LSP Client Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Cyrene Code mode a language-agnostic LSP client that discovers and connects to user-installed language servers, exposes semantic code operations to the model, and never bundles or silently installs server binaries.

**Architecture:** Use Microsoft's maintained `vscode-jsonrpc` transport and `vscode-languageserver-types` protocol types. Cyrene owns a declarative server catalog, executable discovery, process lifecycle, workspace/document synchronization, operation normalization, security checks, and Harness tool registration. Language servers remain external user-managed programs; missing servers produce actionable installation guidance, and Cyrene may install only through existing permission-controlled tools after explicit user intent.

**Tech Stack:** TypeScript 5.6, Node child processes, `vscode-jsonrpc`, `vscode-languageserver-types`, Electron Main, existing ToolRegistry/Harness/permission system, Vitest 4.

## Global Constraints

- Code mode only. Work, Learn, and Chat never advertise the `lsp` tool.
- Cyrene ships no language-server executable and contains no automatic downloader/updater.
- Discovery order: explicit user configuration, workspace-local executable, then system PATH.
- The trusted `ToolContext.resolvedWorkspaceRoot` is the only workspace root. Model arguments cannot override it.
- Every file path is resolved under the trusted workspace using realpath-aware containment checks; external paths are rejected.
- Child processes use `shell: false`, hidden windows on Windows, explicit argv arrays, bounded stderr capture, and cancellation-aware request timeouts.
- One server process is reused per `{workspaceRoot, serverId, command}` and disposed on workspace release/app shutdown/process failure.
- Server installation is outside the LSP client. The `lsp` result may return an install hint; Cyrene can separately use existing permission-controlled shell/package tools if the user requests installation.
- Supported operations: `goToDefinition`, `findReferences`, `hover`, `documentSymbol`, `workspaceSymbol`, `goToImplementation`, `diagnostics`, `prepareCallHierarchy`, `incomingCalls`, and `outgoingCalls`.
- Model-facing line and character are 1-based; LSP wire positions are 0-based.
- No LSP result may include data outside the bound workspace unless it is standard-library/dependency metadata explicitly returned by the server; external file locations must be labeled as external and never passed to write tools as trusted paths.
- README documents prerequisites, discovery, supported built-in server definitions, custom configuration, privacy, and troubleshooting.

## Reuse Decisions

- Add direct runtime dependencies on `vscode-jsonrpc` and `vscode-languageserver-types`; do not rely on transitive packages.
- Reuse existing `child_process.spawn`, ToolRegistry mode filtering, ToolContext workspace binding, permission checks, abort propagation, and logger.
- Borrow OpenCode's operation contract and server-catalog idea, not its Effect runtime, database, process utilities, or source files.
- Keep custom code limited to Cyrene-specific catalog/discovery/lifecycle/security/tool glue.

---

### Task 1: Add protocol dependencies and freeze shared contracts

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `src/main/lsp/types.ts`
- Create: `src/main/lsp/types.test.ts`

**Interfaces:**
- Produces: `LspOperation`, `LspServerDefinition`, `LspServerCommand`, `LspPositionInput`, `LspQuery`, `LspToolResult`, and stable error codes.

- [ ] **Step 1: Install mature protocol packages**

```powershell
npm install vscode-jsonrpc vscode-languageserver-types
```

Verify both appear as direct `dependencies`, not `devDependencies` or transitive-only entries.

- [ ] **Step 2: Write failing contract tests**

Assert supported operation literals, one-based input validation, normalized result shape, and these error codes:

```text
LSP_WORKSPACE_REQUIRED
LSP_PATH_OUTSIDE_WORKSPACE
LSP_FILE_NOT_FOUND
LSP_SERVER_NOT_FOUND
LSP_SERVER_START_FAILED
LSP_INITIALIZE_TIMEOUT
LSP_REQUEST_TIMEOUT
LSP_REQUEST_FAILED
LSP_UNSUPPORTED_OPERATION
```

- [ ] **Step 3: Implement minimal contracts**

```ts
export type LspOperation =
  | "goToDefinition" | "findReferences" | "hover"
  | "documentSymbol" | "workspaceSymbol" | "goToImplementation"
  | "diagnostics" | "prepareCallHierarchy" | "incomingCalls" | "outgoingCalls";

export interface LspToolResult {
  serverId: string;
  operation: LspOperation;
  workspaceRoot: string;
  items: unknown[];
  message: string;
}
```

- [ ] **Step 4: Verify and commit**

```powershell
npx vitest run src/main/lsp/types.test.ts
npm run build:main
git add package.json package-lock.json src/main/lsp/types.ts src/main/lsp/types.test.ts
git commit -m "build: add lsp protocol client"
```

---

### Task 2: Define the multi-language server catalog

**Files:**
- Create: `src/main/lsp/server-catalog.ts`
- Create: `src/main/lsp/server-catalog.test.ts`

**Interfaces:**
- Produces: `BUILTIN_LSP_SERVERS`, `findServerCandidates(filePath, overrides)`, and install hints.

- [ ] **Step 1: Write failing catalog tests**

Cover TypeScript/JavaScript/JSON, Python, Go, Rust, C/C++, Java, C#, PHP, Ruby, Kotlin, Lua, Vue, YAML, and user override precedence. Assert unsupported extensions return an empty list rather than guessing.

- [ ] **Step 2: Define declarative candidates**

Each definition contains only metadata:

```ts
{
  id: "python-pyright",
  extensions: [".py", ".pyi"],
  commands: [{ command: "pyright-langserver", args: ["--stdio"] }],
  rootMarkers: ["pyproject.toml", "requirements.txt", "setup.py", ".git"],
  installHint: "安装 pyright，并确保 pyright-langserver 位于 PATH。",
}
```

Equivalent definitions cover `typescript-language-server --stdio`, `gopls`, `rust-analyzer`, `clangd`, `jdtls`, `OmniSharp -lsp`, `intelephense --stdio`, `ruby-lsp`, `kotlin-language-server`, `lua-language-server`, `vue-language-server --stdio`, and `yaml-language-server --stdio`.

- [ ] **Step 3: Resolve overrides first**

User configuration can replace command/args, extensions, initialization options, and environment additions by server ID. Validate all strings and arrays before use; invalid overrides are ignored with a logged warning, not forwarded to `spawn`.

- [ ] **Step 4: Verify and commit**

```powershell
npx vitest run src/main/lsp/server-catalog.test.ts
npm run build:main
git add src/main/lsp/server-catalog.ts src/main/lsp/server-catalog.test.ts
git commit -m "feat: define lsp server catalog"
```

---

### Task 3: Discover user-installed servers without a shell

**Files:**
- Create: `src/main/lsp/server-discovery.ts`
- Create: `src/main/lsp/server-discovery.test.ts`

**Interfaces:**
- Consumes: server candidates and trusted workspace root.
- Produces: `resolveLspServer(definition, workspaceRoot): ResolvedLspServer | null`.

- [ ] **Step 1: Write failing precedence and Windows tests**

Assert discovery order:

```text
absolute custom command
workspace/node_modules/.bin with Windows PATHEXT handling
system PATH entries
missing with installHint
```

Reject directories and non-files. Never concatenate a shell command.

- [ ] **Step 2: Implement deterministic discovery**

Parse `PATH` and `PATHEXT` directly using `path.delimiter`; check explicit candidates with `fs.stat`. Workspace-local discovery is limited to `<workspace>/node_modules/.bin`. Preserve candidate argv exactly.

- [ ] **Step 3: Verify and commit**

```powershell
npx vitest run src/main/lsp/server-discovery.test.ts
npm run build:main
git add src/main/lsp/server-discovery.ts src/main/lsp/server-discovery.test.ts
git commit -m "feat: discover installed lsp servers"
```

---

### Task 4: Build the reusable JSON-RPC process client

**Files:**
- Create: `src/main/lsp/client.ts`
- Create: `src/main/lsp/client.test.ts`

**Interfaces:**
- Consumes: `ResolvedLspServer`, workspace root, AbortSignal.
- Produces: `LspClient.initialize`, `touchFile`, `request`, `getDiagnostics`, and `dispose`.

- [ ] **Step 1: Write failing fake-server protocol tests**

Use a small in-test fake child transport, not a real installed language server. Assert initialize/initialized handshake, request IDs, response correlation, server notifications, cancellation, timeout, process exit rejection, and shutdown/exit ordering.

- [ ] **Step 2: Implement with `vscode-jsonrpc/node`**

Create `StreamMessageReader`, `StreamMessageWriter`, and `createMessageConnection`. Register handlers required by common servers:

```text
workspace/configuration
client/registerCapability
window/workDoneProgress/create
textDocument/publishDiagnostics
```

Initialize with `processId`, `rootUri`, `workspaceFolders`, client capabilities, and configured initialization options. Use 45 seconds for initialization and 10 seconds for ordinary requests unless the caller supplies a lower remaining deadline.

- [ ] **Step 3: Synchronize files from disk**

`touchFile` reads the file, sends `didOpen` once and `didChange` when content changes, maintaining monotonically increasing versions. Never accept model-supplied text as authoritative file content.

- [ ] **Step 4: Verify and commit**

```powershell
npx vitest run src/main/lsp/client.test.ts
npm run build:main
git add src/main/lsp/client.ts src/main/lsp/client.test.ts
git commit -m "feat: add reusable lsp process client"
```

---

### Task 5: Manage server lifecycle per workspace

**Files:**
- Create: `src/main/lsp/manager.ts`
- Create: `src/main/lsp/manager.test.ts`

**Interfaces:**
- Produces: `LspManager.execute(query, context)`, `releaseWorkspace`, and `disposeAll`.
- Consumes: catalog, discovery, client factory, trusted workspace context.

- [ ] **Step 1: Write failing reuse, fallback, and disposal tests**

Assert one process per workspace/server/command, candidate fallback when the first command is missing, automatic eviction after process failure, release isolation, and app-shutdown disposal.

- [ ] **Step 2: Normalize operations**

Map model operations to protocol requests and normalize `Location`, `LocationLink`, hover markdown/plain text, symbols, diagnostics, and call hierarchy into JSON-safe arrays. Convert one-based input positions to zero-based exactly once.

- [ ] **Step 3: Enforce trusted containment**

Resolve and realpath the requested file. Reject paths outside the bound workspace before discovery or process start. `workspaceSymbol` requires a workspace but no file; every other operation requires an existing file.

- [ ] **Step 4: Verify and commit**

```powershell
npx vitest run src/main/lsp/manager.test.ts src/main/lsp/client.test.ts src/main/lsp/server-discovery.test.ts
npm run build:main
git add src/main/lsp/manager.ts src/main/lsp/manager.test.ts
git commit -m "feat: manage workspace lsp sessions"
```

---

### Task 6: Expose one Code-only `lsp` tool

**Files:**
- Create: `src/main/orchestrator/lsp-tool.ts`
- Create: `src/main/orchestrator/lsp-tool.test.ts`
- Modify: `src/main/orchestrator/tool-registration.ts`
- Modify: `src/main/index.ts`

**Interfaces:**
- Consumes: singleton `LspManager` and `ToolContext`.
- Produces: one `ToolDefinition` named `lsp` with Code-only mode and read-only effect.

- [ ] **Step 1: Write failing tool boundary tests**

Assert `modes: ["code"]`, `risk: "fs-read"`, `effectKind: "read"`, `verificationPolicy: "none"`, `needsContext: true`, operation enum, required file/position rules, and rejection outside Code or without a bound workspace.

- [ ] **Step 2: Implement the thin tool**

Use this argument shape:

```ts
{
  operation: LspOperation;
  filePath?: string;
  line?: number;
  character?: number;
  query?: string;
}
```

Do not expose command, server ID, workspace root, or installation flags to the model. On `LSP_SERVER_NOT_FOUND`, return the detected language, attempted command names, and install hint; do not invoke shell or package managers.

- [ ] **Step 3: Register and dispose**

Construct one manager during Main startup, inject it into `registerAllTools`, and call `disposeAll` on `before-quit`. Tests inject a fake manager.

- [ ] **Step 4: Verify and commit**

```powershell
npx vitest run src/main/orchestrator/lsp-tool.test.ts src/main/orchestrator/tool-registration.test.ts
npm run build:main
git add src/main/orchestrator/lsp-tool.ts src/main/orchestrator/lsp-tool.test.ts src/main/orchestrator/tool-registration.ts src/main/index.ts
git commit -m "feat: expose code lsp tool"
```

---

### Task 7: Add user server overrides without building an installer

**Files:**
- Modify: `src/main/settings/general-settings.ts`
- Modify: corresponding settings tests under `src/main/settings/`
- Modify: `README.md`
- Modify: `README.en.md`

**Interfaces:**
- Produces: `lspServerOverrides` persisted general setting.
- Consumes: override validation from the server catalog.

- [ ] **Step 1: Write failing settings normalization tests**

Accept a bounded array of server overrides containing ID, command, args, extensions, environment additions, and initialization options. Strip unknown keys, blank commands, duplicate IDs, and dangerous prototype keys. Preserve old settings files without migration failure.

- [ ] **Step 2: Persist configuration only**

Add the schema and load/save normalization. No graphical settings editor is required in this phase; README documents the JSON shape and location. A future UI can consume the same setting.

- [ ] **Step 3: Document ownership and installation**

README must state:

```text
Cyrene provides an LSP client only.
Language servers are installed and maintained by the user.
Cyrene never downloads or upgrades a server automatically.
When a server is missing, Cyrene reports an install hint; the user may ask Cyrene to run an existing permission-controlled installation tool.
```

Document discovery order, supported built-in definitions, custom commands, workspace-only file access, process lifetime, and troubleshooting commands such as `where pyright-langserver` / `which pyright-langserver`.

- [ ] **Step 4: Verify and commit**

```powershell
npx vitest run src/main/settings
npm run build:main
git add src/main/settings/general-settings.ts src/main/settings/*.test.ts README.md README.en.md
git commit -m "docs: configure external lsp servers"
```

---

### Task 8: Validate against real optional servers and full regression

**Files:**
- Create: `src/main/lsp/lsp-integration.test.ts`
- Modify only if required by a proven defect: `src/main/lsp/*.ts`

- [ ] **Step 1: Add opt-in real-server smoke tests**

When `CYRENE_LSP_SMOKE=1`, detect available servers and test a disposable workspace. Skip individual languages when their command is absent; default CI remains deterministic and uses fake protocol tests.

At minimum exercise any installed TypeScript and Python servers with definition, references, hover, symbols, and diagnostics.

- [ ] **Step 2: Run focused verification**

```powershell
npx vitest run src/main/lsp src/main/orchestrator/lsp-tool.test.ts
npm run build:main
```

- [ ] **Step 3: Run full verification**

```powershell
npx vitest run
npm run build:main
npm run build:preload
npm run build:renderer
```

- [ ] **Step 4: Commit smoke coverage**

```powershell
git add src/main/lsp/lsp-integration.test.ts
git commit -m "test: cover external lsp servers"
```

## Acceptance Scenarios

1. A Code workspace containing TypeScript finds a workspace-local `typescript-language-server` and returns definitions/references without reading outside the workspace.
2. A Python workspace with `pyright-langserver` on PATH returns hover and diagnostics through the same `lsp` tool.
3. A Python workspace without Pyright receives `LSP_SERVER_NOT_FOUND` plus an installation hint; Cyrene does not download anything.
4. A user-configured custom server command overrides the built-in catalog and is launched with `shell: false`.
5. Work, Learn, and Chat do not receive the `lsp` schema even if a server is installed.
6. Parent cancellation aborts the pending request without killing unrelated workspace clients; app shutdown disposes every child process.
7. A model-supplied `../other-project/file.py` path is rejected before server discovery.
8. A modified file is re-read from disk and synchronized before the semantic request.

## Definition of Done

- Cyrene provides a generic, reusable LSP client and manager.
- No language server is bundled, downloaded, upgraded, or silently installed.
- Built-in definitions cover common TypeScript/JavaScript/JSON, Python, Go, Rust, C/C++, Java, C#, PHP, Ruby, Kotlin, Lua, Vue, and YAML servers.
- Existing and custom user-installed servers are discoverable in the frozen precedence order.
- All ten semantic operations use one Code-only tool contract.
- Workspace containment, process lifecycle, request cancellation, and timeouts are tested.
- Missing-server output is actionable and truthful.
- README clearly explains responsibilities and setup.
- Focused tests, full tests, and all application builds pass.
