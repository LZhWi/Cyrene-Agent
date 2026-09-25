import { describe, expect, it } from "vitest";
import { buildMemoryExtractionMessages, parseMemoryExtraction } from "../plugins/companion-memory/src/memory-extraction";
import { memoryCandidate } from "./support/memory-candidate";

describe("记忆提取输出契约", () => {
  it("本地提取规则使用 system 角色，-N 只读约束与动态轮次保留", () => {
    const turns = [false, false, true].map((writable, index) => ({ id: `t${index + 1}`,
      userAt: "2026-08-01T00:00:00.000Z", assistantAt: "2026-08-01T00:01:00.000Z",
      user: `第${index + 1}轮用户原话`, assistant: "好的", writable }));
    const messages = buildMemoryExtractionMessages(turns, "s");
    expect(messages.map((message) => message.role)).toEqual(["system", "user"]);
    const prompt = messages[0].content;
    expect(prompt).toContain('"importance": "low|medium|high"');
    expect(prompt).toContain('"stability": "one_off|situational|stable"');
    expect(prompt).toContain('"certainty": "explicit|inferred|uncertain"');
    expect(prompt).toContain('"attribution": "user_explicit|assistant_inferred|mixed"');
    expect(prompt).toContain('"facets": { "primaryKind":');
    expect(prompt).toContain("即使依赖某个前置条件");
    expect(prompt).toContain("必须按各轮消息时间分别解释相对时间");
    expect(prompt).toContain("T1～T3");
    expect(prompt).toContain("只读上下文只能帮助理解");
    expect(prompt).toContain("本批可写引用：T3");
    expect(messages[1].content).toContain("T1（第 1 轮，只读上下文）");
    expect(messages[1].content).toContain("T3（第 3 轮，可写）");
  });

  it("逐条过滤格式错误和不受证据支持的绝对措辞，保留同批合规候选", () => {
    expect(() => parseMemoryExtraction(JSON.stringify([memoryCandidate({ stability: "medium", importance: 0.9 })]), 1))
      .not.toThrow();
    expect(parseMemoryExtraction(JSON.stringify([memoryCandidate({ importance: 0.9 })]), 1)).toEqual([]);
    expect(parseMemoryExtraction(JSON.stringify([memoryCandidate({ stability: "medium" })]), 1)).toEqual([]);
    expect(parseMemoryExtraction(JSON.stringify([memoryCandidate(), memoryCandidate({ stability: "medium" }),
      memoryCandidate({ summary: "用户不再紧张", evidenceQuotes: ["我现在轻松些"] })]), 1)).toHaveLength(1);
    expect(parseMemoryExtraction(JSON.stringify([memoryCandidate({ shouldWrite: false })]), 1)).toEqual([]);
    expect(parseMemoryExtraction("[]", 1)).toEqual([]);
    expect(() => parseMemoryExtraction("bad-json", 1)).toThrow("JSON 无效");
  });

  it("L2 facets 形状不合格时不把模型分类当成已确认分类", () => {
    const [candidate] = parseMemoryExtraction(JSON.stringify([memoryCandidate({ layer: "L2", field: undefined,
      sourceQuote: "请叫我小林", facets: { type: "fact", retrievalKinds: ["fact"] },
    })]), 1);
    expect(candidate.facets).toEqual({ primaryKind: "other", retrievalKinds: ["other"],
      source: "pending", pendingClassification: true });
  });
});
