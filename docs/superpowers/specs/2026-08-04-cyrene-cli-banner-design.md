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
  - `cyrene` (default; behaviour depends on `~/.cyrene/first-launch`)
  - `cyrene hello`
  - `cyrene about`
  - `cyrene version`
  - `cyrene --help` / `cyrene -h`
  - `cyrene run`
  - `cyrene doctor` (placeholder)
  - `cyrene init` (placeholder)
- A `first-launch` state file at `~/.cyrene/first-launch` controlling the default-invocation behaviour.
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

Behind the scenes, the CLI writes `~/.cyrene/first-launch` containing `{ "firstSeenAt": "<ISO8601 UTC>", "version": "0.9.0" }`. If the write fails (permission denied, disk full), the CLI prints a one-line warning to stderr and still exits 0. The banner must never be the reason a CLI invocation fails.

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

This is the "easter egg" path. It never consults `first-launch` and never writes anything.

### 2.4 `cyrene about`

```
$ cyrene about
<full banner>

GitHub:   https://github.com/Playa-0v0/Cyrene-Agent
License:  MIT (see MODEL_LICENSE.md for model terms)
```

### 2.5 `cyrene --help`

```
Usage: cyrene [command] [options]

Commands:
  hello     Print the welcome banner
  about     Print banner plus project metadata
  version   Print version only
  run       Launch the Electron desktop app
  doctor    Diagnose the local environment (planned)
  init      Initialize a workspace (planned)
  update    Self-update (planned)
  help      Show this help

Run `cyrene` with no arguments for the first-time greeting.
```

### 2.6 `cyrene run`

No banner. Spawns `electron .` in the current working directory with `stdio: 'inherit'`, then waits. Exit code mirrors the Electron process. The user sees the same thing they would have seen with `npm start`, but the entry point is `cyrene`.

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
    index.ts                  # shebang entry; parses argv; dispatches
    argv.ts                   # argv → Command discriminated union
    commands/
      hello.ts                # full banner
      about.ts                # banner + metadata
      version.ts              # single line
      help.ts                 # static help text
      run.ts                  # spawns Electron
      placeholder.ts          # doctor / init / future
      default.ts              # first-vs-subsequent decision
    banner/
      ascii.ts                # exports CYRENE_LOGO: string (6 lines)
      text.ts                 # exports BANNER_LINES: readonly string[] + renderBanner
      render.ts               # composes ascii + text into a single string
    state/
      firstLaunch.ts          # readFirstLaunch / writeFirstLaunch
    util/
      log.ts                  # stdout / stderr writers (no color)
      lines.ts                # visual-line helpers used by render.ts
scripts/
  build-cli.mjs               # esbuild bundle of src/cli/index.ts → dist/cli/index.js
test/
  cli/
    firstLaunch.test.ts
    render.test.ts
    argv.test.ts
    hello.test.ts
    default.test.ts
    placeholder.test.ts
docs/
  superpowers/
    specs/
      2026-08-04-cyrene-cli-banner-design.md   # this file
