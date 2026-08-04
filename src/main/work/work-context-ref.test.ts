import { describe, expect, it } from "vitest";
import { WorkContextRefRegistry } from "./work-context-ref";

describe("WorkContextRefRegistry", () => {
  it("isolates references by Work session and kind", () => {
    const refs = new WorkContextRefRegistry();
    const ref = refs.register("work-a", "tool_result", { value: 1 });
    expect(refs.resolve(ref, "work-a", "tool_result")).toEqual({ value: 1 });
    expect(() => refs.resolve(ref, "work-b", "tool_result")).toThrow("E_WORK_REF_SESSION_MISMATCH");
    expect(() => refs.resolve(ref, "work-a", "artifact")).toThrow("E_WORK_REF_KIND_MISMATCH");
  });

  it("expires references", () => {
    let now = 10;
    const refs = new WorkContextRefRegistry(5, 10, () => now);
    const ref = refs.register("work-a", "tool_result", "value");
    now = 16;
    expect(() => refs.resolve(ref, "work-a")).toThrow("E_WORK_REF_EXPIRED");
  });
});
