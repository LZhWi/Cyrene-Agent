# Appearance Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated appearance settings tab, move theme and Live2D desktop-pet controls into it, provide disabled future-feature placeholders, and remove the redundant polished-pink theme safely.

**Architecture:** Keep the existing `GeneralSettings` persistence and IPC surface, but split renderer ownership into appearance and general forms. Centralize supported theme values and legacy normalization in a shared pure module, then verify the HTML information architecture with static markup tests and verify payload construction with pure unit tests.

**Tech Stack:** Electron 43, TypeScript, vanilla HTML/CSS renderer, Vitest, Vite.

## Global Constraints

- The available layouts are “多窗口” and disabled “单窗口 · SOON”; no layout setting or IPC is added.
- The available themes are exactly `classic` and `pearl-white`.
- Legacy `polished-pink` values normalize to `classic`.
- “字体”“桌面图标”“聊天背景” are disabled placeholders only; no configuration field, IPC, or empty handler is added.
- Existing desktop-pet IPC behavior remains unchanged.
- Do not modify Live2D models, motions, expressions, textures, or Cubism assets.
- Preserve the current settings-center visual language and responsive behavior.

---

## File Structure

- Create `src/shared/ui-theme.ts`: single source of truth for supported UI themes and legacy-value normalization.
- Create `src/shared/ui-theme.test.ts`: unit coverage for supported and legacy theme inputs.
- Modify `src/main/index.ts`: use the shared two-value theme type and normalization when loading settings.
- Modify `src/preload/index.ts`: expose only the two supported theme values to renderers.
- Modify `src/renderer/ui/theme.ts`: apply shared normalization in every renderer window.
- Modify `src/renderer/ui/theme.css`: remove the complete `polished-pink` theme block.
- Create `src/renderer/settings/appearance-settings-state.ts`: build the appearance portion of a GeneralSettings save patch without DOM coupling.
- Create `src/renderer/settings/appearance-settings-state.test.ts`: verify appearance saves contain only theme and desktop-pet fields.
- Create `src/renderer/settings/appearance-settings-markup.test.ts`: verify navigation, panel grouping, disabled placeholders, theme options, and control migration directly from the shipped HTML.
- Modify `src/renderer/settings/index.html`: add the appearance navigation/panel, rename general settings, and move existing controls without changing their IDs.
- Modify `src/renderer/settings/settings.ts`: wire appearance navigation, status, loading, theme preview, and form submission.
- Modify `src/renderer/settings/settings.css`: style grouping, layout cards, disabled rows, `SOON` badges, and narrow-window wrapping.

---

### Task 1: Remove the Redundant Theme Safely

**Files:**
- Create: `src/shared/ui-theme.ts`
- Create: `src/shared/ui-theme.test.ts`
- Modify: `src/main/index.ts`
- Modify: `src/preload/index.ts`
- Modify: `src/renderer/ui/theme.ts`
- Modify: `src/renderer/ui/theme.css`
- Modify: `src/renderer/settings/settings.ts`

**Interfaces:**
- Produces:
  ```ts
  export type UiTheme = "classic" | "pearl-white";
  export function normalizeUiTheme(value: unknown): UiTheme;
  ```
- All main, preload, and renderer theme consumers use this type or the same two-value contract.

- [ ] **Step 1: Write the failing theme normalization test**

Create `src/shared/ui-theme.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { normalizeUiTheme } from "./ui-theme";

describe("normalizeUiTheme", () => {
  it.each([
    ["classic", "classic"],
    ["pearl-white", "pearl-white"],
    ["polished-pink", "classic"],
    [undefined, "classic"],
    ["unknown", "classic"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeUiTheme(input)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run the test and verify the missing-module failure**

Run: `npm test -- src/shared/ui-theme.test.ts --reporter=dot`

Expected: FAIL because `./ui-theme` does not exist.

- [ ] **Step 3: Add the shared theme model**

Create `src/shared/ui-theme.ts`:

```ts
export type UiTheme = "classic" | "pearl-white";

