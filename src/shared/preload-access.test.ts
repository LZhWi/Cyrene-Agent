import { describe, expect, it } from "vitest";
import { parsePreloadWindowRole, shouldExposePreloadApi } from "./preload-access";

describe("preload access policy", () => {
  it("parses only known main-process window roles", () => {
    expect(parsePreloadWindowRole(["electron", "--cyrene-window-role=chat"])).toBe("chat");
    expect(parsePreloadWindowRole(["electron", "--cyrene-window-role=unknown"])).toBeNull();
    expect(parsePreloadWindowRole(["electron"])).toBeNull();
  });

  it("keeps the legacy API surface available in every desktop window", () => {
    for (const role of ["main", "chat", "sidebar", "tasks", "settings", "sticker-manager", "call"] as const) {
      expect(shouldExposePreloadApi(role, "agui")).toBe(true);
      expect(shouldExposePreloadApi(role, "settings")).toBe(true);
      expect(shouldExposePreloadApi(role, "gameBot")).toBe(true);
    }
  });

  it("keeps unlabelled legacy windows compatible", () => {
    expect(shouldExposePreloadApi(null, "gameBot")).toBe(true);
    expect(shouldExposePreloadApi(null, "settings")).toBe(true);
  });
});
