import { describe, expect, it } from "vitest";
import {
  RENDERER_CONTENT_SECURITY_POLICY,
  shouldProtectRendererDocument,
} from "./renderer-security-policy";

describe("renderer content security policy", () => {
  it("protects normal development and packaged renderer documents", () => {
    expect(shouldProtectRendererDocument("http://localhost:5173/chat/")).toBe(true);
    expect(shouldProtectRendererDocument("file:///C:/app/renderer/settings/index.html")).toBe(true);
  });

  it("leaves the excluded GameBot renderer unchanged", () => {
    expect(shouldProtectRendererDocument("http://localhost:5173/gamebot/")).toBe(false);
    expect(shouldProtectRendererDocument("file:///C:/app/renderer/gamebot/index.html")).toBe(false);
  });

  it("blocks executable objects and framing by default", () => {
    expect(RENDERER_CONTENT_SECURITY_POLICY).toContain("script-src 'self'");
    expect(RENDERER_CONTENT_SECURITY_POLICY).toContain("object-src 'none'");
    expect(RENDERER_CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
    expect(RENDERER_CONTENT_SECURITY_POLICY).not.toContain("unsafe-eval");
  });
});
