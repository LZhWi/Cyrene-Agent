import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { saveMinecraftLlmReport } from "./llm-report-store";

describe("Minecraft LLM report store", () => {
  it("persists only the isolated bounded execution contract", () => {
    const file = join(mkdtempSync(join(tmpdir(), "cyrene-mc-llm-")), "reports.json");
    expect(saveMinecraftLlmReport(file, {
      version: 1, source: "minecraft_gamebot", request: "找木头", status: "completed", message: "完成",
      steps: [{ command: "采集3个橡木", result: "采集完成" }], secret: "must-not-persist",
    })).toMatchObject({ status: "completed", request: "找木头" });
    expect(readFileSync(file, "utf8")).not.toContain("must-not-persist");
  });

  it("rejects reports from another system", () => {
    const file = join(mkdtempSync(join(tmpdir(), "cyrene-mc-llm-")), "reports.json");
    expect(saveMinecraftLlmReport(file, { version: 1, source: "chat" })).toBeNull();
  });
});
