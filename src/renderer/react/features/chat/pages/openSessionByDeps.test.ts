import { describe, expect, it, vi } from "vitest";
import {
  normalizeSessionMode,
  openSessionByIdWithDeps,
} from "./openSessionByDeps";

describe("normalizeSessionMode", () => {
  it("合法 mode 各自归一化", () => {
    expect(normalizeSessionMode("chat")).toBe("chat");
    expect(normalizeSessionMode("work")).toBe("work");
    expect(normalizeSessionMode("code")).toBe("code");
    expect(normalizeSessionMode("daily")).toBe("daily");
  });

  it("'learn' 返回 'learn'", () => {
    expect(normalizeSessionMode("learn")).toBe("learn");
  });

  it("undefined / 未知 / 空串都返回 null", () => {
    expect(normalizeSessionMode(undefined)).toBeNull();
    expect(normalizeSessionMode("")).toBeNull();
    expect(normalizeSessionMode("foo")).toBeNull();
  });
});

describe("openSessionByIdWithDeps", () => {
  it("code 会话：selectSession(id, 'code') 被调用，返回 true", async () => {
    const selectSession = vi.fn(async () => {});
    const result = await openSessionByIdWithDeps({
      sessionId: "code-1",
      getSession: async () => ({ mode: "code" }),
      selectSession,
    });
    expect(result).toBe(true);
    expect(selectSession).toHaveBeenCalledWith("code-1", "code");
  });

  it("work 会话：selectSession(id, 'work') 被调用", async () => {
    const selectSession = vi.fn(async () => {});
    const result = await openSessionByIdWithDeps({
      sessionId: "work-1",
      getSession: async () => ({ mode: "work" }),
      selectSession,
    });
    expect(result).toBe(true);
    expect(selectSession).toHaveBeenCalledWith("work-1", "work");
  });

  it("daily 会话：selectSession(id, 'daily') 被调用", async () => {
    const selectSession = vi.fn(async () => {});
    await openSessionByIdWithDeps({
      sessionId: "daily-1",
      getSession: async () => ({ mode: "daily" }),
      selectSession,
    });
    expect(selectSession).toHaveBeenCalledWith("daily-1", "daily");
  });

  it("learn 会话：selectSession(id, 'learn') 被调用，返回 true", async () => {
    const selectSession = vi.fn(async () => {});
    const result = await openSessionByIdWithDeps({
      sessionId: "learn-1",
      getSession: async () => ({ mode: "learn" }),
      selectSession,
    });
    expect(result).toBe(true);
    expect(selectSession).toHaveBeenCalledWith("learn-1", "learn");
  });

  it("unknown / missing mode：selectSession 不被调用，返回 false", async () => {
    const selectSession = vi.fn(async () => {});
    const result = await openSessionByIdWithDeps({
      sessionId: "x-1",
      getSession: async () => ({}), // mode 缺失
      selectSession,
    });
    expect(result).toBe(false);
    expect(selectSession).not.toHaveBeenCalled();
  });

  it("会话不存在：selectSession 不被调用，返回 false", async () => {
    const selectSession = vi.fn(async () => {});
    const result = await openSessionByIdWithDeps({
      sessionId: "ghost",
      getSession: async () => null,
      selectSession,
    });
    expect(result).toBe(false);
    expect(selectSession).not.toHaveBeenCalled();
  });

  it("getSession reject：异常向上抛", async () => {
    const selectSession = vi.fn(async () => {});
    await expect(
      openSessionByIdWithDeps({
        sessionId: "x",
        getSession: async () => {
          throw new Error("disk full");
        },
        selectSession,
      }),
    ).rejects.toThrow("disk full");
    expect(selectSession).not.toHaveBeenCalled();
  });
});
