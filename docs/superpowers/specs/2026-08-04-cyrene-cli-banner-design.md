# Cyrene CLI Welcome Banner — Design

**Date:** 2026-08-04
**Status:** Draft, awaiting user review
**Target release:** `live2d-cyrene` v0.9.x
**Scope:** Add a `cyrene` command-line entry point to the `live2d-cyrene` repository. The CLI ships with an ASCII welcome banner and a small set of v0.9 subcommands. It does NOT replace the Electron desktop entry; it runs alongside it.

---

## 1. Background and Goals

The repository `live2d-cyrene` (a.k.a. `Cyrene-Agent`, published as `cyrene-agent` on npm) currently exposes the project only through `npm start` (which runs Electron) and a long list of `npm run …` scripts. There is no unified command that represents "Cyrene" to a person who has just cloned the repo or installed the package globally.

This design adds that entry point. `cyrene` becomes a single command that:

1. Greets first-time users with a small, branded ASCII banner (one time only).
2. Stays quiet on every subsequent default invocation.
3. Lets the user summon the full banner at will via `cyrene hello`.
4. Forwards to Electron when the user wants the desktop app.
5. Reserves a stable subcommand surface for v1.x features (`chat`, `work`, `learn`, `doctor`, `init`, `update`, etc.).

The "first-meeting" banner is the *only* user-visible piece of this design; everything else is scaffolding so that the welcome experience is sustainable for years.

### 1.1 In scope (v0.9)

- A new `cyrene` binary exposed via npm `bin` and `npm link`.
- A built-in `src/cli/` tree compiled to `dist/cli/index.js` (CommonJS, shebang `#!/usr/bin/env node`).
- The following subcommands, all routed through one entry file:
  - `cyrene` (default; behaviour depends on `~/.cyrene/state.json`)
  - `cyrene hello`
  - `cyrene about`
  - `cyrene version` (also accepted as `cyrene --version` / `cyrene -v`)
  - `cyrene --help` / `cyrene -h`
  - `cyrene run` (dev-only in v0.9; see §3.7)
  - `cyrene doctor` (placeholder)
  - `cyrene init` (placeholder)
  - `cyrene update` (placeholder; registered for namespace stability)
- A `state.json` file at `~/.cyrene/state.json` controlling the default-invocation behaviour.
- A hand-rolled ASCII banner with NO color and NO third-party "fancy print" library.
- Unit tests for the state module, banner renderer, and argv router.
- An integration test that drives the built `dist/cli/index.js` with a temporary `HOME`.
- `package.json`, `tsconfig.cli.json`, and a `build:cli` script updated to include the new code.
- A `docs/` note in `README.md` (and `README.en.md`) showing the new command.

### 1.2 Out of scope (v0.9)

- Any ANSI color, RGB color, truecolor escape codes, or "fancy box" library (no `chalk`, no `picocolors`, no `kleur`, no `boxen`, no `ora`).
- Random quotes, in-character variants, per-launch variations of any kind. The banner is bit-for-bit deterministic.
- Reading or writing any user configuration file (no `~/.cyrene/config.json` in v0.9). A `bannerQuote` field is reserved in code only.
- A packaged `cyrene.exe` written to `PATH` by the Windows installer. (That is part of the v1.x release pipeline and is mentioned here only as a forward reference.)
- Telemetry, update checks, "what's new" prompts, splash screens, GUI animations, or any UI changes in the Electron renderer.
- A `cyrene update` command implementation. (Registered as a placeholder only.)
- A `cyrene info` command. v1.x will print a structured environment snapshot (Node version, platform, workspace path, configured model count, etc.) and feed into `cyrene doctor`. The name is reserved.
- A `cyrene desktop` (or `cyrene open`) command. v1.x will launch the installed Electron app from `resources/app`, independent of cwd. v0.9's `cyrene run` is a dev-only shortcut; the production entry point will be `cyrene desktop`.
- Auto-execution on `git clone`, `git pull`, `npm install`, or any other lifecycle hook.

---

## 2. User Experience

### 2.1 First-time `cyrene`

A user who just ran `npm i -g cyrene-agent` (or `npm link` inside a clone) types `cyrene` in any directory. They see:

