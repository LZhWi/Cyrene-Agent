# Memory Store Refactor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn `memory-store.ts` into a compatibility facade over focused migration, IO, L2, conflict, and DMAE modules without changing observable behavior.

**Architecture:** `MemoryStoreManager` remains the only cache owner and the only public singleton. Extracted operation modules mutate an explicitly supplied `MemoryStore` and return `MemoryMutation<T>` values; the facade preserves the existing `load → transform → save → trace/notify` order through one private application method. File IO remains synchronous internally, matching the current implementation.

**Tech Stack:** TypeScript, Electron main process, Node.js `fs`/`path`, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-30-god-file-refactor-design.md`

## Global Constraints

- Preserve every public export, method signature, singleton identity, storage path, JSON shape, migration default, trace event, and save/notification order.
- Do not change sync IO to async IO or add dependencies.
- `memory-store.ts` must remain the import path used by existing callers.
- Extracted modules must not import `memory-store.ts`; dependencies flow from the facade to leaf modules only.
- Characterization tests lock current behavior before extraction; facade tests remain green throughout.
- Each task ends with targeted tests and `npm run build:main`; the phase ends with the full `npm test` suite.

## File Map

- Create `src/main/memory/memory-store-operation.ts`: shared `L2Input` and `MemoryMutation<T>` contracts.
- Create `src/main/memory/memory-store-defaults.ts`: defaults, cloning, keyword and snippet helpers.
- Create `src/main/memory/memory-store-migrations.ts`: schema repair only.
- Create `src/main/memory/memory-store-io.ts`: path, backup, read and write primitives.
- Create `src/main/memory/memory-l2-operations.ts`: L2/evidence mutations.
- Create `src/main/memory/memory-conflict-operations.ts`: conflict queue and resolution mutations.
- Create `src/main/memory/memory-dmae-operations.ts`: L2 activation-state mutations.
- Modify `src/main/memory/memory-store.ts`: retain cache, public methods, save notification and compatibility exports.
- Modify `src/main/memory/memory-store.test.ts`: add save/notify order characterization.
- Add focused tests beside each extracted module.

---

### Task 1: Lock the Memory Mutation Call Trace

**Files:**
- Modify: `src/main/memory/memory-store.test.ts`

**Interfaces:**
- Consumes: existing `memoryStore.load`, `memoryStore.save`, and `memoryStore.upsertL0Field`.
- Produces: a characterization test proving mutated data reaches `save` before `notifyMemoryChanged`.

- [ ] **Step 1: Hoist and install an Obsidian exporter mock**

Add alongside the Electron mock:

```ts
const obsidianExporterMock = vi.hoisted(() => ({
  notifyMemoryChanged: vi.fn(),
}))

