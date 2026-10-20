# Task Controller V1 verification (2026-10-20)

Base: `d475a3bacf7165246dc30fa3fe28cf4e40388828` on `codex/life-conversation-updates`.
Work branch: `codex/minecraft-task-v1`. No host application source, formal branch, user computer, server, or world was changed by these checks.

## Passed

Commands below run from `local-plugins/`, unless stated otherwise.

- `node ../scripts/plugin-sdk/build-sdk.mjs`: built local SDK from existing source.
- `node_modules/.bin/tsc --noEmit -p plugins/minecraft-body/tsconfig.json`: passed.
- `node_modules/.bin/vitest run plugins/minecraft-body --config vitest.config.mjs`: 4 files, 28 tests passed.
- `node --test plugins/minecraft-body/runtime/*.test.cjs plugins/minecraft-body/runtime/legacy/*.test.cjs`: 62 tests passed. Includes real installed minecraft-data 1.21.11 recipe normalization (38 supported variants, 5766 bytes), not a live Minecraft server.
- `node --test scripts/build.test.mjs`: 5 build-isolation tests passed.
- `node scripts/build-minecraft-body.mjs`: dedicated build passed, no shared plugin build invoked.
- `node scripts/test-minecraft-body-package.mjs`: ZIP isolated dependency load and sidecar stop passed; 27 Java protocol datasets load, no conversation services used.
- Repository root `git diff --check`: passed.

Coverage includes recipe yields/leftovers, missing inputs, partial inventory, shared materials, unknown recipes, budgets, exact-target pickup, region containment, lease/manual conflict, deferred draining, stale cancel callback identity, disconnect/restart, gifts vs skill claims, actual equip verification, uncertainty acknowledgement and fresh quiescence, and bounded sanitized journals.

## Artifact

`local-plugins/artifacts/minecraft-body.zip`, manifest version `0.4.0` (preview).
1918 files; 109052231 unpacked bytes; 9718879 ZIP bytes.
SHA-256: `124d451237b93a8d6d3515e1e6132f65ed68d686b5881c1a8bc9707ab18cf777`.
Bundled `index.cjs` SHA-256: `ec719555b05f1ff26e82cd9051d6a351a37a438f3d8b7fc9d486190a9a85081a`; inspected bundle contains the `cancellingTask` identity guard.
Built after final runtime/controller fixes including old-callback identity guarding. Only a later test-only addition and this verification document followed that build; neither is packaged by the dedicated builder.

## Broader checks attempted, not green

`npm run typecheck`: fails in unchanged `real-history-ab` / `real-image-ab` tests because sibling `../../../Cyrene-Agent/src/main/rag/{vectorstore,retriever}` is absent, with resulting implicit-any errors.

`npm test`: 106 files / 996 tests passed; 8 files failed, 9 individual tests failed; 6 files / 17 tests skipped. This broad run preceded the final additional callback regression test. Unrelated failures are absent sibling RAG imports, unavailable Electron binary (dependencies prepared with `--ignore-scripts`), Windows-only Dungeons input tests, a hardcoded `E:\Philia093 demo` isolation fixture, and life-planning/relationship date-time fixtures. These failing source files are unmodified and outside this task; the failures were not independently reproduced on a clean baseline, so they are not claimed to be proven pre-existing. Build regression tests were run separately because npm's `&&` chain stopped after Vitest.

## Not run / limitations

No new real-server, Electron-host UI, Microsoft login, modded/custom-recipe server, or manual gameplay validation. Prior README 0.3.0 real-server results are historical, not V1 verification. Build and fake-bot success do not prove live world success. Use a disposable Vanilla test world and explicitly bounded region before considering real use. Unknown permissions/custom server behavior can block safely. Task background execution continues after ordinary chat generation is stopped; cancel_task/panel stop/disconnect are its explicit controls.

Dependency preparation used official npm packages with lifecycle scripts disabled, writable temporary caches, and restored tracked lockfiles; no dependency version or manifest additions were made. No external Craft source was copied.
