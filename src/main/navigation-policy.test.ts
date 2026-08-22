import { describe, expect, it } from "vitest";
import { classifyNavigation } from "./navigation-policy";

describe("renderer navigation policy", () => {
  it("allows same-app navigation and file hash changes", () => {
    expect(classifyNavigation(
      "http://localhost:5173/settings/#tasks",
      "http://localhost:5173/settings/",
    )).toBe("allow");
    expect(classifyNavigation(
      "file:///C:/app/renderer/settings/index.html#tasks",
      "file:///C:/app/renderer/settings/index.html",
    )).toBe("allow");
  });

  it("opens only HTTP(S) cross-origin URLs externally", () => {
    expect(classifyNavigation("https://github.com/example", "file:///C:/app/index.html"))
      .toBe("external");
    expect(classifyNavigation("https://example.com", "http://localhost:5173/settings/"))
      .toBe("external");
  });

  it("denies script, data, custom and foreign file navigation", () => {
    const current = "file:///C:/app/renderer/settings/index.html";
    expect(classifyNavigation("javascript:alert(1)", current)).toBe("deny");
    expect(classifyNavigation("data:text/html,boom", current)).toBe("deny");
    expect(classifyNavigation("local-sticker://image.png", current)).toBe("deny");
    expect(classifyNavigation("file:///C:/Windows/System32/drivers/etc/hosts", current)).toBe("deny");
    expect(classifyNavigation("not a url", current)).toBe("deny");
  });
});