```
██████╗██╗   ██╗██████╗ ███████╗███╗   ██╗███████╗
██╔════╝╚██╗ ██╔╝██╔══██╗██╔════╝████╗  ██║██╔════╝
██║      ╚████╔╝ ██████╔╝█████╗  ██╔██╗ ██║█████╗
██║       ╚██╔╝  ██╔══██╗██╔══╝  ██║╚██╗██║██╔══╝
╚██████╗   ██║   ██║  ██║███████╗██║ ╚████║███████╗
 ╚═════╝   ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═══╝╚══════╝

╭──────────────────────────────────────────────────────────────╮
│                     ♡ Cyrene Agent ♡                         │
│               Your Desktop AI Companion                      │
│             "Every memory has a place."                      │
╰──────────────────────────────────────────────────────────────╯

Thank you for bringing me home.
```

Then `cyrene` exits with code 0. No further output, no menu, no prompt. The user is left at the shell prompt free to type the next command.

Behind the scenes, the CLI writes `~/.cyrene/state.json` containing at least:

```json
{
  "firstLaunch": {
    "firstSeenAt": "<ISO8601 UTC>",
    "version": "0.9.0"
  }
}
```

The `state.json` shape is intentionally a JSON object (not a bare record) so v1.x can add sibling fields (`lastSeenAt`, `lastVersion`, `sessionId`, etc.) without renaming the file. The CLI in v0.9 reads **only** the `firstLaunch` field; any other keys are ignored.

If the write fails (permission denied, disk full), the CLI prints a one-line warning to stderr and still exits 0. The banner must never be the reason a CLI invocation fails.

### 2.2 Subsequent `cyrene`

The same user, the next day, in the same shell:

```
$ cyrene
Cyrene Agent v0.9.0
Ready.
```

Two lines. No logo. No framing. Exits 0. The user can immediately type the next command.

### 2.3 `cyrene hello`

Any user, any time:

```
$ cyrene hello
<full banner, identical to 2.1>
```

This is the "easter egg" path. It never consults `~/.cyrene/state.json` and never writes anything.

### 2.4 `cyrene about`

```
$ cyrene about
<full banner>

GitHub:   https://github.com/Playa-0v0/Cyrene-Agent
License:  MIT (see MODEL_LICENSE.md for model terms)
```

### 2.4a `cyrene --version` / `cyrene -v`

These flags are accepted anywhere in the argv list and are equivalent to `cyrene version`. They are documented in `cyrene --help` as a separate row. The bare word `version` is kept as a subcommand for symmetry with `hello` / `about` / `run`.

The version line is intentionally **not** part of the welcome banner. The banner is a brand artifact; the version is a tool attribute. Mixing them in the same text would force every release to ship a banner change.

### 2.5 `cyrene --help`

```
Usage: cyrene [command] [options]

Commands:
  hello     Print the welcome banner
  about     Print banner plus project metadata
  version   Print version only
  run       Launch the Electron desktop app [dev only]
  doctor    Diagnose the local environment (planned)
  init      Initialize a workspace (planned)
  update    Self-update (planned)
  help      Show this help

Flags:
  -v, --version   Print version and exit
  -h, --help      Show this help

Run `cyrene` with no arguments for the first-time greeting.
```

### 2.6 `cyrene run` (dev-only in v0.9)

No banner. Spawns `electron .` in the current working directory with `stdio: 'inherit'`, then waits. Exit code mirrors the Electron process. The user sees the same thing they would have seen with `npm start`, but the entry point is `cyrene`.

**v0.9 scope:** `cyrene run` is intended for contributors and clone-and-hack users. It assumes the user is at a project root that contains a `package.json` with a runnable Electron entry. This is documented in `cyrene --help` as `[dev only]`.

**v1.x scope:** A new `cyrene desktop` (or `cyrene open`) subcommand will launch the installed Electron app from `resources/app`, independent of the cwd. That subcommand is registered as a placeholder in v0.9 only to lock the name; the v0.9 placeholder is not what users will run in production.

When `cyrene run` is invoked from a directory without a `package.json`, the CLI prints a one-line message to stderr and exits 0 (see §3.7 for the rationale).

### 2.7 Placeholder commands

`cyrene doctor` and `cyrene init` print a single line:

```
cyrene doctor: planned for a future release. See https://github.com/Playa-0v0/Cyrene-Agent
```

…and exit 0. This is intentional: it lets `cyrene --help` advertise them, and it lets users who type them get a friendly answer instead of "unknown command".

### 2.8 Unknown commands

Any argv shape that does not match a registered command prints `cyrene: unknown command '<x>'. Try 'cyrene --help'.` to stderr and exits with code 2.

