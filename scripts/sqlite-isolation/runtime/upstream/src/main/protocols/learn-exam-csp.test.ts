import { describe, expect, it } from "vitest";
import { buildLearnExamCsp } from "./learn-exam-csp";

describe("learn exam content security policy", () => {
  it("allows Vite's injected inline runtime only in development", () => {
    const devScriptPolicy = buildLearnExamCsp(true).match(/script-src[^;]*/)?.[0];
    const productionScriptPolicy = buildLearnExamCsp(false).match(/script-src[^;]*/)?.[0];
    expect(devScriptPolicy).toBe("script-src 'self' 'unsafe-eval' 'unsafe-inline'");
    expect(productionScriptPolicy).toBe("script-src 'self'");
  });
});
