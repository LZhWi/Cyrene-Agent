// 外部播放器工具 —— 控制 QQ 音乐这类第三方播放器（后台，不弹窗）。
//
// 与 music-tools.ts 的分工：music-tools 走 MusicProvider，是"Cyrene 自己放歌"
// （网易云 OpenAPI + mpv）。这里是"遥控用户已经开着的播放器"，能力上少得多
// （没有搜索/歌单/点播，SMTC 就不提供），但换来的是零逆向、零签名、零 ToS 风险。
import type { ToolDefinition } from "./registry/tool-registry";
import { QQ_MUSIC_APP_ID, SmtcController, SmtcError, type SmtcCommand } from "../../music/smtc-controller";

/** 把 SmtcError 变成给模型看的结构化结果，而不是抛异常中断整轮。 */
function failure(e: unknown): string {
  if (e instanceof SmtcError) {
    return JSON.stringify({ ok: false, errorCode: e.code, message: e.message });
  }
  return JSON.stringify({ ok: false, errorCode: "E_UNKNOWN", message: String(e) });
}

const COMMAND_LABEL: Record<SmtcCommand, string> = {
  next: "下一首",
  prev: "上一首",
  play: "播放",
  pause: "暂停",
  toggle: "播放/暂停切换",
};

export function buildExternalPlayerTools(controller = new SmtcController()): ToolDefinition[] {
  return [
    {
      id: "external_player_status",
      capability: "external_player.status",
      name: "查询外部播放器",
      description:
        "查询系统里正在运行的外部播放器（QQ 音乐、Spotify 客户端等）及其当前曲目。" +
        "回答「QQ 音乐在放什么」这类问题用此工具。不弹窗、不打断播放、不消耗任何配额。" +
        "注意这与 music_get_playback_status 不同：那个查的是 Cyrene 自己的播放器。",
      enabled: true,
      modes: ["work", "learn"],
      risk: "safe",
      inputSchema: { type: "object", properties: {}, required: [] },
      effectKind: "read" as const,
      verificationPolicy: "none" as const,
      execute: async () => {
        try {
          const sessions = await controller.listSessions();
          return JSON.stringify({
            ok: true,
            players: sessions.map((s) => ({
              appId: s.appId,
              isCurrent: s.isCurrent,
              status: s.playbackStatus,
              track: s.title ? { title: s.title, artist: s.artist, album: s.album } : null,
              can: { play: s.canPlay, pause: s.canPause, next: s.canNext, prev: s.canPrev },
            })),
          });
        } catch (e) {
          return failure(e);
        }
      },
    },
    {
      id: "external_player_control",
      capability: "external_player.control",
      name: "控制外部播放器",
      description:
        "对外部播放器发送播放控制指令：next(下一首) / prev(上一首) / play / pause / toggle。" +
        "默认作用于 QQ 音乐。指令在后台生效，播放器窗口不会被带到前台。" +
        "只能做这五种传输控制——SMTC 不提供搜索、歌单或按 ID 点播，" +
        "需要那些能力请改用 Cyrene 自己的音乐工具（music_search / music_play_track）。",
      enabled: true,
      modes: ["work"],
      // 会改变用户正在听的东西，且是在遥控另一个应用——按 input-control 归类，
      // 于是它受权限档位管辖（read-only 档位下会被拦），这是有意的。
      risk: "input-control",
      inputSchema: {
        type: "object",
        properties: {
          command: {
            type: "string",
            enum: ["next", "prev", "play", "pause", "toggle"],
            description: "传输控制指令",
          },
          appId: {
            type: "string",
            description: `目标播放器的 AppUserModelId，缺省为 ${QQ_MUSIC_APP_ID}。可从 external_player_status 的 appId 取。`,
          },
        },
        required: ["command"],
      },
      effectKind: "external_side_effect" as const,
      verificationPolicy: "none" as const,
      execute: async (args) => {
        const command = String((args as { command?: string }).command ?? "") as SmtcCommand;
        if (!COMMAND_LABEL[command]) {
          return JSON.stringify({ ok: false, errorCode: "E_INVALID_COMMAND", message: `未知指令: ${command}` });
        }
        // 显式默认到 QQ 音乐：不指定 app 时 SMTC 作用于"当前会话"，
        // 而 Cyrene 自己的 mpv 也注册会话，可能把指令发给自己。
        const appId = String((args as { appId?: string }).appId ?? "") || QQ_MUSIC_APP_ID;
        try {
          await controller.control(command, appId);
          return JSON.stringify({ ok: true, applied: COMMAND_LABEL[command], appId });
        } catch (e) {
          return failure(e);
        }
      },
    },
  ];
}
