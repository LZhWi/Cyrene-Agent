import { describe, expect, it } from "vitest";
import { createUserPresenceService } from "./user-presence-service";

describe("插件用户在场服务", () => {
  it("只返回空闲秒数、锁屏状态和采集时间", async () => {
    const service = createUserPresenceService({
      getSystemIdleTime: () => 65.9,
      getSystemIdleState: () => "locked",
    }, () => Date.parse("2026-09-20T04:00:00.000Z"));
    await expect(service.snapshot()).resolves.toEqual({
      at: "2026-09-20T04:00:00.000Z",
      idleSeconds: 65,
      screenLocked: true,
    });
  });

  it("把异常负空闲值收窄为零", async () => {
    const service = createUserPresenceService({
      getSystemIdleTime: () => -1,
      getSystemIdleState: () => "active",
    });
    await expect(service.snapshot()).resolves.toMatchObject({ idleSeconds: 0, screenLocked: false });
  });
});
