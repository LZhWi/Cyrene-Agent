// 检测器的价值在于把三种"用不了"分开：没装 / 没开 / 控制组件缺失。
// 混成一个布尔值的话，设置页只能显示"不可用"，用户不知道该干什么。
import { describe, expect, it, vi, beforeEach } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());
const existsSyncMock = vi.hoisted(() => vi.fn(() => false));

vi.mock("node:child_process", () => ({ execFile: execFileMock }));
vi.mock("node:fs", () => ({ existsSync: existsSyncMock, default: { existsSync: existsSyncMock } }));

import { detectQQMusic } from "./qqmusic-detector";
import type { SmtcController } from "./smtc-controller";

const REG_OUTPUT = [
  "",
  "HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\QQMusic",
  "    DisplayName    REG_SZ    QQ Music",
  "    InstallLocation    REG_SZ    C:\\Program Files (x86)\\Tencent\\QQMusic",
  "    DisplayVersion    REG_SZ    21.11",
  "",
].join("\n");

/** execFile(file, args, opts, cb) —— 让 reg.exe 成功或失败。 */
function regReturns(output: string | null) {
  execFileMock.mockImplementation((_f: string, _a: string[], _o: unknown, cb: Function) => {
    if (output === null) cb(new Error("exit 1"), "", "ERROR: The system was unable to find...");
    else cb(null, output, "");
  });
}

function controller(over: Partial<SmtcController> = {}): SmtcController {
  return {
    isAvailable: () => true,
    findSession: async () => null,
    ...over,
  } as unknown as SmtcController;
}

const SESSION = {
  appId: "QQMusic.exe", playbackStatus: "Playing", isCurrent: true,
  title: "下一个天亮", artist: "郭静", album: "下一个天亮",
  canPlay: false, canPause: true, canNext: true, canPrev: true,
};

beforeEach(() => {
  execFileMock.mockReset();
  existsSyncMock.mockReset();
  existsSyncMock.mockReturnValue(false);
});

describe("detectQQMusic", () => {
  it("注册表命中时读出安装路径与版本", async () => {
    regReturns(REG_OUTPUT);
    const d = await detectQQMusic(controller());

    expect(d.installed).toBe(true);
    expect(d.version).toBe("21.11");
    expect(d.installPath).toBe("C:\\Program Files (x86)\\Tencent\\QQMusic");
  });

  it("装了但没开：running/controllable 都是 false，installed 仍是 true", async () => {
    regReturns(REG_OUTPUT);
    const d = await detectQQMusic(controller({ findSession: async () => null }));

    expect(d.installed).toBe(true);
    expect(d.running).toBe(false);
    expect(d.controllable).toBe(false);
    expect(d.nowPlaying).toBeNull();
  });

  it("装了且开着：controllable，并带出当前曲目", async () => {
    regReturns(REG_OUTPUT);
    const d = await detectQQMusic(controller({ findSession: async () => SESSION }));

    expect(d.running).toBe(true);
    expect(d.controllable).toBe(true);
    expect(d.nowPlaying).toEqual({
      title: "下一个天亮", artist: "郭静", album: "下一个天亮", status: "Playing",
    });
  });

  it("helper 缺失时即便播放器开着也不算 controllable", async () => {
    regReturns(REG_OUTPUT);
    const d = await detectQQMusic(controller({ isAvailable: () => false, findSession: async () => SESSION }));

    expect(d.helperAvailable).toBe(false);
    expect(d.controllable).toBe(false);
    // helper 没有就不该去问 SMTC
    expect(d.running).toBe(false);
  });

  it("注册表查不到时退回已知安装路径", async () => {
    regReturns(null);
    existsSyncMock.mockImplementation((p: string) => p.includes("Program Files (x86)"));

    const d = await detectQQMusic(controller());
    expect(d.installed).toBe(true);
    expect(d.installPath).toBe("C:/Program Files (x86)/Tencent/QQMusic");
    expect(d.version).toBeNull();
  });

  it("注册表和路径都没有 → 未安装", async () => {
    regReturns(null);
    const d = await detectQQMusic(controller());

    expect(d.installed).toBe(false);
    expect(d.installPath).toBeNull();
    expect(d.controllable).toBe(false);
  });

  it("SMTC 查询抛错不影响安装检测结果", async () => {
    regReturns(REG_OUTPUT);
    const d = await detectQQMusic(controller({
      findSession: async () => { throw new Error("smtc exploded"); },
    }));

    expect(d.installed).toBe(true);
    expect(d.running).toBe(false);
  });

  it("传给 reg.exe 的键名反斜杠完整（曾因转义被吃掉）", async () => {
    regReturns(REG_OUTPUT);
    await detectQQMusic(controller());

    const key = execFileMock.mock.calls[0][1][1] as string;
    expect(key).toContain("\\SOFTWARE\\Microsoft\\Windows\\");
    expect(key).not.toMatch(/HKLMSOFTWARE/);
  });
});

describe("绿色版 / 自定义安装（注册表查不到卸载项）", () => {
  it("注册表和已知路径都没有，但 SMTC 有会话 → 仍然算可控", async () => {
    // controllable 刻意不含 installed：能不能控只取决于
    // helper 在不在位 + SMTC 里有没有它的会话。
    regReturns(null);
    const d = await detectQQMusic(controller({ findSession: async () => SESSION }));

    expect(d.installed).toBe(false);
    expect(d.running).toBe(true);
    expect(d.controllable).toBe(true);
  });
});
