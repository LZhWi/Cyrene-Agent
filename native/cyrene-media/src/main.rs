//! cyrene-media —— 通过 Windows SMTC 做后台媒体控制。
//!
//! 为什么需要它：QQ 音乐（以及绝大多数 Windows 播放器）都会注册一个
//! System Media Transport Controls 会话。借助这个官方 API 可以拿到传输控制和
//! 正在播放的元数据——不需要逆向、不需要请求签名，而且最关键的是不会激活窗口，
//! 播放器永远不会被带到前台。
//!
//! SMTC 刻意不提供的能力：搜索、歌单、按 ID 点播。这些压根不在它的 API 里。
//! 因此这里遇到 `search` / `play_song` 会明确返回 `E_UNSUPPORTED_BY_SMTC`，
//! 而不是含糊其辞地失败。
//!
//! 协议：一次调用执行一条命令，结果以 JSON 写到 stdout，退出码恒为 0
//! （错误也是 JSON，Node 侧永远不必去解析 stderr）。
//!
//! 用法：
//!   cyrene-media status
//!   cyrene-media next   [--app QQMusic.exe]
//!   cyrene-media prev   [--app QQMusic.exe]
//!   cyrene-media play   [--app QQMusic.exe]
//!   cyrene-media pause  [--app QQMusic.exe]
//!   cyrene-media toggle [--app QQMusic.exe]

use serde::Serialize;
use windows::core::{Interface, RuntimeType};
use windows_future::{AsyncStatus, IAsyncInfo, IAsyncOperation};
use windows::Media::Control::{
    GlobalSystemMediaTransportControlsSession as Session,
    GlobalSystemMediaTransportControlsSessionManager as SessionManager,
    GlobalSystemMediaTransportControlsSessionPlaybackStatus as PlaybackStatus,
};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct SessionInfo {
    app_id: String,
    playback_status: String,
    is_current: bool,
    title: String,
    artist: String,
    album: String,
    can_play: bool,
    can_pause: bool,
    can_next: bool,
    can_prev: bool,
}

#[derive(Serialize)]
#[serde(tag = "ok")]
enum Output {
    #[serde(rename = "true")]
    Ok { data: serde_json::Value },
    #[serde(rename = "false")]
    Err { error_code: String, message: String },
}

