import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const html = fs.readFileSync(fileURLToPath(new URL("./index.html", import.meta.url)), "utf8");

describe("memory retrieval sandbox markup", () => {
  it("provides an isolated query action and separate result regions", () => {
    expect(html).toContain('id="memory-retrieval-sandbox"');
    expect(html).toContain('id="memory-sandbox-query"');
    expect(html).toContain('id="memory-sandbox-generate-reply" type="checkbox"');
    expect(html).toContain('id="memory-sandbox-run-btn"');
    expect(html).toContain('id="memory-sandbox-baseline"');
    expect(html).toContain('id="memory-sandbox-selected"');
    expect(html).toContain('id="memory-sandbox-candidate-filter"');
    expect(html).toContain('id="memory-sandbox-candidates"');
    expect(html).toContain('id="memory-sandbox-reply"');
  });

  it("states the read-only boundary and makes the optional API cost explicit", () => {
    expect(html).toContain("不会创建会话、写入记忆、更新关系或情绪");
    expect(html).toContain("只有开启下方选项时才会调用模型并产生正常 API 用量");
    expect(html).toContain("默认关闭；关闭时只运行检索、重排与候选轨迹，不调用 LLM");
  });

  it("labels the V2 selection as the current retrieval and the legacy result as a baseline", () => {
    const currentHeading = html.indexOf("当前正式检索 Top 5");
    const selectedResults = html.indexOf('id="memory-sandbox-selected"');
    const legacyHeading = html.indexOf("旧检索基线 Top 5（仅供对照）");
    const baselineResults = html.indexOf('id="memory-sandbox-baseline"');

    expect(currentHeading).toBeGreaterThan(-1);
    expect(selectedResults).toBeGreaterThan(currentHeading);
    expect(legacyHeading).toBeGreaterThan(selectedResults);
    expect(baselineResults).toBeGreaterThan(legacyHeading);
    expect(html).not.toContain("Shadow 候选与相邻问答扩展");
  });
});