vi.mock("./obsidian-exporter", () => ({
  notifyMemoryChanged: obsidianExporterMock.notifyMemoryChanged,
}))
```

Reset it in `beforeEach` with `obsidianExporterMock.notifyMemoryChanged.mockReset()`.

- [ ] **Step 2: Add the call-trace characterization test**

```ts
it("saves the transformed store before notifying Obsidian", async () => {
  const { memoryStore } = await import("./memory-store")
  await memoryStore.load()
  await vi.waitFor(() => expect(obsidianExporterMock.notifyMemoryChanged).toHaveBeenCalled())
  obsidianExporterMock.notifyMemoryChanged.mockClear()

  const trace: string[] = []
  const originalLoad = memoryStore.load.bind(memoryStore)
  const originalSave = memoryStore.save.bind(memoryStore)
  vi.spyOn(memoryStore, "load").mockImplementation(async () => {
    trace.push("load")
    return originalLoad()
  })
  vi.spyOn(memoryStore, "save").mockImplementation(async (store) => {
    trace.push(`save:${store.l0.preferredName}`)
    await originalSave(store)
  })
  obsidianExporterMock.notifyMemoryChanged.mockImplementation(() => {
    trace.push("notify")
  })

  await memoryStore.upsertL0Field("preferredName", "伙伴")
  await vi.waitFor(() => expect(trace).toContain("notify"))

  expect(trace).toEqual(["load", "save:伙伴", "notify"])
})
```

- [ ] **Step 3: Run the existing memory facade tests**

Run:

```powershell
npx vitest run src/main/memory/memory-store.test.ts src/main/memory/memory-store-dmae.test.ts
```

Expected: both files pass; this establishes the pre-extraction baseline.

- [ ] **Step 4: Commit the characterization test**

```powershell
git add src/main/memory/memory-store.test.ts
git commit -m "test(memory): lock store save notification order"
```

---

### Task 2: Extract Defaults, Migration, and File IO

**Files:**
- Create: `src/main/memory/memory-store-defaults.ts`
- Create: `src/main/memory/memory-store-migrations.ts`
- Create: `src/main/memory/memory-store-io.ts`
- Create: `src/main/memory/memory-store-migrations.test.ts`
- Create: `src/main/memory/memory-store-io.test.ts`
- Modify: `src/main/memory/memory-store.ts`

**Interfaces:**
- Produces:

```ts
export const CURRENT_MEMORY_SCHEMA_VERSION = 2
export function createDefaultMemoryStore(): MemoryStore
export function extractMemoryKeywords(input: string, max?: number): string[]
export function boundMemorySnippet(text: string | undefined, maxLength: number): string | undefined
export function repairMigrations(store: Partial<MemoryStore>): MemoryStore
export function resolveMemoryPath(): string | null
export function backupMemoryFile(filePath: string): void
export function readMemoryFile(filePath: string): Partial<MemoryStore>
export function writeMemoryFile(filePath: string, store: MemoryStore): void
```

- [ ] **Step 1: Add focused migration tests before moving code**

Create `memory-store-migrations.test.ts` with a legacy store containing an L2 item without `keywords`, `syncStatus`, `evidenceIds`, or DMAE state. Assert:

```ts
const repaired = repairMigrations(legacy)
expect(repaired.schemaVersion).toBe(2)
expect(repaired.l2[0].syncStatus).toBe("synced")
expect(repaired.l2[0].evidenceIds).toEqual([])
expect(repaired.l2[0].keywords.length).toBeGreaterThan(0)
expect(repaired.l2DmaeStates).toEqual([expect.objectContaining({
  l2Id: "l2_legacy",
  state: "archived",
})])
```

Run `npx vitest run src/main/memory/memory-store-migrations.test.ts` and expect module-not-found failure.

- [ ] **Step 2: Extract default and migration functions verbatim**

Move the current default L0/L1/store construction and keyword/snippet helpers into `memory-store-defaults.ts`. Move `repairMigrations` into `memory-store-migrations.ts`, import the defaults/helpers there, and re-export `repairMigrations` from `memory-store.ts`.

The migration must continue to set:

```ts
syncStatus: memory.syncStatus ?? (memory.ragId ? "synced" : "pending_sync")
evidenceIds: Array.isArray(memory.evidenceIds) ? memory.evidenceIds : []
resolverAttemptCount: typeof log.resolverAttemptCount === "number" ? log.resolverAttemptCount : 0
state: "archived"
```

- [ ] **Step 3: Add IO tests before moving IO**

In `memory-store-io.test.ts`, mock Electron `app.getPath`, write a store with `writeMemoryFile`, read it with `readMemoryFile`, call `backupMemoryFile`, and assert one `memory.backup.*.json` file exists. Run the test and expect module-not-found failure.

- [ ] **Step 4: Extract synchronous IO primitives**

Implement `memory-store-io.ts` using the same synchronous calls currently used by the facade:

```ts
export function readMemoryFile(filePath: string): Partial<MemoryStore> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Partial<MemoryStore>
}

export function writeMemoryFile(filePath: string, store: MemoryStore): void {
  const dir = path.dirname(filePath)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(filePath, JSON.stringify(store, null, 2), "utf8")
}
```

Keep the current timestamped backup filename and `resolveMemoryPath` try/catch behavior unchanged.

- [ ] **Step 5: Rewire only `load` and `save`**

Replace direct `fs/path/app` use in `memory-store.ts` with the new functions. Keep migration trace calls and this exact save tail in the facade:

```ts
writeMemoryFile(filePath, store)
this.cache = store
if (isImportingMemory()) return
import("./obsidian-exporter")
  .then(({ notifyMemoryChanged }) => notifyMemoryChanged())
  .catch(() => {})
```

- [ ] **Step 6: Verify and commit**

Run:

```powershell
npx vitest run src/main/memory/memory-store-migrations.test.ts src/main/memory/memory-store-io.test.ts src/main/memory/memory-store.test.ts src/main/memory/memory-store-dmae.test.ts
npm run build:main
```

Commit:

```powershell
git add src/main/memory
git commit -m "refactor(memory): extract store defaults migrations and io"
```

---

### Task 3: Extract L2 and Evidence Mutations

**Files:**
- Create: `src/main/memory/memory-store-operation.ts`
- Create: `src/main/memory/memory-l2-operations.ts`
- Create: `src/main/memory/memory-l2-operations.test.ts`
- Modify: `src/main/memory/memory-store.ts`

**Interfaces:**
- Produces:

```ts
export interface MemoryMutation<T> {
  value: T
  persist: boolean
  traces: MemoryTraceEvent[]
}