export function normalizeUiTheme(value: unknown): UiTheme {
  return value === "pearl-white" ? "pearl-white" : "classic";
}
```

- [ ] **Step 4: Replace local theme unions and normalization**

In `src/main/index.ts`, import `UiTheme` and `normalizeUiTheme`, change `GeneralSettings.uiTheme` to `UiTheme`, and replace the nested polished-pink normalization with:

```ts
uiTheme: normalizeUiTheme(input?.uiTheme),
```

In `src/preload/index.ts`, import `UiTheme` as a type and change `UI_THEME_GET`/`UI_THEME_CHANGED` promises, callbacks, and listener payloads to `UiTheme`.

In `src/renderer/ui/theme.ts`, import the shared type and normalizer, remove its local union and normalizer, and retain the existing `applyTheme` behavior.

In `src/renderer/settings/settings.ts`, import the shared type and normalizer, change the local `GeneralSettings.uiTheme` property to `UiTheme`, and remove the local `normalizeUiTheme` function.

- [ ] **Step 5: Remove polished-pink CSS**

Delete the complete `[data-ui-theme="polished-pink"]` section at the beginning of `src/renderer/ui/theme.css`, stopping immediately before the first `[data-ui-theme="pearl-white"]` rule. Do not change pearl-white rules.

- [ ] **Step 6: Verify the theme test and absence of the removed theme**

Run:

```powershell
npm test -- src/shared/ui-theme.test.ts --reporter=dot
rg -n "polished-pink" src/main src/preload src/renderer src/shared
```

Expected: the test passes and `rg` returns no production matches other than the deliberate legacy test case.

- [ ] **Step 7: Commit the theme cleanup**

```powershell
git add src/shared/ui-theme.ts src/shared/ui-theme.test.ts src/main/index.ts src/preload/index.ts src/renderer/ui/theme.ts src/renderer/ui/theme.css src/renderer/settings/settings.ts
git commit -m "refactor(theme): remove redundant dark theme"
```

---

### Task 2: Add the Appearance Information Architecture

**Files:**
- Create: `src/renderer/settings/appearance-settings-markup.test.ts`
- Modify: `src/renderer/settings/index.html`
- Modify: `src/renderer/settings/settings.css`

**Interfaces:**
- Preserves existing IDs: `ui-theme-select`, `pet-always-on-top`, `pet-visible`, `pet-zoom`, and `pet-zoom-val`.
- Produces new IDs: `appearance-form` and `appearance-save-status`.
- Produces new navigation key: `data-section="appearance"`.

- [ ] **Step 1: Write failing static markup tests**

Create `src/renderer/settings/appearance-settings-markup.test.ts` with helpers that read `index.html` and extract a form by ID:

```ts
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

function form(id: string): string {
  const match = html.match(new RegExp(`<form[^>]+id="${id}"[\\s\\S]*?</form>`));
  if (!match) throw new Error(`missing form ${id}`);
  return match[0];
}

