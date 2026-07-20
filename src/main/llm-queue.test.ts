import { describe, expect, it, vi } from "vitest";
import { enqueueLLMTask } from "./llm-queue";

describe("enqueueLLMTask", () => {
  it("can run a background observer without adding terminal noise", async () => {
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      await enqueueLLMTask("心情观察器", async () => "ok", { log: false });
      expect(log).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
    }
  });
});