export type L2Input = Omit<
  L2Memory,
  "id" | "createdAt" | "lastAccessedAt" | "accessCount" | "weight" | "status" | "keywords"
>

export function addL2MemoryToStore(store: MemoryStore, input: L2Input): MemoryMutation<L2Memory>
export function updateL2RecallStatsInStore(store: MemoryStore, id: string, delta?: number): MemoryMutation<void>
export function pinL2InStore(store: MemoryStore, id: string, pinned: boolean): MemoryMutation<void>
export function deleteL2FromStore(store: MemoryStore, id: string): MemoryMutation<void>
export function markL2SyncStatusInStore(store: MemoryStore, id: string, status: L2SyncStatus, ragId?: string, error?: unknown): MemoryMutation<L2Memory | null>
export function markL2ConflictInStore(store: MemoryStore, id: string, conflictRagId: string): MemoryMutation<L2Memory | null>
export function updateL2ContentInStore(store: MemoryStore, id: string, content: string): MemoryMutation<L2Memory | null>
export function updateL2StatusInStore(store: MemoryStore, ids: string[], status: L2Memory["status"]): MemoryMutation<void>
export function decayL2WeightsInStore(store: MemoryStore, delta?: number): MemoryMutation<number>
export function addL2BatchToStore(store: MemoryStore, inputs: L2Input[]): MemoryMutation<L2Memory[]>
```

- [ ] **Step 1: Add pure-operation characterization tests**

Cover at least these invariants in `memory-l2-operations.test.ts`:

```ts
expect(addL2MemoryToStore(store, input).value).toMatchObject({
  status: "active",
  weight: 0,
  accessCount: 0,
})
expect(store.evidence).toHaveLength(1)
expect(store.l2DmaeStates).toEqual([expect.objectContaining({ state: "archived" })])

const skipped = updateL2RecallStatsInStore(store, terminalId, 50)
expect(skipped.persist).toBe(false)
expect(skipped.traces[0]).toMatchObject({ status: "skip" })

