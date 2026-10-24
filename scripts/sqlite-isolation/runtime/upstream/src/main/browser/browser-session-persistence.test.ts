import { describe, expect, it } from "vitest";
import { isBrowserPanelUrl } from "./browser-session-persistence";

describe("browser panel persisted URL policy", () => {
  it("allows ordinary web pages and the app-owned exam document route", () => {
    expect(isBrowserPanelUrl("https://example.com/path")).toBe(true);
    expect(isBrowserPanelUrl("cyrene-exam://paper/exam-123e4567-e89b-12d3-a456-426614174000")).toBe(true);
  });

  it("rejects arbitrary custom protocols and non-document exam resources", () => {
    expect(isBrowserPanelUrl("file:///C:/secret.txt")).toBe(false);
    expect(isBrowserPanelUrl("cyrene-exam://paper/assets/exam.js")).toBe(false);
    expect(isBrowserPanelUrl("cyrene-exam://paper/%2e%2e/secret.js")).toBe(false);
  });
});
