import { afterAll, afterEach, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sqliteFixture } from "../../../scripts/testing/sqlite-fixture";
import { setServiceStateProvider } from "../storage/service-state";

const location = fs.mkdtempSync(path.join(os.tmpdir(), "cyrene-call-context-test-"));
const fixture = sqliteFixture(location);
setServiceStateProvider(fixture.provider);
vi.mock("electron", () => ({ app: { getPath: () => location } }));

import { formatCallContextEvent, loadCallContextEvents, saveCallContextEvent } from "./call-context-store";

afterEach(() => {
  fixture.call("services.set", "native-call-context", "state", []);
});
afterAll(() => { fixture.close(); fs.rmSync(location, { recursive: true, force: true }); });

it("持久保存通话梗概并提供带时间的只读上下文", () => {
  const event = saveCallContextEvent({ startedAt: 1_000, endedAt: 121_000, summary: "讨论了明天的计划" });
  expect(loadCallContextEvents()).toEqual([event]);
  expect(formatCallContextEvent(event)).toContain("持续约 2 分钟");
  expect(formatCallContextEvent(event)).toContain("不是用户在当前聊天中刚刚发送的消息");
});
