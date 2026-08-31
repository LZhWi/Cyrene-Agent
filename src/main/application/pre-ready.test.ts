import { describe, expect, it, vi } from "vitest";
import { prepareBeforeReady, type PreReadyDependencies } from "./pre-ready";

function makePreReadyDeps(calls: string[], overrides: Partial<PreReadyDependencies> = {}): PreReadyDependencies {
  return {
    configureDocumentIndex: vi.fn(() => { calls.push("configure-document-index"); }),
    installSingleInstance: vi.fn(() => { calls.push("single-instance-lock"); return true; }),
    registerPrivilegedSchemes: vi.fn(() => { calls.push("register-schemes"); }),
    configureGpuSwitches: vi.fn(() => { calls.push("gpu-switches"); }),
    ensureGpuSandboxAcl: vi.fn(() => { calls.push("gpu-acl"); }),
    activation: { request: vi.fn() },
    ...overrides,
  };
}

describe("prepareBeforeReady", () => {
  it("performs every Electron pre-ready operation synchronously in order", () => {
    const calls: string[] = [];
    const result = prepareBeforeReady(makePreReadyDeps(calls));
    expect(calls).toEqual([
      "configure-document-index",
      "single-instance-lock",
      "register-schemes",
      "gpu-switches",
      "gpu-acl",
    ]);
    expect(result.isPrimaryProcess).toBe(true);
  });

  it("does not continue primary startup for a duplicate process", () => {
    const deps = makePreReadyDeps([], { installSingleInstance: () => false });
    expect(prepareBeforeReady(deps).isPrimaryProcess).toBe(false);
    expect(deps.registerPrivilegedSchemes).not.toHaveBeenCalled();
    expect(deps.ensureGpuSandboxAcl).not.toHaveBeenCalled();
  });

  it("routes second-instance activation through the chat request", () => {
    const request = vi.fn();
    const deps = makePreReadyDeps([], {
      activation: { request },
      installSingleInstance: (onSecondInstance) => {
        onSecondInstance();
        return true;
      },
    });
    prepareBeforeReady(deps);
    expect(request).toHaveBeenCalledWith({ kind: "chat" });
  });
});
