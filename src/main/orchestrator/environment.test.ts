import { describe, expect, it } from "vitest";
import { buildEnvironmentContext } from "./environment";

// 这些测试验证：
// 1) 日期行与本地版一致：使用系统时区，精确时间以消息时间戳为准
// 2) 用户信息文案：除 -N 单独保留的性别约束外，与本地版字段保持一致
// 3) 手动用户时区只作为用户信息字段注入，不改变环境日期行

describe("buildEnvironmentContext timezone", () => {
  it("keeps the gender wording constraint without adding address-priority rules", () => {
    const ctx = buildEnvironmentContext(undefined, {
      callPreference: "伙伴",
      gender: "male",
    });

    expect(ctx).toContain("称呼偏好：伙伴（称呼用户时优先用这个）");
    expect(ctx).toContain("不得使用女性指向称呼");
    expect(ctx).not.toContain("称呼来源优先级");
    expect(ctx).not.toContain("重要提问或确认时，可以自然使用一次");
  });

  it("uses the system timezone/date in the environment header", () => {
    const systemTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
    const ctx = buildEnvironmentContext(undefined, { timezone: "Asia/Tokyo" });
    expect(ctx).toMatch(/- 今天日期：\d{4}-\d{2}-\d{2} [周星期]\S?/);
    expect(ctx).toContain(`（时区 ${systemTimezone}；精确的当前时间以对话消息的时间戳为准）`);
    expect(ctx).not.toContain("- 当前时间：");
  });

  it("does not add the -N-only timezone/location disclaimer", () => {
    const ctx = buildEnvironmentContext(
      undefined,
      { defaultCity: "上海", timezone: "Asia/Shanghai" },
    );
    expect(ctx).toContain("默认城市：上海");
    expect(ctx).not.toContain("用户时区仅用于时间计算");
    expect(ctx).not.toContain("不得根据时区推断用户所在城市");
  });

  it("injects a manually selected user timezone only when it differs from the system timezone", () => {
    const systemTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "unknown";
    const differentTimezone = systemTimezone === "Asia/Tokyo" ? "America/New_York" : "Asia/Tokyo";
    const same = buildEnvironmentContext(undefined, { timezone: systemTimezone });
    const different = buildEnvironmentContext(undefined, { timezone: differentTimezone });
    expect(same).not.toContain(`- 用户时区：${systemTimezone}`);
    expect(different).toContain(`- 用户时区：${differentTimezone}`);
  });
});

describe("buildEnvironmentContext tool list removal (方案 B)", () => {
  // 原实现按权限档位列三行工具清单（allow/ask/deny 三桶），用的是
  // getEnabledTools() 全量口径、无视 ToolModeOverrides——模式关掉的工具
  // 仍被"广告"给模型，调用即报 E_TOOL_UNAVAILABLE。方案 B：整段删除，
  // 工具可见性以 tools Schema + 工具目录 prompt（均已按模式过滤）为唯一口径。
  // 这里断言环境段不再出现任何工具 id 清单，防止回归。

  /** 代表性工具 id 样本：覆盖各风险级，防三行清单以任何形式回归。 */
  const REPRESENTATIVE_TOOL_IDS = [
    "run_shell",
    "write_file",
    "write_markdown",
    "str_replace",
    "apply_patch",
    "read_file",
    "search_text",
    "record_expense",
  ];

  it("does not emit any per-permission tool list lines", () => {
    const ctx = buildEnvironmentContext(undefined, undefined);
    expect(ctx).not.toContain("可直接调用的工具");
    expect(ctx).not.toContain("需先弹审批的工具");
    expect(ctx).not.toContain("被拒绝的工具");
  });

  it("does not mention any registered tool id in the environment section", () => {
    const ctx = buildEnvironmentContext(undefined, undefined);
    for (const toolId of REPRESENTATIVE_TOOL_IDS) {
      expect(ctx).not.toContain(toolId);
    }
  });

  it("keeps the permission level line and the generic rule note", () => {
    const ctx = buildEnvironmentContext(undefined, undefined);
    // 档位行保留（含 label + level），规则说明保留通用语义
    expect(ctx).toMatch(/- 文件权限档位：.+/);
    expect(ctx).toContain("工具能否调用以本轮提供的工具清单为准");
    expect(ctx).toContain("高风险操作可能触发审批确认");
  });
});
