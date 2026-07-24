use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};

use windows::{
    Win32::{
        Foundation::{HWND, LPARAM, LRESULT, WPARAM},
        UI::WindowsAndMessaging::{
            CreateWindowExW, DefWindowProcW, DestroyWindow, DispatchMessageW, GetMessageW,
            HWND_MESSAGE, MSG, RegisterClassW, TranslateMessage, UnregisterClassW, WINDOW_EX_STYLE,
            WINDOW_STYLE, WNDCLASSW,
        },
    },
    core::{Error as WindowsError, PCWSTR, w},
};

use crate::{
    WM_APP_COMMAND, WM_APP_SHUTDOWN,
    cli::CliOptions,
    error::AppError,
    ipc::{
        MessageTarget, RuntimeChannels, create_runtime_channels, spawn_stdin_reader,
        spawn_stdout_writer,
    },
    parent_watch,
    protocol::{Command, Event, PROTOCOL_VERSION},
};

const WINDOW_CLASS: PCWSTR = w!("CyreneScreenshotRuntimeWindow");

pub fn run(options: CliOptions) -> Result<(), AppError> {
    let window = MessageWindow::create()?;
    let target = MessageTarget::new(window.hwnd);
    let (channels, command_tx, event_rx) = create_runtime_channels();
    let stopping = Arc::new(AtomicBool::new(false));
    let stdout_thread = spawn_stdout_writer(event_rx, Arc::clone(&stopping));

    parent_watch::start(options.parent_pid, target);
    spawn_stdin_reader(target, command_tx, channels.event_tx.clone());
    channels
        .event_tx
        .send(Event::Ready {
            protocol_version: PROTOCOL_VERSION,
        })
        .map_err(|_| AppError::Runtime("stdout writer stopped before ready".into()))?;

    let message_result = run_message_loop(&window, &channels);
    stopping.store(true, Ordering::Release);
    drop(channels);
    let stdout_result = stdout_thread
        .join()
        .map_err(|_| AppError::Runtime("stdout writer panicked".into()))?;

    message_result?;
    stdout_result?;
    Ok(())
}

fn run_message_loop(window: &MessageWindow, channels: &RuntimeChannels) -> Result<(), AppError> {
    let mut message = MSG::default();
    loop {
        // SAFETY: message points to initialized writable storage and the window
        // remains alive for the duration of this loop.
        let result = unsafe { GetMessageW(&mut message, None, 0, 0) }.0;
        if result == -1 {
            return Err(WindowsError::from_thread().into());
        }
        if result == 0 || message.message == WM_APP_SHUTDOWN {
            return Ok(());
        }
        if message.hwnd == window.hwnd && message.message == WM_APP_COMMAND {
            for command in channels.command_rx.try_iter() {
                if !handle_command(command, &channels.event_tx) {
                    return Ok(());
                }
            }
            continue;
        }

        // SAFETY: GetMessageW populated message with a valid message record.
        unsafe {
            let _ = TranslateMessage(&message);
            DispatchMessageW(&message);
        }
    }
}

fn handle_command(command: Command, event_tx: &std::sync::mpsc::Sender<Event>) -> bool {
    match command {
        Command::Start { request_id, .. } => {
            let _ = event_tx.send(Event::Error {
                request_id: Some(request_id),
                code: "not-implemented".into(),
                message: "graphical capture is not implemented".into(),
                recoverable: true,
            });
            true
        }
        Command::Cancel { request_id } => {
            let _ = event_tx.send(Event::Cancelled {
                request_id,
                reason: "no-active-capture".into(),
            });
            true
        }
        Command::Shutdown => false,
    }
}

struct MessageWindow {
    hwnd: HWND,
}

impl MessageWindow {
    fn create() -> Result<Self, AppError> {
        let window_class = WNDCLASSW {
            lpfnWndProc: Some(window_proc),
            lpszClassName: WINDOW_CLASS,
            ..Default::default()
        };
        // SAFETY: window_class points to valid static class-name storage and a
        // process-lifetime window procedure.
        if unsafe { RegisterClassW(&window_class) } == 0 {
            return Err(WindowsError::from_thread().into());
        }

        // SAFETY: The registered class and all optional handles remain valid;
        // HWND_MESSAGE creates a non-visible message-only window.
        let hwnd = unsafe {
            CreateWindowExW(
                WINDOW_EX_STYLE::default(),
                WINDOW_CLASS,
                w!(""),
                WINDOW_STYLE::default(),
                0,
                0,
                0,
                0,
                Some(HWND_MESSAGE),
                None,
                None,
                None,
            )
        };
        match hwnd {
            Ok(hwnd) => Ok(Self { hwnd }),
            Err(error) => {
                // SAFETY: The class was registered by this call and no window was
                // created from it.
                let _ = unsafe { UnregisterClassW(WINDOW_CLASS, None) };
                Err(error.into())
            }
        }
    }
}

impl Drop for MessageWindow {
    fn drop(&mut self) {
        // SAFETY: hwnd is owned by this UI thread and destroyed exactly once.
        let _ = unsafe { DestroyWindow(self.hwnd) };
        // SAFETY: All windows created from this process-local class are gone.
        let _ = unsafe { UnregisterClassW(WINDOW_CLASS, None) };
    }
}

unsafe extern "system" fn window_proc(
    hwnd: HWND,
    message: u32,
    wparam: WPARAM,
    lparam: LPARAM,
) -> LRESULT {
    // SAFETY: This procedure forwards untouched parameters supplied by Windows.
    unsafe { DefWindowProcW(hwnd, message, wparam, lparam) }
}
