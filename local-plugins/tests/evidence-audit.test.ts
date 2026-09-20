import { expect, it } from "vitest";
import { auditQuote } from "./support/evidence-audit";
const session = { id: "s", messages: [{ id: "u", role: "user" as const, content: "我喜欢茶，不是咖啡" }, { id: "a", role: "model" as const, content: "你永远喜欢咖啡" }] };
it("区分确切消息引用、会话匹配、助手原文及缺失引用", () => {
  expect(auditQuote("我喜欢茶", session, ["u"])).toBe("exact-user-message");
  expect(auditQuote("我喜欢茶", session)).toBe("user-session-match");
  expect(auditQuote("你永远喜欢咖啡", session, ["a"])).toBe("assistant-only");
  expect(auditQuote("我喜欢茶", session, ["missing"])).toBe("missing-message");
  expect(auditQuote("我喜欢茶", session, ["u", "missing"])).toBe("missing-message");
  expect(auditQuote("我喜欢茶", undefined)).toBe("missing-session");
});
it("不拼接多条消息、不忽略标点、不推断语义；deleted 不核验", () => {
  expect(auditQuote("我喜欢咖啡", session)).toBe("not-found");
  expect(auditQuote("我喜欢茶不是咖啡", session)).toBe("not-found");
  expect(auditQuote("", session)).toBe("empty");
  expect(auditQuote("我喜欢茶", session, undefined, true)).toBe("deleted");
});
