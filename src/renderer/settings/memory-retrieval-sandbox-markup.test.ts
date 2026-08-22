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
    expect(html).toContain('id="memory-sandbox-l2-facet-summary"');
    expect(html).toContain('id="memory-sandbox-l2-facet-results"');
    expect(html).toContain('id="memory-sandbox-candidate-filter"');
    expect(html).toContain('id="memory-sandbox-candidates"');
    expect(html).toContain('id="memory-sandbox-reply"');
  });

  it("shows the read-only L2 kind retrieval beside the existing sandbox comparisons", () => {
    expect(html).toContain("L2 记忆 · 分类检索结果");
    expect(html).toContain("语义 Top 5 + 同类标签补充");
    expect(html).toContain("不会触发旧记忆补标");
  });

  it("states the read-only boundary and makes the optional API cost explicit", () => {
    expect(html).toContain("不会创建会话、写入记忆、更新关系或情绪");
    expect(html).toContain("启用上方查询路由或开启下方模拟回复时会调用对应模型并产生正常 API 用量");
    expect(html).toContain("默认关闭；关闭时只运行检索、重排与候选轨迹，不调用 LLM");
  });

  it("provides an independent low-cost query router configuration", () => {
    expect(html).toContain('id="memory-query-router-enabled"');
    expect(html).toContain('id="memory-query-router-base-url"');
    expect(html).toContain('id="memory-query-router-api-key"');
    expect(html).toContain('id="memory-query-router-model"');
    expect(html).toContain('id="memory-query-router-save-btn"');
    expect(html).toContain('id="memory-query-router-test-btn"');
  });

  it("labels the V2 selection as the current retrieval and the legacy result as a baseline", () => {
    const currentHeading = html.indexOf('id="memory-sandbox-selected-heading"');
    const selectedResults = html.indexOf('id="memory-sandbox-selected"');
    const legacyHeading = html.indexOf("旧检索基线 Top 5（仅供对照）");
    const baselineResults = html.indexOf('id="memory-sandbox-baseline"');

    expect(currentHeading).toBeGreaterThan(-1);
    expect(html).toContain("当前正式检索（动态上限）");
    expect(selectedResults).toBeGreaterThan(currentHeading);
    expect(legacyHeading).toBeGreaterThan(selectedResults);
    expect(baselineResults).toBeGreaterThan(legacyHeading);
    expect(html).not.toContain("Shadow 候选与相邻问答扩展");
  });
});