---

## 3. Architecture

### 3.1 Directory layout

```
src/
  cli/
    index.ts                  # shebang entry; calls app.main() and exits
    app.ts                    # parse argv → dispatch → await result
    argv.ts                   # argv → Command discriminated union
    commands/
      hello.ts                # full banner
      about.ts                # banner + metadata
      version.ts              # single line
      help.ts                 # static help text
      run.ts                  # spawns Electron (dev only)
      placeholder.ts          # doctor / init / update (and future v1.x commands)
      default.ts              # first-vs-subsequent decision
    banner/
      ascii.ts                # exports CYRENE_LOGO: string (6 lines)
      text.ts                 # exports BANNER_LINES: readonly string[] + renderBanner
      render.ts               # composes ascii + text into a single string
    state/
      state.ts                # readState / writeState (v0.9: only firstLaunch is read)
    util/
      log.ts                  # stdout / stderr writers (no color, no console.log)
      width.ts                # displayWidth helper used by render.ts
scripts/
  build-cli.mjs               # esbuild bundle of src/cli/index.ts → dist/cli/index.js
test/
  cli/
    state.test.ts
    render.test.ts
    argv.test.ts
    hello.test.ts
    default.test.ts
    placeholder.test.ts
    app.test.ts               # dispatch integration (mocked commands)
docs/
  superpowers/
    specs/
      2026-08-04-cyrene-cli-banner-design.md   # this file
```

`src/cli/index.ts` is the only entry the build pipeline cares about. It is a 3-line file:

```ts
#!/usr/bin/env node
import { main } from './app';
main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err) => { console.error(err); process.exit(1); }
);
```

`src/cli/app.ts` is where parse + dispatch + IO live, and is the unit that the test suite imports. The `tsconfig.cli.json` is independent from `tsconfig.main.json` and `tsconfig.preload.json`; it targets CommonJS, ES2022, includes only `src/cli/**`.

### 3.2 Build pipeline

A new `scripts/build-cli.mjs` runs `esbuild` with the following settings:

- `entryPoints: ['src/cli/index.ts']`
- `bundle: true`
- `platform: 'node'`
- `target: 'node24'`
- `format: 'cjs'`
- `outfile: 'dist/cli/index.js'`
- `banner: { js: '#!/usr/bin/env node' }`
- `external: []` (CLI has zero runtime deps)

`package.json` updates:

```jsonc
{
  "bin": {
    "cyrene": "./dist/cli/index.js"
  },
  "scripts": {
    "build:cli": "node scripts/build-cli.mjs",
    "build": "npm run build:skills && npm run build:main && npm run build:preload && npm run build:cli && npm run build:renderer",
    "dev": "npm run build:skills && npm run build:main && npm run build:preload && npm run build:cli && concurrently \"vite\" \"cross-env VITE_DEV=1 electron .\""
  }
}
```

`bin` files get their executable bit set automatically by `npm install` on POSIX, and by `npm install` plus `npm rebuild` on Windows when the file is committed with the shebang. We commit `dist/cli/index.js` only on release branches; in dev we rely on `npm run build:cli` followed by `npm link`.

### 3.3 Command dispatch

`src/cli/argv.ts` exposes a single function:

```ts
export type Command =
  | { kind: 'default' }
  | { kind: 'hello' }
  | { kind: 'about' }
  | { kind: 'version' }
  | { kind: 'help' }
  | { kind: 'run' }
  | { kind: 'placeholder'; name: 'doctor' | 'init' | 'update' }
  | { kind: 'unknown'; name: string };

export function parseArgv(argv: readonly string[]): Command;
```

The parser is hand-written. It accepts `--help` / `-h` and `--version` / `-v` anywhere, recognises exact subcommand names, and returns `{ kind: 'unknown'; name: string }` for anything else. `app.ts` maps the unknown case to the behaviour described in §2.8.

The `unknown` variant is a first-class part of the `Command` union (not a separate return type) so the dispatch function is exhaustively typed: any future `Command` variant added without a handler is a TypeScript error.

### 3.4 Banner rendering

`src/cli/banner/ascii.ts`:

