use std::{
    io::{self, BufRead, BufReader, Write},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, Receiver, Sender},
    },
    thread,
};

use windows::Win32::{
    Foundation::{HWND, LPARAM, WPARAM},
    UI::WindowsAndMessaging::PostMessageW,
};

use crate::{
    WM_APP_COMMAND, WM_APP_SHUTDOWN,
    protocol::{Command, Event, MAX_NDJSON_LINE_BYTES, parse_command_line},
};

pub struct RuntimeChannels {
    pub command_rx: Receiver<Command>,
    pub event_tx: Sender<Event>,
}

#[derive(Clone)]
pub struct InputEventGate {
    inner: Arc<InputEventGateInner>,
    target: MessageTarget,
}

struct InputEventGateInner {
    closed: AtomicBool,
    wake_pending: AtomicBool,
    sender: Mutex<Option<Sender<Event>>>,
}

#[derive(Clone, Copy)]
pub struct MessageTarget(usize);

impl MessageTarget {
    pub fn new(hwnd: HWND) -> Self {
        Self(hwnd.0 as usize)
    }

    pub fn post(self, message: u32) -> windows::core::Result<()> {
        let hwnd = HWND(self.0 as *mut _);
        // SAFETY: The HWND was created before MessageTarget was published. Message
        // parameters are deliberately zero; all command data stays in the channel.
        unsafe { PostMessageW(Some(hwnd), message, WPARAM(0), LPARAM(0)) }
    }
}

pub fn create_runtime_channels() -> (RuntimeChannels, Sender<Command>, Receiver<Event>) {
    let (command_tx, command_rx) = mpsc::channel();
    let (event_tx, event_rx) = mpsc::channel();
    (
        RuntimeChannels {
            command_rx,
            event_tx,
        },
        command_tx,
        event_rx,
    )
}

pub fn create_input_event_gate(target: MessageTarget) -> (InputEventGate, Receiver<Event>) {
    let (sender, receiver) = mpsc::channel();
    (
        InputEventGate {
            inner: Arc::new(InputEventGateInner {
                closed: AtomicBool::new(false),
                wake_pending: AtomicBool::new(false),
                sender: Mutex::new(Some(sender)),
            }),
            target,
        },
        receiver,
    )
}

impl InputEventGate {
    pub fn submit(&self, event: Event) -> bool {
        if self.inner.closed.load(Ordering::Acquire) {
            return false;
        }

        let sender = self.inner.sender.lock().unwrap_or_else(|error| {
            eprintln!("input event gate mutex was poisoned; recovering");
            error.into_inner()
        });
        if self.inner.closed.load(Ordering::Acquire) {
            return false;
        }
        let submitted = sender
            .as_ref()
            .is_some_and(|sender| sender.send(event).is_ok());
        drop(sender);
        if submitted && !self.inner.wake_pending.swap(true, Ordering::AcqRel) {
            let _ = self.target.post(WM_APP_COMMAND);
        }
        submitted
    }

    pub fn prepare_to_drain(&self) {
        self.inner.wake_pending.store(false, Ordering::Release);
    }

    pub fn close(&self) {
        self.inner.closed.store(true, Ordering::Release);
        let mut sender = self.inner.sender.lock().unwrap_or_else(|error| {
            eprintln!("input event gate mutex was poisoned during close; recovering");
            error.into_inner()
        });
        sender.take();
        self.inner.wake_pending.store(false, Ordering::Release);
    }
}

pub fn spawn_stdin_reader(
    target: MessageTarget,
    command_tx: Sender<Command>,
    input_events: InputEventGate,
) {
    thread::Builder::new()
        .name("cyrene-stdin".into())
        .spawn(move || {
            let stdin = io::stdin();
            let mut reader = BufReader::new(stdin.lock());
            loop {
                match read_capped_line(&mut reader) {
                    Ok(InputLine::Line(bytes)) => {
                        let parsed = std::str::from_utf8(&bytes)
                            .map_err(|error| {
                                (
                                    "invalid-command",
                                    format!("invalid command: input is not UTF-8: {error}"),
                                )
                            })
                            .and_then(|line| {
                                parse_command_line(line)
                                    .map_err(|error| (error.code(), error.to_string()))
                            });
                        match parsed {
                            Ok(command) => {
                                let shutdown = matches!(command, Command::Shutdown);
                                if command_tx.send(command).is_err()
                                    || target.post(WM_APP_COMMAND).is_err()
                                {
                                    return;
                                }
                                if shutdown {
                                    return;
                                }
                            }
                            Err((code, message)) => {
                                if !input_events.submit(Event::Error {
                                    request_id: None,
                                    code: code.into(),
                                    message,
                                    recoverable: true,
                                }) {
                                    return;
                                }
                            }
                        }
                    }
                    Ok(InputLine::TooLong) => {
                        if !input_events.submit(Event::Error {
                            request_id: None,
                            code: "line-too-long".into(),
                            message: format!("NDJSON line exceeds {MAX_NDJSON_LINE_BYTES} bytes"),
                            recoverable: true,
                        }) {
                            return;
                        }
                    }
                    Ok(InputLine::Eof) => {
                        let _ = target.post(WM_APP_SHUTDOWN);
                        return;
                    }
                    Err(error) => {
                        eprintln!("stdin reader failed: {error}");
                        let _ = target.post(WM_APP_SHUTDOWN);
                        return;
                    }
                }
            }
        })
        .expect("failed to start stdin reader");
}

pub fn spawn_stdout_writer(event_rx: Receiver<Event>) -> thread::JoinHandle<io::Result<()>> {
    thread::Builder::new()
        .name("cyrene-stdout".into())
        .spawn(move || {
            let stdout = io::stdout();
            let mut stdout = stdout.lock();
            for event in event_rx {
                write_event(&mut stdout, &event)?;
            }
            Ok(())
        })
        .expect("failed to start stdout writer")
}

pub fn write_event(writer: &mut impl Write, event: &Event) -> io::Result<()> {
    serde_json::to_writer(&mut *writer, event).map_err(io::Error::other)?;
    writer.write_all(b"\n")?;
    writer.flush()
}

enum InputLine {
    Line(Vec<u8>),
    TooLong,
    Eof,
}

fn read_capped_line(reader: &mut impl BufRead) -> io::Result<InputLine> {
    let mut line = Vec::new();
    let mut too_long = false;

    loop {
        let available = reader.fill_buf()?;
        if available.is_empty() {
            return if too_long {
                Ok(InputLine::TooLong)
            } else if line.is_empty() {
                Ok(InputLine::Eof)
            } else {
                Ok(InputLine::Line(line))
            };
        }

        let newline = available.iter().position(|byte| *byte == b'\n');
        let content_len = newline.unwrap_or(available.len());
        if !too_long {
            if line.len() + content_len > MAX_NDJSON_LINE_BYTES {
                too_long = true;
                line.clear();
            } else {
                line.extend_from_slice(&available[..content_len]);
            }
        }
        let consumed = content_len + usize::from(newline.is_some());
        reader.consume(consumed);

        if newline.is_some() {
            if line.last() == Some(&b'\r') {
                line.pop();
            }
            return if too_long {
                Ok(InputLine::TooLong)
            } else {
                Ok(InputLine::Line(line))
            };
        }
    }
}
