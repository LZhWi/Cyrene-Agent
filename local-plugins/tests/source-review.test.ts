import { expect, it, vi } from "vitest";
import { kimiReviewRequest, locateAndVerifySource, mergeReviewCandidates } from "./support/source-review";
const candidate = (id: string, at: number) => ({ sessionId: "s", message: { id, role: "user" as const, content: `消息${id}`, at } });
it("语义候选优先、时间候选去重，模型引用仅能选现有C编号", async () => {
  const merged = mergeReviewCandidates([{ ...candidate("a", 1), score: .9, method: "stored-vector" }, { ...candidate("b", 2), score: .8, method: "stored-vector" }], [candidate("b", 2), candidate("c", 3)]);
  expect(merged.map((c) => [c.ref, c.message.id])).toEqual([["C1", "a"], ["C2", "b"], ["C3", "c"]]);
  const generate = vi.fn().mockResolvedValueOnce('{"sourceRefs":["C1","bad","C1"],"confidence":0.9,"reason":"直接提及"}').mockResolvedValueOnce('{"supported":true,"confidence":0.95,"reason":"完整支持"}');
  const result = await locateAndVerifySource({ content: "记忆", triggerText: "片段", createdAt: 4 }, merged, generate);
  expect(result?.candidates.map((c) => c.message.id)).toEqual(["a"]);
  expect(generate).toHaveBeenCalledTimes(2);
});
it("低定位置信度或空引用不进入复核；复核不足保留未解决", async () => {
  const candidates = mergeReviewCandidates([], [candidate("a", 1)]);
  const low = vi.fn().mockResolvedValue('{"sourceRefs":["C1"],"confidence":0.84,"reason":"不确定"}');
  expect(await locateAndVerifySource({ content: "x", createdAt: 1 }, candidates, low)).toBeNull(); expect(low).toHaveBeenCalledOnce();
  const reject = vi.fn().mockResolvedValueOnce('{"sourceRefs":["C1"],"confidence":0.9,"reason":"候选"}').mockResolvedValueOnce('{"supported":false,"confidence":0.99,"reason":"仅同主题"}');
  expect(await locateAndVerifySource({ content: "x", createdAt: 1 }, candidates, reject)).toBeNull();
});
it("严格拒绝夹带文本、超长理由和错误复核结构", async () => {
  const candidates = mergeReviewCandidates([], [candidate("a", 1)]), input = { content: "x", createdAt: 1 };
  await expect(locateAndVerifySource(input, candidates, async () => '说明 {"sourceRefs":[],"confidence":1,"reason":"x"}')).rejects.toThrow("单一");
  await expect(locateAndVerifySource(input, candidates, async () => JSON.stringify({ sourceRefs: ["C1"], confidence: 1, reason: "x".repeat(501) }))).rejects.toThrow("结构");
  const badVerify = vi.fn().mockResolvedValueOnce('{"sourceRefs":["C1"],"confidence":1,"reason":"x"}').mockResolvedValueOnce('{}');
  await expect(locateAndVerifySource(input, candidates, badVerify)).rejects.toThrow("复核");
});
it("Kimi 复核请求关闭思考并要求 JSON 对象", () => {
  const body = kimiReviewRequest("kimi", [{ role: "user", content: "x" }]);
  expect(body).toMatchObject({ max_tokens: 4096, response_format: { type: "json_object" }, thinking: { type: "disabled" } });
});