describe("appearance settings markup", () => {
  it("adds appearance navigation and renames general settings", () => {
    expect(html).toContain('data-section="appearance"');
    expect(html).toContain('data-section="general"><span>⚙️</span>通用设置');
  });

  it("contains the four appearance groups and disabled future options", () => {
    const panel = form("appearance-form");
    expect(panel).toContain("布局");
    expect(panel).toContain("外观主题");
    expect(panel).toContain("个性化");
    expect(panel).toContain("昔涟桌宠");
    for (const label of ["单窗口", "字体", "桌面图标", "聊天背景"]) {
      expect(panel).toMatch(new RegExp(`<button[^>]+disabled[^>]*>[\\s\\S]*?${label}[\\s\\S]*?SOON`));
    }
  });

  it("offers only default and pearl-white themes", () => {
    const panel = form("appearance-form");
    expect(panel).toContain('data-theme="classic"');
    expect(panel).toContain('data-theme="pearl-white"');
    expect(panel).not.toContain('data-theme="polished-pink"');
  });

  it("moves desktop-pet controls out of general settings", () => {
    const appearance = form("appearance-form");
    const general = form("general-form");
    for (const id of ["pet-always-on-top", "pet-visible", "pet-zoom"]) {
      expect(appearance).toContain(`id="${id}"`);
      expect(general).not.toContain(`id="${id}"`);
    }
  });
});
```

- [ ] **Step 2: Run the markup tests and verify they fail on the missing panel**

Run: `npm test -- src/renderer/settings/appearance-settings-markup.test.ts --reporter=dot`

Expected: FAIL because `appearance-form` and appearance navigation do not exist.

- [ ] **Step 3: Add and populate the appearance form**

In `src/renderer/settings/index.html`:

- Insert `🎨 外观设置` before general navigation.
- Rename general navigation and headings to “通用设置”.
- Add `appearance-form` with the four approved groups.
- Render “多窗口” as selected and “单窗口” as a disabled button with `SOON`.
- Move the existing theme picker into the appearance form and remove the polished-pink button.
- Add disabled button rows for font, desktop icon, and chat background.
- Move the existing desktop-pet rows unchanged so their IDs and input constraints remain stable.
- Add an `appearance-save-status` and “保存外观设置” submit button.
- Remove the moved rows from `general-form`.

- [ ] **Step 4: Add focused appearance styles**

In `src/renderer/settings/settings.css`, add styles scoped to these new classes:

```css
.appearance-section { display: grid; gap: 12px; }
.appearance-section + .appearance-section { margin-top: 22px; }
.appearance-section__heading { display: grid; gap: 4px; }
.appearance-section__heading h2 { margin: 0; font-size: 15px; }
.appearance-section__heading p { margin: 0; color: var(--text-muted); font-size: 12px; }
.appearance-options { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 10px; }
.appearance-option:disabled,
.appearance-placeholder:disabled { cursor: not-allowed; opacity: 0.52; transform: none; }
.soon-badge { border-radius: 999px; padding: 2px 7px; font-size: 10px; letter-spacing: 0.08em; }
```

Use `var(--rb-text-muted)`, `var(--rb-border-soft)`, `var(--rb-bg-2)`, and `var(--rb-text-strong)` for the new copy, borders, surfaces, and strong labels. Add the single-column rule inside the existing `@media (max-width: 620px)` block:

```css
.appearance-options { grid-template-columns: 1fr; }
```

- [ ] **Step 5: Run the markup tests**

Run: `npm test -- src/renderer/settings/appearance-settings-markup.test.ts --reporter=dot`

Expected: PASS, 4 tests.

- [ ] **Step 6: Commit the information architecture**

```powershell
git add src/renderer/settings/index.html src/renderer/settings/settings.css src/renderer/settings/appearance-settings-markup.test.ts
git commit -m "feat(settings): add appearance panel layout"
```

---

### Task 3: Wire Appearance Loading and Saving

**Files:**
- Create: `src/renderer/settings/appearance-settings-state.ts`
- Create: `src/renderer/settings/appearance-settings-state.test.ts`
- Modify: `src/renderer/settings/settings.ts`

**Interfaces:**
- Consumes `UiTheme` and existing DOM input values.
- Produces:
  ```ts
  export interface AppearanceSettingsInput {
    uiTheme: UiTheme;
    petAlwaysOnTop: boolean;
    petVisible: boolean;
    petZoom: number;
  }

  export function buildAppearanceSettingsPatch(input: AppearanceSettingsInput): AppearanceSettingsInput;
  ```

- [ ] **Step 1: Write the failing appearance payload test**

Create `src/renderer/settings/appearance-settings-state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildAppearanceSettingsPatch } from "./appearance-settings-state";

describe("buildAppearanceSettingsPatch", () => {
  it("builds only theme and desktop-pet settings", () => {
    expect(buildAppearanceSettingsPatch({
      uiTheme: "pearl-white",
      petAlwaysOnTop: true,
      petVisible: false,
      petZoom: 1.4,
    })).toEqual({
      uiTheme: "pearl-white",
      petAlwaysOnTop: true,
      petVisible: false,
      petZoom: 1.4,
    });
  });
});
```

- [ ] **Step 2: Run the state test and verify the missing-module failure**

Run: `npm test -- src/renderer/settings/appearance-settings-state.test.ts --reporter=dot`

Expected: FAIL because `appearance-settings-state.ts` does not exist.

- [ ] **Step 3: Implement the pure appearance patch builder**

Create `src/renderer/settings/appearance-settings-state.ts`:

```ts
import type { UiTheme } from "../../shared/ui-theme";

