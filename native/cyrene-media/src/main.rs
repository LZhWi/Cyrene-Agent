//! cyrene-media — background media control through Windows SMTC.
//!
//! Why this exists: QQ Music (and most Windows players) register a
//! System Media Transport Controls session. That gives transport control and
//! now-playing metadata through an official Windows API — no reverse
//! engineering, no request signing, and crucially no window activation. The
//! player never comes to the foreground.
//!
//! What SMTC deliberately does NOT give you: search, playlists, or
//! "play this specific track id". Those simply are not part of the API surface.
//! See the `search`/`play_song` note in docs — this helper reports an explicit
//! `E_UNSUPPORTED_BY_SMTC` rather than pretending.
//!
//! Protocol: one command per invocation, JSON on stdout, exit 0 always
//! (errors are JSON too, so the Node side never has to parse stderr).
//!
//! Usage:
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

/// Block on a WinRT IAsyncOperation.
///
/// windows-future 0.3 made the `Async` trait (and its `join()`) private, and
/// `IAsyncOperation::get()` no longer exists — the only public surface is
/// SetCompleted/GetResults. Rather than wire up a completion handler and a
/// channel, poll IAsyncInfo::Status: every call here is a local SMTC operation
/// that settles in single-digit milliseconds, so a short poll is simpler and
/// has no meaningful cost.
fn block<T: RuntimeType>(op: IAsyncOperation<T>) -> windows::core::Result<T> {
    let info: IAsyncInfo = op.cast()?;
    loop {
        let status = info.Status()?;
        if status == AsyncStatus::Completed {
            return op.GetResults();
        }
        if status != AsyncStatus::Started {
            // Error / Canceled: surface the real HRESULT when the op carries one.
            let hr = info.ErrorCode().unwrap_or_default();
            return Err(windows::core::Error::from(hr));
        }
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let command = args.first().map(String::as_str).unwrap_or("status");
    // `--app <id>` targets one player. Important: Cyrene plays NetEase audio
    // through mpv, which registers its own SMTC session — without targeting we
    // would happily "skip next" on ourselves.
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
    // search / playSong are the two things people always ask for first. SMTC
    // has no such capability at all, so say so precisely instead of failing
    // with something vague.
    if matches!(command, "search" | "play-song") {
        return Err(fail(
            "E_UNSUPPORTED_BY_SMTC",
            "SMTC exposes transport control and metadata only; it has no search or play-by-id",
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
            Some(app) => fail("E_PLAYER_NOT_FOUND", format!("no SMTC session for {app}")),
            None => fail("E_NO_ACTIVE_SESSION", "no media session is currently active"),
        })?;

    let result = match command {
        "next" => session.TrySkipNextAsync().and_then(block),
        "prev" => session.TrySkipPreviousAsync().and_then(block),
        "play" => session.TryPlayAsync().and_then(block),
        "pause" => session.TryPauseAsync().and_then(block),
        "toggle" => session.TryTogglePlayPauseAsync().and_then(block),
        other => {
            return Err(fail("E_UNKNOWN_COMMAND", format!("unknown command: {other}")));
        }
    }
    .map_err(|e| fail("E_SMTC_CALL_FAILED", e.message()))?;

    // The Try*Async calls return false when the player refuses the command
    // (e.g. Next on a single-track queue). Surface that honestly.
    if !result {
        return Err(fail("E_COMMAND_REJECTED", format!("player rejected: {command}")));
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

/// PlaybackStatus is a newtype over i32; its Debug form is the raw discriminant,
/// which is useless downstream. Map to the documented WinRT names.
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
            // Metadata is a separate async call and can fail independently of
            // playback info (some players populate it late).
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