```ts
export const CYRENE_LOGO: string =
  '██████╗██╗   ██╗██████╗ ███████╗███╗   ██╗███████╗\n' +
  '██╔════╝╚██╗ ██╔╝██╔══██╗██╔════╝████╗  ██║██╔════╝\n' +
  '██║      ╚████╔╝ ██████╔╝█████╗  ██╔██╗ ██║█████╗\n' +
  '██║       ╚██╔╝  ██╔══██╗██╔══╝  ██║╚██╗██║██╔══╝\n' +
  '╚██████╗   ██║   ██║  ██║███████╗██║ ╚████║███████╗\n' +
  ' ╚═════╝   ╚═╝   ╚═╝  ╚═╝╚══════╝╚═╝  ╚═══╝╚══════╝';
```

`src/cli/banner/text.ts` exports:

```ts
export const BANNER_LINES: readonly string[] = [
  '♡ Cyrene Agent ♡',
  'Your Desktop AI Companion',
  '"Every memory has a place."',
];

export const ABOUT_LINES: readonly string[] = [
  'GitHub:   https://github.com/Playa-0v0/Cyrene-Agent',
  'License:  MIT (see MODEL_LICENSE.md for model terms)',
];

export interface RenderOptions {
  quote?: string; // reserved; not read in v0.9
  width?: number; // minimum 60; default 64; clamped to terminal width
}

export function renderBanner(opts?: RenderOptions): string;
export function renderAbout(opts?: RenderOptions): string;
```

`render.ts` composes the logo and the framed text block. The frame uses only `╭`, `─`, `│`, `╰`, `╯` (no color). Width is determined by:

1. `process.stdout.columns` if `isatty(stdout)` and `columns >= 60`.
2. Otherwise `opts.width ?? 64`.
3. Clamped to a minimum of 60.
4. The three text lines are centered inside the box; if a line exceeds `width - 4`, it is truncated with a trailing `…`.

`util/width.ts` holds a `displayWidth(s: string): number` helper. The semantics in v0.9 are:

