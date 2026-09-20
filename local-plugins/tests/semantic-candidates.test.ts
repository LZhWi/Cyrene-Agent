import { expect, it } from "vitest";
import { storedSemanticCandidates, type StoredVector } from "./support/semantic-candidates";
const sessions = [{ id: "s", messages: [
  { id: "a", role: "model" as const, content: "前文", at: 1 },
  { id: "u1", role: "user" as const, content: "喝茶", at: 2 },
  { id: "a2", role: "model" as const, content: "后文", at: 3 },
  { id: "u2", role: "user" as const, content: "咖啡", at: 4 },
] }];
const vectors: StoredVector[] = [
  { id: "m", text: "偏好", source: "user_memory", embedding: [1, 0], metadata: { l2Id: "l2" } },
  { id: "c1", text: "喝茶", source: "chat_history", embedding: [0.9, 0.1], metadata: { sessionId: "s", role: "user", ts: 2 } },
  { id: "c2", text: "咖啡", source: "chat_history", embedding: [0.2, 0.8], metadata: { sessionId: "s", role: "user", ts: 4 } },
];
it("预计算向量排序并回查正式用户消息，保留前后窗口且不改输入", () => {
  const before = JSON.stringify({ sessions, vectors });
  const result = storedSemanticCandidates("l2", vectors, sessions);
  expect(result.map((v) => v.message.id)).toEqual(["u1", "u2"]);
  expect(result[0].previous?.id).toBe("a"); expect(result[0].next?.id).toBe("a2");
  result[0].message.content = "副本"; expect(JSON.stringify({ sessions, vectors })).toBe(before);
});
it("过滤助手、陈旧、无会话和不唯一映射，不靠向量元数据凭空造消息", () => {
  const extra: StoredVector[] = [
    { id: "assistant", text: "前文", source: "chat_history", embedding: [1, 0], metadata: { sessionId: "s", role: "assistant", ts: 1 } },
    { id: "stale", text: "旧文本", source: "chat_history", embedding: [1, 0], metadata: { sessionId: "s", role: "user", ts: 2 } },
    { id: "missing", text: "喝茶", source: "chat_history", embedding: [1, 0], metadata: { sessionId: "other", role: "user", ts: 2 } },
  ];
  expect(storedSemanticCandidates("l2", [...vectors, ...extra], sessions)).toHaveLength(2);
  const duplicate = [{ id: "s", messages: [...sessions[0].messages, { id: "duplicate", role: "user" as const, content: "喝茶", at: 2 }] }];
  expect(storedSemanticCandidates("l2", vectors, duplicate).map((v) => v.message.id)).toEqual(["u2"]);
});
it("缺少L2向量返回空；非法维度、数值和上限拒绝", () => {
  expect(storedSemanticCandidates("missing", vectors, sessions)).toEqual([]);
  expect(() => storedSemanticCandidates("l2", [{ ...vectors[0], embedding: [1] }, vectors[1]], sessions)).toThrow("维度");
  expect(() => storedSemanticCandidates("l2", [vectors[0], { ...vectors[1], embedding: [NaN, 0] }], sessions)).toThrow("数值");
  expect(() => storedSemanticCandidates("l2", vectors, sessions, 21)).toThrow("参数");
});
it("同一消息重复向量只保留最高分的一条", () => {
  const duplicate = { ...vectors[1], id: "better", embedding: [1, 0] };
  const result = storedSemanticCandidates("l2", [...vectors, duplicate], sessions);
  expect(result.filter((v) => v.message.id === "u1")).toHaveLength(1);
  expect(result[0].score).toBe(1);
});
