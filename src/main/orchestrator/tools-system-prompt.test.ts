import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";

describe("tools_system prompt truthfulness fallback", () => {
  it("requires real tool calls and the daily recommendation card chain", () => {
    const prompt = fs.readFileSync(path.join(process.cwd(), "prompts", "tools_system.md"), "utf8");

    expect(prompt).toContain("不能只回复");
    expect(prompt).toContain("仅当对应工具出现在当前可用工具目录中");
    expect(prompt).toContain("music_get_daily_recommendations");
    expect(prompt).toContain("music_present_tracks");
    expect(prompt).toContain("不得凭记忆补全");
  });
});