export interface AppearanceSettingsInput {
  uiTheme: UiTheme;
  petAlwaysOnTop: boolean;
  petVisible: boolean;
  petZoom: number;
}

export function buildAppearanceSettingsPatch(input: AppearanceSettingsInput): AppearanceSettingsInput {
  return { ...input };
}
```

- [ ] **Step 4: Wire the new panel in settings.ts**

Add references for `appearanceForm` and `appearanceSaveStatus`, plus `setAppearanceSaveStatus` matching the existing status helpers.

Add the navigation label:

```ts
appearance: { emoji: "🎨", title: "外观设置", hint: "调整窗口布局、界面主题与昔涟桌宠" },
general: { emoji: "⚙️", title: "通用设置", hint: "管理窗口、音频和系统行为" },
```

In `loadGeneralSettings`, continue filling theme and desktop-pet controls from the same loaded object, then reset both general and appearance status messages.

Change theme button clicks to call `setAppearanceSaveStatus("有未保存的更改")`.

Add appearance form submission:

```ts
appearanceForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  setAppearanceSaveStatus("保存中…");
  try {
    await window.settings!.saveGeneral(buildAppearanceSettingsPatch({
      uiTheme: getUiThemeValue(),
      petAlwaysOnTop: petAlwaysOnTopInput.checked,
      petVisible: petVisibleInput.checked,
      petZoom: Number(petZoomInput.value),
    }));
    setAppearanceSaveStatus("已保存", "is-ok");
  } catch {
    setAppearanceSaveStatus("保存失败", "is-error");
  }
});
```

Remove `uiTheme`, `petAlwaysOnTop`, `petVisible`, and `petZoom` from the general form submission patch.

Extend `switchSection` with `isAppearance`, toggle `appearanceForm`, and include it in both placeholder exclusion expressions.

- [ ] **Step 5: Verify focused state and markup tests**

Run:

```powershell
npm test -- src/shared/ui-theme.test.ts src/renderer/settings/appearance-settings-state.test.ts src/renderer/settings/appearance-settings-markup.test.ts --reporter=dot
```

Expected: all focused tests pass.

- [ ] **Step 6: Commit appearance behavior**

```powershell
git add src/renderer/settings/appearance-settings-state.ts src/renderer/settings/appearance-settings-state.test.ts src/renderer/settings/settings.ts
git commit -m "feat(settings): wire appearance preferences"
```

---

### Task 4: Full Verification and Visual QA

**Files:**
- Modify only files required to fix verification findings within the approved scope.

**Interfaces:**
- No new interface; this task validates Tasks 1–3 together.

- [ ] **Step 1: Run focused tests and production build**

```powershell
npm test -- src/shared/ui-theme.test.ts src/renderer/settings/appearance-settings-state.test.ts src/renderer/settings/appearance-settings-markup.test.ts --reporter=dot
npm run build
```

Expected: all tests and all three build stages pass.

- [ ] **Step 2: Run the full regression suite**

Run: `npm test -- --reporter=dot`

Expected: all test files and tests pass.

- [ ] **Step 3: Inspect production output and repository hygiene**

```powershell
rg -n "polished-pink" src/main src/preload src/renderer src/shared
git diff --check
git status --short
```

Expected: only the deliberate legacy normalization test mentions `polished-pink`; no whitespace errors or generated build artifacts are staged.

- [ ] **Step 4: Visually inspect the settings page**

Launch the application with `npm run dev`, open Settings → 外观设置, and verify:

- navigation labels and active state are correct;
- all four groups are visible;
- `SOON` rows are visibly disabled and cannot be clicked;
- default and white themes both render readable text and badges;
- desktop-pet visibility, topmost, and zoom controls still work;
- the panel remains usable at the narrowest supported settings-window width.

- [ ] **Step 5: Record the final verification state**

Run:

```powershell
git log -4 --oneline
git status --short
```

Expected: the three implementation commits are present after the design/plan documentation commits, and the working tree is clean.
