// 重点：默认目标必须是 QQ 音乐而不是"系统当前会话"。
// Cyrene 自己用 mpv 放网易云，mpv 同样注册 SMTC 会话——不显式指定 appId 的话
// 一句「下一首」可能把 Cyrene 自己的播放跳掉。
import { describe, expect, it, vi } from "vitest";
import { buildExternalPlayerTools } from "./external-player-tools";
import { QQ_MUSIC_APP_ID, SmtcError, type SmtcController } from "../../music/smtc-controller";

function tools(stub: Partial<SmtcController>) {
  return buildExternalPlayerTools(stub as SmtcController);
}
const byId = (list: ReturnType<typeof buildExternalPlayerTools>, id: string) =>
  list.find((t) => t.id === id)!;

describe("external_player_control", () => {
  it("默认把指令发给 QQ 音乐，不发给系统当前会话", async () => {
    const control = vi.fn(async () => {});
    const t = byId(tools({ control }), "external_player_control");

    const out = JSON.parse(await t.execute({ command: "next" }, undefined as never) as string);

    expect(control).toHaveBeenCalledWith("next", QQ_MUSIC_APP_ID);
    expect(out).toEqual({ ok: true, applied: "下一首", appId: QQ_MUSIC_APP_ID });
  });

  it("显式 appId 时按指定的来", async () => {
    const control = vi.fn(async () => {});
    const t = byId(tools({ control }), "external_player_control");

    await t.execute({ command: "pause", appId: "Spotify.exe" }, undefined as never);
    expect(control).toHaveBeenCalledWith("pause", "Spotify.exe");
  });

  it("非法指令直接拒绝，不碰 controller", async () => {
    const control = vi.fn(async () => {});
    const t = byId(tools({ control }), "external_player_control");

    const out = JSON.parse(await t.execute({ command: "seek" }, undefined as never) as string);
    expect(out.ok).toBe(false);
    expect(out.errorCode).toBe("E_INVALID_COMMAND");
    expect(control).not.toHaveBeenCalled();
  });

  it("SmtcError 变成结构化结果而不是抛出中断整轮", async () => {
    const control = vi.fn(async () => { throw new SmtcError("E_PLAYER_NOT_FOUND", "no session"); });
    const t = byId(tools({ control }), "external_player_control");

    const out = JSON.parse(await t.execute({ command: "next" }, undefined as never) as string);
    expect(out).toEqual({ ok: false, errorCode: "E_PLAYER_NOT_FOUND", message: "no session" });
  });

  it("按 input-control 归类，受权限档位管辖", () => {
    const t = byId(tools({}), "external_player_control");
    expect(t.risk).toBe("input-control");
    expect(t.effectKind).toBe("external_side_effect");
  });
});

describe("external_player_status", () => {
  it("汇总各播放器与当前曲目", async () => {
    const listSessions = vi.fn(async () => [{
      appId: "QQMusic.exe", playbackStatus: "Playing", isCurrent: true,
      title: "骄傲的少年", artist: "南征北战NZBZ", album: "6415",
      canPlay: false, canPause: true, canNext: true, canPrev: true,
    }]);
    const t = byId(tools({ listSessions }), "external_player_status");

    const out = JSON.parse(await t.execute({}, undefined as never) as string);
    expect(out.ok).toBe(true);
    expect(out.players[0].appId).toBe("QQMusic.exe");
    expect(out.players[0].track).toEqual({ title: "骄傲的少年", artist: "南征北战NZBZ", album: "6415" });
  });

  it("没有元数据时 track 为 null 而不是空字符串对象", async () => {
    const listSessions = vi.fn(async () => [{
      appId: "X.exe", playbackStatus: "Stopped", isCurrent: false,
      title: "", artist: "", album: "",
      canPlay: true, canPause: false, canNext: false, canPrev: false,
    }]);
    const t = byId(tools({ listSessions }), "external_player_status");

    const out = JSON.parse(await t.execute({}, undefined as never) as string);
    expect(out.players[0].track).toBeNull();
  });

  it("status 是只读的", () => {
    expect(byId(tools({}), "external_player_status").effectKind).toBe("read");
  });
});