- `♡` → 1 cell (it's a BMP symbol, fits in one column on every monospace font we have tested).
- ASCII characters → 1 cell each.
- CJK characters → **not** in scope. v0.9 banners contain no CJK, so v0.9 uses a simple code-point count. The function is named `displayWidth` (not `visibleWidth`, not `graphemeLength`) to make room for an East Asian Width (UAX #11) implementation in v1.x without renaming anything.

The implementation in v0.9 is `Array.from(s).length`. This is documented as a known limitation, not a bug. The integration test in §4.2 verifies the banner contains only ASCII + `╭╮╰╯─│♡` characters.

### 3.5 First-launch state

`src/cli/state/state.ts` exports:

```ts
export interface FirstLaunchRecord {
  firstSeenAt: string; // ISO 8601 UTC
  version: string;     // e.g. "0.9.0"
}

export interface StateFile {
  firstLaunch?: FirstLaunchRecord;
  // future fields: lastSeenAt?, lastVersion?, sessionId?, etc.
}

export type FirstLaunchState =
  | { kind: 'missing' }
  | { kind: 'present'; record: FirstLaunchRecord }
  | { kind: 'corrupt'; raw: string };

export function statePath(): string;
export function readState(): FirstLaunchState;  // v0.9: only reads firstLaunch
export function writeState(s: StateFile): void; // throws on I/O error
```

`statePath()` returns `path.join(os.homedir(), '.cyrene', 'state.json')`. On Windows, `os.homedir()` is `%USERPROFILE%`, which is the same directory npm uses for `.npmrc`; the `~/.cyrene/` directory is conventional with several other CLI tools.

`readState()`:

- File does not exist → `{ kind: 'missing' }`.
- File exists, parses as a JSON object with a `firstLaunch` field whose value is an object containing both `firstSeenAt` and `version` strings → `{ kind: 'present', record }`.
- File exists but anything is wrong (parse error, wrong top-level type, missing or wrong-typed `firstLaunch`) → `{ kind: 'corrupt', raw }`. The CLI treats `corrupt` as if it were `missing` for the first-meeting decision, but logs a one-line warning: `cyrene: ~/.cyrene/state.json was unreadable; treating as first meeting.`

`writeState()`:

- Calls `fs.mkdirSync(dir, { recursive: true })` first.
- Writes the file with `fs.writeFileSync(path, JSON.stringify(s, null, 2))`. No `wx` flag — overwrite is fine; v0.9 only ever writes a single `firstLaunch` field, so there is no race to worry about.
- If the underlying `fs` call throws, the exception propagates. The caller (the `default` command) catches and logs a warning.

`app.ts` flow for the `default` command:

```
1. const state = readState();
2. if (state.kind === 'present') {
     print('Cyrene Agent v0.9.0\nReady.\n');   // version from __CYRENE_VERSION__
     return;
   }
3. // missing OR corrupt
   if (state.kind === 'corrupt') warn('cyrene: ~/.cyrene/state.json was unreadable; treating as first meeting.');
   print(renderBanner() + '\n\nThank you for bringing me home.\n');
   try {
     writeState({ firstLaunch: { firstSeenAt: new Date().toISOString(), version: __CYRENE_VERSION__ } });
   } catch (e) {
     warn('cyrene: could not write ~/.cyrene/state.json; you may see this banner again next time.');
   }
```

The version string is injected at build time via esbuild's `define` option, not read from disk at runtime:

```js
esbuild.build({
  // ...
  define: { __CYRENE_VERSION__: JSON.stringify(pkg.version) },
});
```

…and `src/cli/app.ts` references `__CYRENE_VERSION__` as if it were a global string constant. This keeps the CLI bundle free of `package.json` reads at runtime.

### 3.6 Help and version

`version.ts` reads `__CYRENE_VERSION__` and prints `<version>\n`. `help.ts` returns the static text shown in 2.5. `placeholder.ts` returns the text shown in 2.7, parameterised on the command name.

### 3.7 `app.ts` dispatch

`src/cli/app.ts` exports `async function main(argv: readonly string[]): Promise<number>`. Its body is an exhaustive `switch` on `parseArgv(argv).kind`. Each case awaits a command handler and returns the exit code. The `unknown` case prints to stderr and returns 2. The handlers themselves are responsible for the IO described in §3.4–§3.8.

`app.ts` is the only file that calls `process.stdout.write` / `process.stderr.write`. It does NOT use `console.log`, because `console.log` may apply an encoding transform on Windows legacy code pages (cp936, cp950) that mangles box-drawing characters in `cmd.exe`. The `util/log.ts` helpers wrap `process.stdout.write` / `process.stderr.write` directly.

### 3.8 `cyrene run` (v0.9: dev only)

This section lives as `src/cli/commands/run.ts` and is invoked by the `run` case of `app.ts`. The `not-in-project` branch of `RunResult` is mapped by `app.ts` to a single-line stderr message and exit code 0. The full implementation:

```ts
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

export type RunResult =
  | { kind: 'ok'; code: number }
  | { kind: 'not-in-project' };

export async function runCyreneRun(): Promise<RunResult> {
  if (!existsSync(path.join(process.cwd(), 'package.json'))) {
    return { kind: 'not-in-project' };
  }
  const electron = process.env.CYRENE_ELECTRON_BIN ?? 'electron';
  const child = spawn(electron, ['.'], { stdio: 'inherit', cwd: process.cwd() });
  return new Promise((resolve) => {
    child.on('exit', (code, signal) => {
      if (signal) resolve({ kind: 'ok', code: 1 });
      else resolve({ kind: 'ok', code: code ?? 0 });
    });
  });
}
```

The `cwd` is the user's current directory, NOT the CLI's install location. This is what makes `npm link` work: when the user runs `cyrene` from a clone, `process.cwd()` is the clone root, and `electron .` finds the local `main` field in `package.json`.

The `package.json` existence check is a friendlier gate than letting `electron .` produce a confusing "cannot find module" error. When the check fails, `app.ts` prints:

```
cyrene run: no package.json found in <cwd>. Run cyrene from inside a Cyrene project, or use the desktop installer.
```

…and exits 0 (the user did nothing wrong, they are just in the wrong directory). Exit code 0 here is intentional: the failure is an environmental hint, not a CLI error.

`CYRENE_ELECTRON_BIN` is an escape hatch for the test suite to point at a fake binary.

### 3.9 Error and exit semantics

| Condition                                  | stdout                                    | stderr                                                | exit |
|--------------------------------------------|-------------------------------------------|-------------------------------------------------------|------|
| `cyrene` first time                        | full banner + "Thank you for bringing me home." | (write warning if applicable)                          | 0    |
| `cyrene` subsequent                        | "Cyrene Agent v0.9.0\nReady."             | (corrupt-file warning if applicable)                  | 0    |
| `cyrene hello` / `cyrene about`            | banner (and metadata for about)           |                                                       | 0    |
| `cyrene version`                           | `<version>\n`                             |                                                       | 0    |
| `cyrene --help`                            | help text                                 |                                                       | 0    |
  | `cyrene run`                               | (Electron's own output)                   | (Electron's own output)                               | electron's exit code |
| `cyrene run` outside a project             | "cyrene run: no package.json found in …"  |                                                       | 0                    |
| `cyrene doctor` / `cyrene init`            | placeholder line                          |                                                       | 0    |
| Unknown command                            | (nothing)                                 | `cyrene: unknown command '<x>'. Try 'cyrene --help'.`  | 2    |
  | `state.json` write fails                 | banner (still printed)                    | one-line warning                                      | 0    |
| `state.json` read fails for any reason   | treat as first meeting (with warning)     | one-line warning                                      | 0    |

The CLI never exits non-zero for anything except an unknown command or a child-process exit code.

---

## 4. Testing

All tests live in `test/cli/` and run under `vitest`.

### 4.1 Unit tests

- **`state.test.ts`**
  - With a fresh temp dir, `readState()` returns `{ kind: 'missing' }`.
  - After `writeState({ firstLaunch: record })`, `readState()` returns `{ kind: 'present', record }`.
  - With a file containing invalid JSON, `readState()` returns `{ kind: 'corrupt', raw }`.
  - With a file whose top-level value is not an object, `readState()` returns `{ kind: 'corrupt' }`.
  - With a file whose `firstLaunch` field is missing or wrong-typed, `readState()` returns `{ kind: 'corrupt' }`.
  - Extra top-level keys (e.g. a `lastSeenAt` field) are ignored.
  - `statePath()` is stable across calls within one process.

- **`render.test.ts`**
  - `renderBanner({ width: 60 })` produces a string where each line is at most 60 visible columns.
  - The string starts with the six lines of `CYRENE_LOGO` followed by a blank line and the framed box.
  - A long custom line is truncated with `…` when it exceeds `width - 4`.
  - `renderBanner({ width: 40 })` still produces a usable string (clamped to 60 internally — verify by checking the width of the longest visible line).
  - `renderAbout({ width: 60 })` includes the GitHub URL.

- **`argv.test.ts`**
  - `parseArgv([])` returns `{ kind: 'default' }`.
  - `parseArgv(['hello'])` returns `{ kind: 'hello' }`.
  - `parseArgv(['--help'])` and `parseArgv(['-h'])` return `{ kind: 'help' }`.
  - `parseArgv(['unknown'])` returns `{ kind: 'unknown', name: 'unknown' }`.
  - Flags after the subcommand (e.g. `['hello', '--foo']`) return `{ kind: 'unknown', name: '--foo' }` so we fail fast and predictably.

- **`hello.test.ts`**
  - Calling the `hello` command handler writes the banner to a captured stdout and exits 0. (We avoid running a child process for this test; we import the handler and inject a writable stream.)

- **`default.test.ts`**
  - With a `state.json` present and a valid `firstLaunch` field, the default handler prints the two-line "Ready" message containing the value of `__CYRENE_VERSION__`.
  - With `state.json` missing, the default handler prints the full banner AND writes the file with the current `firstLaunch` record.
  - When `writeState` throws, the default handler still prints the banner and the warning, and exits 0.

- **`placeholder.test.ts`**
  - `placeholder('doctor')` prints the expected line and exits 0.

### 4.2 Integration test

`test/cli/cli.integration.test.ts` spawns the **built** `dist/cli/index.js` (or `node` against it on Windows) with a temporary `HOME` directory. The test verifies:

- First run: stdout contains "Every memory has a place." and "Thank you for bringing me home."; `~/.cyrene/state.json` exists afterwards with a `firstLaunch` field containing both required sub-fields.
- Second run: stdout contains "Ready." and does NOT contain "Every memory has a place."; the `state.json` file is unchanged.
- `cyrene hello`: stdout contains the quote on both runs.
- `cyrene --help`: stdout contains "Usage: cyrene".
- `cyrene doctor`: stdout contains "planned for a future release".
- `cyrene bogus`: stderr contains "unknown command" and exit code is 2.

The integration test is skipped if `dist/cli/index.js` does not exist (so the test command works in fresh clones that have not run `npm run build:cli` yet). A `pretest` script runs `npm run build:cli` to make sure the file exists in CI.

### 4.3 Manual verification checklist

To be performed once before merging the implementation plan:

- [ ] From a clean shell, `npm i -g .` then `cyrene` shows the banner. (A fresh `~/.cyrene/state.json` must NOT exist; delete it first if needed.)
- [ ] `cyrene` again shows only "Ready.".
- [ ] `cyrene hello` shows the banner.
- [ ] `cyrene about` shows the banner plus metadata.
- [ ] `cyrene --help` shows the help text.
- [ ] `cyrene version` shows `0.9.0`.
- [ ] `cyrene run` launches Electron with the same window as `npm start`.
- [ ] `cyrene doctor` and `cyrene init` show the placeholder line.
- [ ] `cyrene bogus` prints the unknown-command error and exits 2.
- [ ] Banner renders correctly in Windows Terminal, Git Bash, and a non-TTY pipe (`cyrene | cat` shows the same banner without color escape codes; verify by piping to `xxd | grep -c '1b 5b'` and expecting `0`).

---

## 5. Documentation

`README.md` (Chinese) and `README.en.md` (English) each gain a new subsection under "Quick Start" titled "Command-line entry" / "命令行入口" with:

- A short prose paragraph describing the first-time greeting and the `cyrene hello` summon command.
- A fenced text block showing the *first three lines* of the banner output (the logo) and a placeholder note that the full framed box is omitted for readability. The full banner is captured in `docs/cli-banner.png` and embedded as an image.
- A short table of the v0.9 subcommands.
- A forward reference to v1.x where `cyrene.exe` will be added to `PATH` automatically by the installer.

The README does NOT inline the full six-line logo + three-line framed box. Inlining the artwork in markdown stretches the GitHub page and the logo does not survive copy/paste. The image is the canonical artifact; the prose is the canonical explanation.

No new top-level file is required.

---

## 6. Dependencies

The CLI adds zero runtime dependencies. The build pipeline adds:

- `esbuild` as a devDependency (already pulled in transitively by `electron`, but declared explicitly to satisfy `npm ls`).

That's it. No `chalk`, no `picocolors`, no `boxen`, no `commander`, no `yargs`. Hand-rolled argv parser and a single `Intl.Segmenter` call.

This is a **hard constraint of the design**, recorded here so future contributors do not introduce a "fancy print" library to "improve" the banner.

---

## 7. Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| `~/.cyrene/` directory may not be writable on locked-down systems. | The CLI tolerates write failure with a one-line warning; it never fails because the welcome could not be persisted. |
| ANSI Shadow rendering of "CYRENE" may be misaligned in some monospace fonts. | The exact logo string in `src/cli/banner/ascii.ts` is committed verbatim and reviewed by eye before merge. The integration test asserts the first six non-empty lines match the expected snapshot. |
| Windows users with `npm i -g` on a system where `%AppData%\npm` is not on `PATH` will get `'cyrene' is not recognized`. | The README documents the `PATH` adjustment. The error itself is npm's, not ours, and a global install is a developer affordance — end users will use the v1.x installer. |
| `cyrene run` from a non-project directory will try `electron .` against a directory with no `package.json`, and fail with a confusing Electron error. | The `run` command checks that `cwd/package.json` exists and prints a friendlier message before spawning. See §3.8. |
| Users may try to chain the banner into other tools (`cyrene | grep ...`) and be surprised by the lack of a tty. | The banner is plain text, with no ANSI escapes, so it pipes cleanly. The "first-meeting + persist" side-effect still happens, which is the desired behaviour. |
| Future contributors may add color "to make it look better". | The design explicitly forbids color and lists the no-color rule as a hard constraint in section 6. |

---

## 8. Open Questions

None. All clarifications were resolved during brainstorming.

---

## 9. References

- README files in the repo root (`README.md`, `README.en.md`) — current behaviour and "Quick Start" structure.
- `package.json` — confirms `name: "live2d-cyrene"`, current scripts, and that no `bin` field is present today.
- The brainstorming session of 2026-08-04 (this document's sibling), which settled:
  - No git hooks (clone / pull / install do not auto-run).
  - First-meeting banner is shown on the first default invocation of `cyrene`; `cyrene hello` is the always-available summon command.
  - Banner content is fixed (no random quotes in v0.9); the quote `"Every memory has a place."` is the brand line.
  - Logo font is ANSI Shadow; color is forbidden; the only library to be added is `esbuild` (already a transitive dev dep).
  - `cyrene` is the unified entry point, not a shortcut to Electron; placeholder commands are registered to lock in the namespace.
