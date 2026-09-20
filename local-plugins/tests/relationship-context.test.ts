import { describe, expect, it } from "vitest";
import type { Turn } from "../plugins/companion-chat/src/chat";
import { buildRelationshipContext, detectUserMood } from "../plugins/companion-memory/src/relationship-context";

function turn(id: string, user: string, at: string): Turn {
  const timestamp = new Date(at).getTime();
  return { id, sessionId: "chat", user, assistant: "收到", userAt: timestamp - 1_000, assistantAt: timestamp };
}

describe("近期关系线索", () => {
  it("复刻本地情绪判定优先级", () => {
    expect(detectUserMood("我很累，先不要追问了")).toBe("疲惫");
    expect(detectUserMood("我不喜欢弹确认卡片")).toBe("明确边界");
    expect(detectUserMood("因为喜欢你所以有点害羞")).toBe("害羞");
    expect(detectUserMood("今天挺开心的")).toBe("开心");
  });

  it("从已保存轮次只读派生最近状态、当日摘要、边界偏好与回应提示", () => {
    const result = buildRelationshipContext([
      turn("one", "今天挺开心的", "2026-09-19T10:00:00+08:00"),
      turn("two", "我不喜欢弹确认卡片，先不要再问", "2026-09-20T10:00:00+08:00"),
    ]);
    expect(result).toContain("【近期关系线索】");
    expect(result).toContain("用户最近状态：明确边界");
    expect(result).toContain("2026-09-20：用户最近状态偏「明确边界」");
    expect(result).toContain("重要互动偏好：用户明确表示不喜欢影响观感的确认卡片或过度询问。");
    expect(result).toContain("当前回应参考：不要弹确认或反复追问");
  });

  it("没有轮次时不注入，未知情绪保持自然接续", () => {
    expect(buildRelationshipContext([])).toBe("");
    expect(buildRelationshipContext([turn("one", "我们继续刚才的代码", "2026-09-20T11:00:00+08:00")]))
      .toContain("延续最近话题「我们继续刚才的代码」");
  });
});
