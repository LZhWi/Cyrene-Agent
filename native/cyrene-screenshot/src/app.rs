use std::sync::mpsc::Receiver;

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
        InputGate, MessageTarget, RuntimeChannels, create_runtime_channels, spawn_stdin_reader,
        spawn_stdout_writer,
    },
    parent_watch,
    protocol::{Command, Event, InteractionStateEvent, PROTOCOL_VERSION},
    win::{
        capture::{CaptureBackend, CpuBgraFrame, FrozenFrame},
        capture_gdi::GdiCaptureBackend,
        display::{DisplayInfo, query_primary_display},
        renderer::{OverlayRenderer, present_first_frame, qpc_elapsed_ms, qpc_now},
        window::{OverlayAction, OverlayWindow},
    },
};

const WINDOW_CLASS: PCWSTR = w!("CyreneScreenshotRuntimeWindow");
const INPUT_BATCH_LIMIT: usize = 64;

pub fn run(options: CliOptions) -> Result<(), AppError> {
    let window = MessageWindow::create()?;
    let target = MessageTarget::new(window.hwnd);
    let (channels, input_gate, event_rx, input_event_rx) = create_runtime_channels(target);
    let stdout_thread = spawn_stdout_writer(event_rx);

    parent_watch::start(options.parent_pid, target);
    spawn_stdin_reader(target, input_gate.clone());
    channels
        .event_tx
        .send(Event::Ready {
            protocol_version: PROTOCOL_VERSION,
        })
        .map_err(|_| AppError::Runtime("stdout writer stopped before ready".into()))?;

    let message_result = run_message_loop(&window, &channels, &input_gate, &input_event_rx);
    for event in input_gate.close() {
        let _ = channels.event_tx.send(event);
    }
    drain_closed_input_events(&channels.event_tx, &input_event_rx);
    drop(channels);
    let stdout_result = stdout_thread
        .join()
        .map_err(|_| AppError::Runtime("stdout writer panicked".into()))?;

    message_result?;
    stdout_result?;
    Ok(())
}

