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
