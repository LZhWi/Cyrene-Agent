import { describe, expect, it } from "vitest";
import { normalizeUiTheme, normalizeUiThemeChoice, resolveUiTheme } from "../shared/ui-theme";

describe("normalizeUiTheme", () => {
  it.each([
    ["pearl-white", "pearl-white"],
    ["classic", "pearl-white"],
    ["polished-pink", "pearl-white"],
    [undefined, "pearl-white"],
    ["unknown", "pearl-white"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeUiTheme(input)).toBe(expected);
  });
});

describe("system theme choice", () => {
  it("preserves the saved system choice and existing manual choices", () => {
    expect(normalizeUiThemeChoice("system")).toBe("system");
    expect(normalizeUiThemeChoice("charcoal-pink")).toBe("charcoal-pink");
    expect(normalizeUiThemeChoice(undefined)).toBe("pearl-white");
  });

  it("resolves the system choice from the operating system without changing manual choices", () => {
    expect(resolveUiTheme("system", true)).toBe("charcoal-pink");
    expect(resolveUiTheme("system", false)).toBe("pearl-white");
    expect(resolveUiTheme("pearl-white", true)).toBe("pearl-white");
    expect(resolveUiTheme("charcoal-pink", false)).toBe("charcoal-pink");
  });
});