fn run_message_loop(
    window: &MessageWindow,
    channels: &RuntimeChannels,
    input_gate: &InputGate,
    input_event_rx: &Receiver<Event>,
) -> Result<(), AppError> {
    let display = query_primary_display()?;
    let overlay = OverlayWindow::create(&display)?;
    let mut app_state = OverlayApp::new(display, overlay)?;
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
            let batch =
                input_gate.drain_batch(&channels.command_rx, input_event_rx, INPUT_BATCH_LIMIT);
            for event in batch.events {
                let _ = channels.event_tx.send(event);
            }
            for command in batch.commands {
                if !app_state.handle_command(command, &channels.event_tx) {
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
        app_state.process_overlay_action(&channels.event_tx);
    }
}

fn drain_closed_input_events(
    event_tx: &std::sync::mpsc::Sender<Event>,
    input_event_rx: &Receiver<Event>,
) {
    while let Ok(event) = input_event_rx.recv() {
        if event_tx.send(event).is_err() {
            return;
        }
    }
}

struct ActiveRequest {
    request_id: String,
    /// Frozen frame retained for the lifetime of the interaction. Currently
    /// unused beyond ownership (clipboard/encoder land in Task 6), but must
    /// outlive the D2D/GDI upload of its CPU pixels.
    _frame: FrozenFrame,
}

struct OverlayApp {
    display: DisplayInfo,
    overlay: OverlayWindow,
    capture: GdiCaptureBackend,
    renderer: OverlayRenderer,
    active: Option<ActiveRequest>,
}

impl OverlayApp {
    fn new(display: DisplayInfo, overlay: OverlayWindow) -> Result<Self, AppError> {
        Ok(Self {
            display,
            overlay,
            capture: GdiCaptureBackend::new()?,
            renderer: OverlayRenderer::new()?,
            active: None,
        })
    }

    fn handle_command(
        &mut self,
        command: Command,
        event_tx: &std::sync::mpsc::Sender<Event>,
    ) -> bool {
        match command {
            Command::Start { request_id, .. } => {
                if self.active.is_some() {
                    send_error(
                        event_tx,
                        Some(request_id),
                        "busy",
                        "a screenshot interaction is already active",
                        true,
                    );
                    return true;
                }

                // Measure freeze duration from the moment Start is accepted
                // (immediately before freeze begins) until DwmFlush succeeds.
                let freeze_start = qpc_now();

                // Re-query display so a prior display-changed recovery sees
                // the latest topology before freezing.
                match query_primary_display() {
                    Ok(display) => self.display = display,
                    Err(error) => {
                        send_error(
                            event_tx,
                            Some(request_id),
                            error.code(),
                            &error.to_string(),
                            true,
                        );
                        return true;
                    }
                }

                let frame = match self.capture.freeze(&self.display) {
                    Ok(frame) => frame,
                    Err(error) => {
                        send_error(
                            event_tx,
                            Some(request_id),
                            error.code(),
                            &error.to_string(),
                            true,
                        );
                        return true;
                    }
                };

                let cpu_frame = match &frame {
                    FrozenFrame::Cpu(cpu) => cpu.clone(),
                    FrozenFrame::Gpu(_) => {
                        send_error(
                            event_tx,
                            Some(request_id),
                            "not-implemented",
                            "gpu frozen frames are not supported yet",
                            true,
                        );
                        return true;
                    }
                };

                self.active = Some(ActiveRequest {
                    request_id: request_id.clone(),
                    _frame: frame,
                });
                let _ = event_tx.send(Event::Accepted {
                    request_id: request_id.clone(),
                });
                // The locked `InteractionStateEvent` enum (in `protocol.rs`) only
                // exposes `Selecting | Selected | Committing`. The internal state
                // machine here also tracks `Freezing` and `Cancelling`; those are
                // projected onto the wire by emitting `OverlayVisible` (after the
                // freeze completes) and `Cancelled` (when the user cancels),
                // respectively, so the locked protocol surface stays unchanged.
                let _ = event_tx.send(Event::InteractionState {
                    request_id: request_id.clone(),
                    state: InteractionStateEvent::Selecting,
                });

                if let Err(error) = self.present_overlay(&cpu_frame) {
                    self.finish_error(event_tx, error.code(), &error.to_string(), true);
                    return true;
                }

                let freeze_end = qpc_now();
                let freeze_duration_ms = qpc_elapsed_ms(freeze_start, freeze_end);
                let _ = event_tx.send(Event::OverlayVisible {
                    request_id,
                    freeze_duration_ms,
                });
                true
            }
            Command::Cancel { request_id } => {
                if self
                    .active
                    .as_ref()
                    .is_some_and(|active| active.request_id == request_id)
                {
                    self.cancel(event_tx, "electron-cancelled");
                } else {
                    let _ = event_tx.send(Event::Cancelled {
                        request_id,
                        reason: "no-active-capture".into(),
                    });
                }
                true
            }
            Command::Shutdown => false,
        }
    }

    /// Spec ordering for first presentation:
    /// ShowWindow / SetForegroundWindow
    /// → first paint (Direct2D or GDI fallback)
    /// → UpdateWindow
    /// → DwmFlush
    /// (caller then emits OverlayVisible)
    fn present_overlay(&mut self, frame: &CpuBgraFrame) -> Result<(), crate::error::HelperError> {
        self.renderer.clear_frozen();
        self.overlay.attach_renderer(&mut self.renderer);
        // Show first so the HWND is mapped, then size the D2D target to it.
        self.overlay.show(&self.display)?;
        self.renderer.resize(self.overlay.hwnd(), &self.display)?;
        self.renderer.upload_frozen(frame)?;
        present_first_frame(&mut self.renderer, &self.overlay, None, &self.display, None)?;
        Ok(())
    }

    fn process_overlay_action(&mut self, event_tx: &std::sync::mpsc::Sender<Event>) {
        let Some(action) = self.overlay.take_action() else {
            return;
        };
        let Some(request_id) = self.active.as_ref().map(|active| active.request_id.clone()) else {
            return;
        };
        match action {
            OverlayAction::Selected => {
                let _ = event_tx.send(Event::InteractionState {
                    request_id,
                    state: InteractionStateEvent::Selected,
                });
            }
            OverlayAction::Commit => {
                let _ = event_tx.send(Event::InteractionState {
                    request_id,
                    state: InteractionStateEvent::Committing,
                });
                self.finish_error(
                    event_tx,
                    "not-implemented",
                    "clipboard commit is not implemented",
                    true,
                );
            }
            OverlayAction::Cancel => self.cancel(event_tx, "user-cancelled"),
            OverlayAction::DisplayChanged => {
                self.finish_error(
                    event_tx,
                    "display-changed",
                    "display topology or DPI changed during capture",
                    true,
                );
            }
        }
    }

    fn cancel(&mut self, event_tx: &std::sync::mpsc::Sender<Event>, reason: &str) {
        let Some(active) = self.active.take() else {
            return;
        };
        self.teardown_overlay();
        // The internal state machine transitions through `Cancelling` before
        // reaching a terminal state, but the wire protocol surfaces a single
        // terminal `Cancelled` event (no `Cancelling` variant exists on
        // `InteractionStateEvent`).
        let _ = event_tx.send(Event::Cancelled {
            request_id: active.request_id,
            reason: reason.into(),
        });
    }

    fn finish_error(
        &mut self,
        event_tx: &std::sync::mpsc::Sender<Event>,
        code: &str,
        message: &str,
        recoverable: bool,
    ) {
        let request_id = self.active.take().map(|active| active.request_id);
        self.teardown_overlay();
        send_error(event_tx, request_id, code, message, recoverable);
    }

    fn teardown_overlay(&mut self) {
        self.overlay.detach_renderer();
        self.renderer.clear_frozen();
        let _ = self.overlay.hide();
        self.capture.invalidate();
    }
}

fn send_error(
    event_tx: &std::sync::mpsc::Sender<Event>,
    request_id: Option<String>,
    code: &str,
    message: &str,
    recoverable: bool,
) {
    let _ = event_tx.send(Event::Error {
        request_id,
        code: code.into(),
        message: message.into(),
        recoverable,
    });
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
