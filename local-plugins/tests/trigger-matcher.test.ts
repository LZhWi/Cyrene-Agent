import { expect, it } from "vitest";
import { matchTrigger, nearbyCandidates, type SourceSession } from "./support/trigger-matcher";
const session: SourceSession = { id: "s", messages: [
  { id: "a", role: "assistant", content: "上文", at: 1 },
  { id: "u", role: "user", content: "我喜欢喝茶，不喝咖啡", at: 2 },
  { id: "b", role: "assistant", content: "下文", at: 3 },
] };
it("没有记忆消息 ID 仍可唯一匹配，保留相邻消息及用户时间", () => {
  const result = matchTrigger("喜欢喝茶", [session]);
  expect(result.method).toBe("exact"); expect(result.candidates[0].message.at).toBe(2);
  expect(result.candidates[0].previous?.id).toBe("a"); expect(result.candidates[0].next?.id).toBe("b");
  result.candidates[0].message.content = "修改副本";
  expect(session.messages[1].content).toBe("我喜欢喝茶，不喝咖啡");
});
it("规范化匹配独立标记，短片段不宽松匹配，助手文本不作为命中", () => {
  expect(matchTrigger("我喜欢喝茶不喝咖啡", [session]).method).toBe("normalized-exact");
  expect(matchTrigger("茶!不", [session]).method).toBe("no-match");
  expect(matchTrigger("上文", [session]).method).toBe("no-match");
});
it("同一及不同会话的重复原文保持多候选，不拼接窗口、不用时间裁决", () => {
  const duplicate: SourceSession = { id: "other", messages: [{ ...session.messages[1], id: "other-user", at: 9 }] };
  const result = matchTrigger("喜欢喝茶", [session, duplicate]);
  expect(result.method).toBe("ambiguous"); expect(result.candidates).toHaveLength(2);
  expect(result.candidates[1].previous).toBeUndefined();
  expect(matchTrigger("上文我喜欢喝茶", [session]).method).toBe("no-match");
  expect(nearbyCandidates(9, [session, duplicate])[0].message.id).toBe("other-user");
  expect(result.method).toBe("ambiguous");
});
it("空片段与缺少历史分别报告，不凭空生成来源", () => {
  expect(matchTrigger("", [session]).method).toBe("empty-trigger");
  expect(matchTrigger("喝茶", []).method).toBe("no-history");
  expect(nearbyCandidates(NaN, [session])).toEqual([]);
});