```

`src/cli/index.ts` is the only entry the build pipeline cares about. The `tsconfig.cli.json` is independent from `tsconfig.main.json` and `tsconfig.preload.json`; it targets CommonJS, ES2022, includes only `src/cli/**`.

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
  | { kind: 'placeholder'; name: 'doctor' | 'init' | 'update' };

export function parseArgv(argv: readonly string[]): Command;
```

The parser is hand-written. It accepts `--help` and `-h` anywhere, recognises exact subcommand names, and returns `{ kind: 'unknown'; name: string }` for anything else. `index.ts` maps the unknown case to the behaviour described in 2.8.

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

`util/lines.ts` holds a tiny `visibleWidth` helper that counts grapheme clusters using `Intl.Segmenter` (Node 24 has it natively), so `♡` and CJK characters count as one cell each.

### 3.5 First-launch state

`src/cli/state/firstLaunch.ts` exports:

```ts
export interface FirstLaunchRecord {
  firstSeenAt: string; // ISO 8601 UTC
  version: string;     // e.g. "0.9.0"
}

export type FirstLaunchState =
  | { kind: 'missing' }
  | { kind: 'present'; record: FirstLaunchRecord }
  | { kind: 'corrupt'; raw: string };

export function firstLaunchPath(): string;
export function readFirstLaunch(): FirstLaunchState;
export function writeFirstLaunch(record: FirstLaunchRecord): void; // throws on I/O error
```

`firstLaunchPath()` returns `path.join(os.homedir(), '.cyrene', 'first-launch')`. On Windows, `os.homedir()` is `%USERPROFILE%`, which is the same directory npm uses for `.npmrc`; the `~/.cyrene/` directory is conventional with several other CLI tools.

`readFirstLaunch()`:

- File does not exist → `{ kind: 'missing' }`.
- File exists, parses as JSON, has both `firstSeenAt` and `version` strings → `{ kind: 'present', record }`.
- File exists but anything is wrong (parse error, missing field, wrong type) → `{ kind: 'corrupt', raw }`. The CLI treats `corrupt` as if it were `missing` for the first-meeting decision, but logs a one-line warning: `cyrene: ~/.cyrene/first-launch was unreadable; treating as first meeting.`

`writeFirstLaunch()`:

- Calls `fs.mkdirSync(dir, { recursive: true })` first.
- Writes the file with `fs.writeFileSync(path, JSON.stringify(record, null, 2))`. No `wx` flag — overwrite is fine.
- If the underlying `fs` call throws, the exception propagates. The caller (the `default` command) catches and logs a warning.

`index.ts` flow for the `default` command:

```
1. const state = readFirstLaunch();
2. if (state.kind === 'present') {
     print('Cyrene Agent v0.9.0\nReady.\n');
     return;
   }
3. // missing OR corrupt
   if (state.kind === 'corrupt') warn(...);
   print(renderBanner() + '\n\nThank you for bringing me home.\n');
   try {
     writeFirstLaunch({ firstSeenAt: new Date().toISOString(), version: '0.9.0' });
   } catch (e) {
     warn('cyrene: could not write ~/.cyrene/first-launch; you may see this banner again next time.');
   }
```

The version string `'0.9.0'` is read at runtime from `../../package.json` (already present in the source tree at build time). The `package.json` is NOT bundled into the CLI; instead, `scripts/build-cli.mjs` injects the version as a `define`:

```js
esbuild.build({
  // ...
  define: { __CYRENE_VERSION__: JSON.stringify(pkg.version) },
});
```

…and `src/cli/index.ts` references `__CYRENE_VERSION__` as if it were a global string constant. This keeps the CLI bundle free of `package.json` reads at runtime.

### 3.6 Help and version

`version.ts` reads `__CYRENE_VERSION__` and prints `<version>\n`. `help.ts` returns the static text shown in 2.5. `placeholder.ts` returns the text shown in 2.7, parameterised on the command name.

### 3.7 `cyrene run`

`run.ts` does:

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

The `package.json` existence check is a friendlier gate than letting `electron .` produce a confusing "cannot find module" error. When the check fails, the CLI prints:

```
cyrene run: no package.json found in <cwd>. Run cyrene from inside a Cyrene project, or use the desktop installer.
```

…and exits 0 (the user did nothing wrong, they are just in the wrong directory). Exit code 0 here is intentional: the failure is an environmental hint, not a CLI error.

`CYRENE_ELECTRON_BIN` is an escape hatch for the test suite to point at a fake binary.

### 3.8 Error and exit semantics

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
| `first-launch` write fails                 | banner (still printed)                    | one-line warning                                      | 0    |
| `first-launch` read fails for any reason   | treat as first meeting (with warning)     | one-line warning                                      | 0    |

The CLI never exits non-zero for anything except an unknown command or a child-process exit code.

---

## 4. Testing

All tests live in `test/cli/` and run under `vitest`.

### 4.1 Unit tests

- **`firstLaunch.test.ts`**
  - With a fresh temp dir, `readFirstLaunch()` returns `{ kind: 'missing' }`.
  - After `writeFirstLaunch(record)`, `readFirstLaunch()` returns `{ kind: 'present', record }`.
  - With a file containing invalid JSON, `readFirstLaunch()` returns `{ kind: 'corrupt', raw }`.
  - With a file missing the `version` field, `readFirstLaunch()` returns `{ kind: 'corrupt' }`.
  - `firstLaunchPath()` is stable across calls within one process.

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
  - With a `first-launch` file present, the default handler prints the two-line "Ready" message containing the value of `__CYRENE_VERSION__`.
  - With a `first-launch` file missing, the default handler prints the full banner AND creates the file.
  - When `writeFirstLaunch` throws, the default handler still prints the banner and the warning, and exits 0.

- **`placeholder.test.ts`**
  - `placeholder('doctor')` prints the expected line and exits 0.

### 4.2 Integration test

`test/cli/cli.integration.test.ts` spawns the **built** `dist/cli/index.js` (or `node` against it on Windows) with a temporary `HOME` directory. The test verifies:

- First run: stdout contains "Every memory has a place." and "Thank you for bringing me home."; `~/.cyrene/first-launch` exists afterwards with both required fields.
- Second run: stdout contains "Ready." and does NOT contain "Every memory has a place."; the `first-launch` file is unchanged.
- `cyrene hello`: stdout contains the quote on both runs.
- `cyrene --help`: stdout contains "Usage: cyrene".
- `cyrene doctor`: stdout contains "planned for a future release".
- `cyrene bogus`: stderr contains "unknown command" and exit code is 2.

The integration test is skipped if `dist/cli/index.js` does not exist (so the test command works in fresh clones that have not run `npm run build:cli` yet). A `pretest` script runs `npm run build:cli` to make sure the file exists in CI.

### 4.3 Manual verification checklist

To be performed once before merging the implementation plan:

- [ ] From a clean shell, `npm i -g .` then `cyrene` shows the banner.
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

- A code block showing `npm i -g .` then `cyrene` (and the resulting banner, in a fenced text block).
- A short table of the v0.9 subcommands.
- A forward reference to v1.x where `cyrene.exe` will be added to `PATH` automatically by the installer.

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
| `cyrene run` from a non-project directory will try `electron .` against a directory with no `package.json`, and fail with a confusing Electron error. | The `run` command checks that `cwd/package.json` exists and prints a friendlier message before spawning. See §3.7. |
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