const decayed = decayL2WeightsInStore(store, 1)
expect(decayed.value).toBe(1)
expect(decayed.persist).toBe(true)
```

Run the test and expect module-not-found failure.

- [ ] **Step 2: Move L2 transformations into the leaf module**

Move the existing mutation bodies without altering conditions, time/ID construction, status thresholds, trace payloads, or array mutation order. Each function returns `persist: true` only where the current method calls `save`; missing/no-op paths return `persist: false`.

Move the existing `L2Input` alias into `memory-store-operation.ts` and explicitly re-export it from `memory-store.ts`; leaf modules import it from `memory-store-operation.ts`, never from the facade.

- [ ] **Step 3: Add one facade application seam**

Add this private method to `MemoryStoreManager`:

```ts
private async applyMutation<T>(
  mutate: (store: MemoryStore) => MemoryMutation<T>,
): Promise<T> {
  const store = await this.load()
  const result = mutate(store)
  if (result.persist) await this.save(store)
  for (const trace of result.traces) appendMemoryTrace(trace)
  return result.value
}
```

Delegate the public L2 mutation methods to it. Keep aliases such as `addL2` and `updateL2Weight` in the facade.

- [ ] **Step 4: Verify and commit**

Run:

```powershell
npx vitest run src/main/memory/memory-l2-operations.test.ts src/main/memory/memory-store.test.ts src/main/memory/memory-store-dmae.test.ts
npm run build:main
```

Commit:

```powershell
git add src/main/memory
git commit -m "refactor(memory): extract l2 store operations"
```

---

### Task 4: Extract Conflict Queue and Resolution Operations

**Files:**
- Create: `src/main/memory/memory-conflict-operations.ts`
- Create: `src/main/memory/memory-conflict-operations.test.ts`
- Modify: `src/main/memory/memory-store.ts`

**Interfaces:**
- Consumes: `MemoryMutation<T>` and `extractMemoryKeywords`.
- Produces:

```ts
export function appendConflictLogToStore(store: MemoryStore, input: Omit<ConflictLog, "id" | "createdAt">): MemoryMutation<ConflictLog>
export function scoreConflictLogInStore(store: MemoryStore, id: string, score: Pick<ConflictLog, "conflictScore" | "resolverPriority" | "scoringSignals">): MemoryMutation<ConflictLog | null>
export function getResolverQueueFromStore(store: MemoryStore, limit?: number): ConflictLog[]
export function applyResolverResolutionToStore(store: MemoryStore, conflictLogId: string, resolution: MemoryConflictResolution): MemoryMutation<ConflictLog | null>
```

- [ ] **Step 1: Add focused conflict-operation tests**

Use fixed in-memory L2 and conflict objects. Assert high-priority queue ordering, `none` not queued, preference evolution creates one resolved L2, direct conflict creates none, and returned trace payloads retain `conflict.score`, `resolver.queue.add`, and `resolver.resolution.apply`.

Run `npx vitest run src/main/memory/memory-conflict-operations.test.ts` and expect module-not-found failure.

- [ ] **Step 2: Move conflict transformations verbatim**

Keep `RESOLVER_PRIORITY_RANK` private to the conflict module. Preserve the 100-log cap, queued timestamp fallback, source/target orientation, status mapping, evidence ID concatenation, and trace payloads.

- [ ] **Step 3: Delegate facade methods through `applyMutation`**

`appendConflictLog`, `scoreConflictLog`, and `applyResolverResolution` call `applyMutation`; `getResolverQueue` loads once and calls the pure query. `getConflictLogs` remains a facade read.

- [ ] **Step 4: Verify and commit**

Run:

```powershell
npx vitest run src/main/memory/memory-conflict-operations.test.ts src/main/memory/memory-store.test.ts
npm run build:main
```

Commit:

```powershell
git add src/main/memory
git commit -m "refactor(memory): extract conflict operations"
```

---

### Task 5: Extract DMAE Operations and Finalize the Facade

**Files:**
- Create: `src/main/memory/memory-dmae-operations.ts`
- Create: `src/main/memory/memory-dmae-operations.test.ts`
- Modify: `src/main/memory/memory-store.ts`

**Interfaces:**
- Produces:

```ts
export function getL2DmaeStateFromStore(store: MemoryStore, l2Id: string): L2DmaeState | undefined
export function updateL2DmaeStateInStore(store: MemoryStore, l2Id: string, patch: Partial<L2DmaeState>): MemoryMutation<L2DmaeState | undefined>
export function initL2DmaeStateInStore(store: MemoryStore, l2Id: string): MemoryMutation<L2DmaeState>
```

- [ ] **Step 1: Add focused DMAE-operation tests**

Assert missing updates return `persist: false`, merged updates cannot change `l2Id`, and initialization produces exactly:

```ts
{
  l2Id,
  activation: 0,
  intrinsicValue: 0,
  userSilence: 0,
  modelSilence: 0,
  recentUserHits: [],
  state: "archived",
}
```

Run `npx vitest run src/main/memory/memory-dmae-operations.test.ts` and expect module-not-found failure.

- [ ] **Step 2: Move DMAE transformations and delegate facade methods**

Keep `initL2DmaeStateIfMissing` behavior: check the existing state first, return without saving when found, otherwise load and apply the initialization mutation.

- [ ] **Step 3: Slim and audit the compatibility facade**

Confirm `memory-store.ts` contains only:

- public type aliases and compatibility re-exports;
- `MemoryStoreManager` cache, `load`, `save`, `applyMutation`, profile/reflection reads and writes;
- thin delegates for L2, conflict, and DMAE APIs;
- `export const memoryStore = new MemoryStoreManager()`.

Run:

```powershell
rg -n "from \"\.\/memory-store\"" src/main/memory/memory-store-*.ts src/main/memory/memory-*-operations.ts
```

Expected: no output, proving leaf modules do not import the facade.

- [ ] **Step 4: Run phase verification**

Run:

```powershell
npx vitest run src/main/memory/memory-store.test.ts src/main/memory/memory-store-dmae.test.ts src/main/memory/memory-store-migrations.test.ts src/main/memory/memory-store-io.test.ts src/main/memory/memory-l2-operations.test.ts src/main/memory/memory-conflict-operations.test.ts src/main/memory/memory-dmae-operations.test.ts
npm run build:main
npm test
git diff --check
```

Expected: all commands exit 0; `memory-store.ts` public imports remain valid and the full suite has zero failures.

- [ ] **Step 5: Commit the completed phase**

```powershell
git add src/main/memory
git commit -m "refactor(memory): complete memory store facade"
```