/// 阻塞等待一个 WinRT IAsyncOperation 完成。
///
/// windows-future 0.3 把 `Async` trait（以及它的 `join()`）改成了私有，
/// `IAsyncOperation::get()` 也不复存在——公开出来的只剩 SetCompleted/GetResults。
/// 与其架一套完成回调 + channel，这里直接轮询 IAsyncInfo::Status：
/// 本文件里每一次调用都是本机 SMTC 操作，个位数毫秒就返回，
/// 短轮询更简单，且没有实际开销。
fn block<T: RuntimeType>(op: IAsyncOperation<T>) -> windows::core::Result<T> {
    let info: IAsyncInfo = op.cast()?;
    loop {
        let status = info.Status()?;
        if status == AsyncStatus::Completed {
            return op.GetResults();
        }
        if status != AsyncStatus::Started {
            // Error / Canceled：如果操作带了 HRESULT，就把真实错误码透出去。
            let hr = info.ErrorCode().unwrap_or_default();
            return Err(windows::core::Error::from(hr));
        }
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("status");
    // `--app <id>` 用来指定目标播放器。这一点很重要：Cyrene 自己用 mpv 播放
    // 网易云，mpv 同样会注册 SMTC 会话——不指定目标的话，一句「下一首」
    // 可能跳掉的是我们自己正在放的歌。
    let target = args
        .iter()
        .position(|a| a == "--app")
        .and_then(|i| args.get(i + 1))
        .cloned();

    let out = match run(command, target.as_deref()) {
        Ok(data) => Output::Ok { data },
        Err(e) => e,
    };
    println!("{}", serde_json::to_string(&out).unwrap_or_else(|_| {
        r#"{"ok":"false","error_code":"E_SERIALIZE","message":"failed to encode result"}"#.into()
    }));
}

fn fail(code: &str, message: impl Into<String>) -> Output {
    Output::Err { error_code: code.into(), message: message.into() }
}

fn run(command: &str, target: Option<&str>) -> Result<serde_json::Value, Output> {
    // search / play-song 是所有人第一个会问的两件事，而 SMTC 完全没有这类能力。
    // 与其含糊地失败，不如把话说明白。
    if matches!(command, "search" | "play-song") {
        return Err(fail(
            "E_UNSUPPORTED_BY_SMTC",
            "SMTC 只提供传输控制与元数据，没有搜索，也没有按 ID 点播",
        ));
    }

    let manager = SessionManager::RequestAsync()
        .and_then(block)
        .map_err(|e| fail("E_SMTC_UNAVAILABLE", e.message()))?;

    if command == "status" {
        return Ok(status(&manager));
    }

    let session = pick_session(&manager, target)
        .ok_or_else(|| match target {
            Some(app) => fail("E_PLAYER_NOT_FOUND", format!("找不到 {app} 的 SMTC 会话")),
            None => fail("E_NO_ACTIVE_SESSION", "当前没有活跃的媒体会话"),
        })?;

    let result = match command {
        "next" => session.TrySkipNextAsync().and_then(block),
        "prev" => session.TrySkipPreviousAsync().and_then(block),
        "play" => session.TryPlayAsync().and_then(block),
        "pause" => session.TryPauseAsync().and_then(block),
        "toggle" => session.TryTogglePlayPauseAsync().and_then(block),
        other => {
            return Err(fail("E_UNKNOWN_COMMAND", format!("未知命令：{other}")));
        }
    }
    .map_err(|e| fail("E_SMTC_CALL_FAILED", e.message()))?;

    // Try*Async 在播放器拒绝该命令时会返回 false（例如队列里只有一首歌时按
    // 下一首）。这种情况如实上报，不要当成成功。
    if !result {
        return Err(fail("E_COMMAND_REJECTED", format!("播放器拒绝了命令：{command}")));
    }
    Ok(serde_json::json!({ "command": command, "applied": true }))
}

fn pick_session(manager: &SessionManager, target: Option<&str>) -> Option<Session> {
    match target {
        None => manager.GetCurrentSession().ok(),
        Some(app) => {
            let sessions = manager.GetSessions().ok()?;
            sessions.into_iter().find(|s| {
                s.SourceAppUserModelId()
                    .map(|id| id.to_string().eq_ignore_ascii_case(app))
                    .unwrap_or(false)
            })
        }
    }
}

/// PlaybackStatus 是 i32 的 newtype，它的 Debug 形式是原始判别值，
/// 传到下游毫无意义。这里映射成 WinRT 文档里的名称。
fn playback_status_name(v: PlaybackStatus) -> String {
    match v {
        PlaybackStatus::Closed => "Closed",
        PlaybackStatus::Opened => "Opened",
        PlaybackStatus::Changing => "Changing",
        PlaybackStatus::Stopped => "Stopped",
        PlaybackStatus::Playing => "Playing",
        PlaybackStatus::Paused => "Paused",
        _ => "Unknown",
    }
    .to_string()
}

fn status(manager: &SessionManager) -> serde_json::Value {
    let current_id = manager
        .GetCurrentSession()
        .ok()
        .and_then(|s| s.SourceAppUserModelId().ok())
        .map(|s| s.to_string());

    let mut list: Vec<SessionInfo> = Vec::new();
    if let Ok(sessions) = manager.GetSessions() {
        for s in sessions {
            let app_id = s
                .SourceAppUserModelId()
                .map(|v| v.to_string())
                .unwrap_or_default();
            let (status_text, can_play, can_pause, can_next, can_prev) = match s.GetPlaybackInfo() {
                Ok(info) => {
                    let st = info
                        .PlaybackStatus()
                        .map(playback_status_name)
                        .unwrap_or_else(|_| "Unknown".into());
                    let c = info.Controls().ok();
                    (
                        st,
                        c.as_ref().and_then(|c| c.IsPlayEnabled().ok()).unwrap_or(false),
                        c.as_ref().and_then(|c| c.IsPauseEnabled().ok()).unwrap_or(false),
                        c.as_ref().and_then(|c| c.IsNextEnabled().ok()).unwrap_or(false),
                        c.as_ref().and_then(|c| c.IsPreviousEnabled().ok()).unwrap_or(false),
                    )
                }
                Err(_) => ("Unknown".into(), false, false, false, false),
            };
            // 元数据是另一次独立的异步调用，可能与 playback info 分开失败
            // （有些播放器会晚一点才填上）。
            let (title, artist, album) = match s.TryGetMediaPropertiesAsync().and_then(block) {
                Ok(p) => (
                    p.Title().map(|v| v.to_string()).unwrap_or_default(),
                    p.Artist().map(|v| v.to_string()).unwrap_or_default(),
                    p.AlbumTitle().map(|v| v.to_string()).unwrap_or_default(),
                ),
                Err(_) => (String::new(), String::new(), String::new()),
            };
            let is_current = current_id.as_deref() == Some(app_id.as_str());
            list.push(SessionInfo {
                app_id, playback_status: status_text, is_current,
                title, artist, album,
                can_play, can_pause, can_next, can_prev,
            });
        }
    }
    serde_json::json!({ "current": current_id, "sessions": list })
}
