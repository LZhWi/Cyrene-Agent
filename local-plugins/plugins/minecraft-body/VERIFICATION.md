# Panel initialization fix 0.4.1 verification (2026-10-21)

Base: published experimental commit `77c3f555b1b44b3cdc4656937af6684b9c861edf`. Only plugin static UI, manifest, documentation and tests changed. No host source, gameplay runtime, user computer, world, credentials or official branch changed.

Package: `downloads/minecraft-body-0.4.1-panel-fix.zip` (9,722,559 bytes). SHA-256: `f4b6acb3ef5655ff935c7bbbea9b2c4bdf0db421979256dfa2697a16fee472d9`。

## Final verification

- `node --test local-plugins/plugins/minecraft-body/tests/settings-panel.test.cjs`: 10 passed. Pre-init silence, init timeout, foreign messages, lost first reply, bounded pending cleanup, late reply rejection, single poll, malformed/partial status fail-closed, pagehide/pageshow, mutation timeout without replay, and uncertainty retained over bfcache restoration.
- `node --test local-plugins/plugins/minecraft-body/tests/settings-host.test.cjs`: 1 passed. JSDOM executes actual host `plugin-panels.ts`, actual `parsePanelMessage`, and official `panel-bridge.js` with the changed UI, using explicit postMessage source/origin delivery. First load waits for actual host registration/init and succeeds. Removed/replaced iframe under the SAME host exposes host stale-registry reply routing; the plugin times out and disables execution instead of staying silently blank. This does not claim to repair that separate host defect.
- SDK build, targeted TypeScript check: passed after restoring declared SDK npm dependencies (initial fresh-checkout attempt lacked ajv).
- Targeted Vitest: 4 files, 32 passed.
- Runtime Node tests: 64 passed, using unchanged pinned dependencies recovered from the verified prior ZIP.
- Dedicated build/isolation and server-harness guard tests: 12 passed.
- Dedicated plugin build and isolated ZIP smoke: passed; 27 Java datasets load, sidecar stops, no server connection/model/conversation services used.
- `node --check` and `git diff --check`: passed.

Total: 119 tests passed across these suites. No full-repository test run, real Electron-host GUI run, or new live Minecraft run for this patch. The older real-server evidence below is historical, not a new 0.4.1 validation. The final ZIP changes exactly README.md, manifest.json, settings.html and settings.js versus the prior published ZIP; bundled index.cjs and all runtime/dependency bytes are unchanged.

The plugin uses a bounded request table on the existing cyrene-panel/1 protocol, with parent source and init-origin validation, negative random per-document IDs separate from official bridge positive IDs, and no automatic mutation retries. Read timeouts delete pending entries and retry only reads. UI unknown-state guards are not a substitute for backend action/lease validation. A failed/unknown operation conservatively blocks further non-stop operations until explicit disconnect succeeds; closing a page never reverses actions already performed.

Known host limitation: same-window iframe remounts can route responses to an old registered frame. This patch makes that visible and safe but cannot fix the host map without host changes. Completely close/recreate the settings window or application rather than repeatedly remounting the same iframe. Connection fields remain intentionally nonpersistent and are explicitly labeled as next-connect inputs.

---

# Task Controller V1 verification (2026-10-20)

Base: `d475a3bacf7165246dc30fa3fe28cf4e40388828` on `codex/life-conversation-updates`.
Work branch: `codex/minecraft-task-v1`. No host application source, formal branch, user computer, or existing user world was changed. Live checks used an explicitly authorized disposable loopback server/world.

## Passed

Commands below run from `local-plugins/`, unless stated otherwise.

- `node ../scripts/plugin-sdk/build-sdk.mjs`: built local SDK from existing source.
- `node_modules/.bin/tsc --noEmit -p plugins/minecraft-body/tsconfig.json`: passed.
- `node_modules/.bin/vitest run plugins/minecraft-body --config vitest.config.mjs`: 4 files, 32 tests passed.
- `node --test plugins/minecraft-body/runtime/*.test.cjs plugins/minecraft-body/runtime/legacy/*.test.cjs`: 64 tests passed. Includes real installed minecraft-data 1.21.11 recipe normalization (38 supported variants, 5766 bytes), separate from the real-server checks below.
- `node --test scripts/build.test.mjs`: 5 build-isolation tests passed.
- `node --test scripts/minecraft-task-test-cleanup.test.cjs scripts/minecraft-task-test-guards.test.cjs`: 7 harness cleanup/configuration guard tests passed.
- `node scripts/build-minecraft-body.mjs`: dedicated build passed, no shared plugin build invoked.
- `node scripts/test-minecraft-body-package.mjs`: ZIP isolated dependency load and sidecar stop passed; 27 Java protocol datasets load, no conversation services used.
- Repository root `git diff --check`: passed.

Coverage includes recipe yields/leftovers, missing inputs, partial inventory, shared materials, unknown recipes, budgets, exact-target pickup, region containment, lease/manual conflict, deferred draining, stale cancel callback identity, disconnect/restart, gifts vs skill claims, actual equip verification, uncertainty acknowledgement and fresh quiescence, and bounded sanitized journals.

