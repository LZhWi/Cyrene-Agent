import { describe, expect, it } from "vitest";
import { LAST_MODE_STORAGE_KEY, isKnownMode, isWorkViewMode } from "./chat-mode";

describe("chat-mode 五模式判定", () => {
  it("collab/talk/work/code/learn 都是已知模式", () => {
    for (const mode of ["collab", "talk", "work", "code", "learn"]) {
      expect(isKnownMode(mode)).toBe(true);
    }
  });

  it("脏数据与空值不认账，防止恢复时切到不存在的模式", () => {
    expect(isKnownMode(null)).toBe(false);
    expect(isKnownMode(undefined)).toBe(false);
    expect(isKnownMode("")).toBe(false);
    expect(isKnownMode("WORK")).toBe(false);
    expect(isKnownMode("daily")).toBe(false);
  });

  it("只有 work/code/learn 显示 Work 视图，collab/talk 走聊天区", () => {
    expect(isWorkViewMode("work")).toBe(true);
    expect(isWorkViewMode("code")).toBe(true);
    expect(isWorkViewMode("learn")).toBe(true);
    expect(isWorkViewMode("collab")).toBe(false);
    expect(isWorkViewMode("talk")).toBe(false);
  });

  it("持久化键保持 cyrene:last-mode（与上游约定一致，改名会丢用户偏好）", () => {
    expect(LAST_MODE_STORAGE_KEY).toBe("cyrene:last-mode");
  });
});
