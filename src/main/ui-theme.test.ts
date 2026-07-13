import { describe, expect, it } from "vitest";
import { normalizeUiTheme } from "../shared/ui-theme";

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