## Live Vanilla 1.21.11 checks

`node scripts/test-minecraft-task-server.cjs --server-dir <disposable-server-dir> --allow-reset-fixtures`

The preserved harness requires pre-existing, user-accepted `eula=true`, official `server.jar`, Java21+, `server-ip=127.0.0.1`, `server-port=25575`, `online-mode=false`, and `level-name=isolated-test-world`. It pins the official server JAR hash, rejects ambiguous/duplicate Java property keys and a symlink world directory. It never downloads software, accepts legal terms, installs the plugin, or changes bind/authentication settings. The explicit flag authorizes destructive fixture resets in this disposable world. It builds a temporary export of current source; ZIP dependency isolation is tested separately. Dependencies are the pinned plugin runtime plus existing local esbuild development dependency.

Official Mojang1.21.11 server JAR SHA-1: `64bb6d763bed0a9f1d632ec347938594144943ed`; Java OpenJDK21.0.12.1. Controlled superflat fixture: grass platform y64, empty bot inventory at (0.5,65,0.5), four oak logs, no initial crafting table; region x/z -8..8, y64..72. Three consecutive cycles completed, each 14 actions, observed inventory wooden_pickaxe=1 and heldItem=wooden_pickaxe. Collect/place opt-out blocked at zero actions. Active cancellation stopped at one action, latched effectsUncertain, and prevented automatic continuation/new goals; acknowledgement required quiescence. Outside-region acquisition was rejected.

The preserved repository harness was then independently executed against the same disposable server directory (11:25–11:26 UTC): all three cycles and safety assertions passed again, exit code0, and server shutdown completed. Six successful final-source full cycles were observed across the two runs. After that run, harness-only cleanup and configuration parsing were hardened: independent cleanup attempts, EPIPE/failed-spawn handling, confirmed SIGTERM/SIGKILL escalation, canonical duplicate-free properties, JAR pinning and world-symlink rejection. Seven dedicated fake-process/parser tests passed, and the real authorized fixture passed the new guards without another server launch. These harness-only changes do not alter the tested plugin or packaged ZIP.

Sanitized per-case evidence: `tests/live/2026-10-20-summary.json` (11:23–11:24 UTC run). The original test found a stale heartbeat/cache defect; the next run found a GoalNear integer-cell/actual-distance boundary defect. Both were repaired before the three-cycle passing run; regression tests cover immediate slot reuse, same-action late heartbeat, older-query/newer-action fencing, out-of-order observations, disconnect invalidation, and conservative navigation with actual reach checks retained.

Tested source SHA-256:
- manager.ts: `f8686de7200cebc5881b59613e05cfcca2a128885d98bf039c9a24b0d3dddd55`
- body.cjs: `865ce80bc926b0e5b38b237b89c0153e1cb76147ee1c1b8f0ed2cc62b9323185`

## Artifact

`local-plugins/artifacts/minecraft-body.zip`, manifest0.4.0 preview: 1918 files, 109055568 unpacked bytes, 9720092 ZIP bytes.
ZIP SHA-256: `12ee90dc4afd9b0fc55ee03e8953f7aa8f19cad6eebf0dc2affa18f02c4ae674`.
Bundled index.cjs SHA-256: `3ce3fb059758e0251997aa319c38dab3ab578285e1d04fe52e3489f0f2c52895`.
Built from final repaired source plus updated README. Verification document, test harness and test evidence are repository-only files, not bundled runtime contents.

## Broader checks attempted, not green

`npm run typecheck`: fails in unchanged `real-history-ab` / `real-image-ab` tests because sibling `../../../Cyrene-Agent/src/main/rag/{vectorstore,retriever}` is absent, with resulting implicit-any errors.

`npm test`: 106 files / 996 tests passed; 8 files failed, 9 individual tests failed; 6 files / 17 tests skipped. This broad run preceded the live-test fixes and additional regressions; it was not represented as a whole-application green result. Unrelated failures are absent sibling RAG imports, unavailable Electron binary (dependencies prepared with `--ignore-scripts`), Windows-only Dungeons input tests, a hardcoded `E:\Philia093 demo` isolation fixture, and life-planning/relationship date-time fixtures. These failing source files are unmodified and outside this task; the failures were not independently reproduced on a clean baseline, so they are not claimed to be proven pre-existing. Build regression tests were run separately because npm's `&&` chain stopped after Vitest.

## Not run / limitations

No new Electron-host UI, Microsoft login, modded/custom-recipe server, random-terrain long-duration survival, or manual gameplay validation. Prior README 0.3.0 real-server results remain historical; only the explicitly described V1 controlled live fixtures were rerun. Use a disposable Vanilla test world and explicitly bounded region before considering real use. Unknown permissions/custom server behavior can block safely. Task background execution continues after ordinary chat generation is stopped; cancel_task/panel stop/disconnect are its explicit controls.

Dependency preparation used official npm packages with lifecycle scripts disabled, writable temporary caches, and restored tracked lockfiles; no dependency version or manifest additions were made. No external Craft source was copied.
