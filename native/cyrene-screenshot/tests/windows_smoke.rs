#![cfg(windows)]

use std::{
    io::{BufRead, BufReader, Write},
    os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle},
    path::PathBuf,
    process::{Child, ChildStdin, Command, ExitStatus, Stdio},
    sync::{
        Arc,
        atomic::{AtomicUsize, Ordering},
        mpsc::{self, Receiver},
    },
    thread,
    time::{Duration, Instant},
};
use windows::{
    Win32::{
        Foundation::{HANDLE, LPARAM, WPARAM},
        System::Threading::{OpenThread, ResumeThread, SuspendThread, THREAD_SUSPEND_RESUME},
        UI::{
            Input::KeyboardAndMouse::VK_RETURN,
            WindowsAndMessaging::{
                FindWindowExW, GetWindowThreadProcessId, PostMessageW, WM_KEYDOWN, WM_LBUTTONDOWN,
                WM_LBUTTONUP, WM_MOUSEMOVE,
            },
        },
    },
    core::{PCWSTR, w},
};

const READY_TIMEOUT: Duration = Duration::from_secs(3);
const EXIT_TIMEOUT: Duration = Duration::from_secs(2);
const REAP_TIMEOUT: Duration = Duration::from_secs(2);
const FLOOD_SETUP_TIMEOUT: Duration = Duration::from_secs(10);

struct ChildGuard {
    child: Child,
}

struct SuspendedThread {
    handle: OwnedHandle,
    suspended: bool,
}

impl SuspendedThread {
    fn resume(&mut self) {
        if !self.suspended {
            return;
        }
        let handle = HANDLE(self.handle.as_raw_handle());
        // SAFETY: handle owns an open thread handle with suspend/resume access.
        let previous_count = unsafe { ResumeThread(handle) };
        assert_ne!(previous_count, u32::MAX, "resume helper UI thread");
        self.suspended = false;
    }
}

impl Drop for SuspendedThread {
    fn drop(&mut self) {
        if self.suspended {
            let handle = HANDLE(self.handle.as_raw_handle());
            // SAFETY: Best-effort failure cleanup for the still-owned handle.
            let _ = unsafe { ResumeThread(handle) };
            self.suspended = false;
        }
    }
}

impl ChildGuard {
    fn new(child: Child) -> Self {
        Self { child }
    }

    fn wait_timeout(&mut self, timeout: Duration) -> Result<Option<ExitStatus>, String> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self
                .child
                .try_wait()
                .map_err(|error| format!("poll child: {error}"))?
            {
                return Ok(Some(status));
            }
            if Instant::now() >= deadline {
                return Ok(None);
            }
            thread::sleep(Duration::from_millis(10));
        }
    }

    fn terminate_and_reap(&mut self, timeout: Duration) -> Result<ExitStatus, String> {
        if let Some(status) = self.wait_timeout(Duration::ZERO)? {
            return Ok(status);
        }
        if let Err(kill_error) = self.child.kill() {
            if let Some(status) = self.wait_timeout(timeout)? {
                return Ok(status);
            }
            return Err(format!(
                "terminate child: {kill_error}; child remained live for {timeout:?}"
            ));
        }
        self.wait_timeout(timeout)?
            .ok_or_else(|| format!("child was not reaped within {timeout:?} after termination"))
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if let Err(error) = self.terminate_and_reap(REAP_TIMEOUT) {
            eprintln!("bounded child cleanup failed: {error}");
        }
    }
}

struct Helper {
    process: ChildGuard,
    stdin: Option<ChildStdin>,
    stdout_lines: Receiver<String>,
    stdout_done: Receiver<Result<(), String>>,
    observed_stdout: Vec<String>,
}

impl Helper {
    fn spawn(parent_pid: u32, protocol_version: u32) -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_cyrene-screenshot"))
            .args([
                "--output-dir",
                absolute_output_dir()
                    .to_str()
                    .expect("UTF-8 temp directory"),
                "--protocol-version",
                &protocol_version.to_string(),
                "--parent-pid",
                &parent_pid.to_string(),
            ])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .expect("spawn screenshot helper");

        let stdin = child.stdin.take().expect("helper stdin");
        let stdout = child.stdout.take().expect("helper stdout");
        let stderr = child.stderr.take().expect("helper stderr");
        let (stdout_tx, stdout_lines) = mpsc::channel();
        let (stdout_done_tx, stdout_done) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(line) => {
                        if stdout_tx.send(line).is_err() {
                            return;
                        }
                    }
                    Err(error) => {
                        drop(stdout_tx);
                        let _ = stdout_done_tx.send(Err(format!("read stdout line: {error}")));
                        return;
                    }
                }
            }
            drop(stdout_tx);
            let _ = stdout_done_tx.send(Ok(()));
        });
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines() {
                eprintln!("helper stderr: {}", line.expect("read stderr line"));
            }
        });

        Self {
            process: ChildGuard::new(child),
            stdin: Some(stdin),
            stdout_lines,
            stdout_done,
            observed_stdout: Vec::new(),
        }
    }

    fn next_event(&mut self, timeout: Duration) -> serde_json::Value {
        let line = self
            .stdout_lines
            .recv_timeout(timeout)
            .expect("helper did not emit an NDJSON line before timeout");
        let event = serde_json::from_str(&line).expect("stdout line is valid JSON");
        self.observed_stdout.push(line);
        event
    }

    fn expect_ready(&mut self) {
        assert_eq!(
            self.next_event(READY_TIMEOUT),
            serde_json::json!({"type": "ready", "protocolVersion": 1})
        );
    }

    fn finish(&mut self, timeout: Duration) -> (ExitStatus, Vec<serde_json::Value>) {
        let status = self
            .process
            .wait_timeout(timeout)
            .expect("poll helper")
            .expect("helper did not exit before timeout");
        let events = self.finish_stdout(timeout);
        (status, events)
    }

    fn finish_stdout(&mut self, timeout: Duration) -> Vec<serde_json::Value> {
        self.stdout_done
            .recv_timeout(timeout)
            .expect("stdout reader did not reach EOF before timeout")
            .expect("stdout reader failed");
        self.observed_stdout.extend(self.stdout_lines.try_iter());
        assert!(
            matches!(
                self.stdout_lines.try_recv(),
                Err(mpsc::TryRecvError::Disconnected)
            ),
            "stdout reader completed without disconnecting its line channel"
        );
        self.observed_stdout
            .iter()
            .map(|line| {
                serde_json::from_str(line)
                    .unwrap_or_else(|error| panic!("stdout was not NDJSON: {line:?}: {error}"))
            })
            .collect()
    }

    fn send_command(&mut self, command: serde_json::Value) {
        let stdin = self.stdin.as_mut().expect("helper stdin");
        serde_json::to_writer(&mut *stdin, &command).expect("serialize command");
        stdin.write_all(b"\n").expect("write command newline");
        stdin.flush().expect("flush command");
    }

    fn overlay_hwnd(&self) -> windows::Win32::Foundation::HWND {
        find_process_window(self.process.child.id(), w!("CyreneScreenshotOverlayWindow"))
    }

    fn suspend_ui_thread(&self) -> SuspendedThread {
        let hwnd =
            find_process_window(self.process.child.id(), w!("CyreneScreenshotRuntimeWindow"));
        let mut pid = 0;
        // SAFETY: pid points to writable storage and hwnd came from FindWindowExW.
        let thread_id = unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
        // SAFETY: thread_id identifies the helper UI thread that owns its message-only HWND.
        let handle = unsafe { OpenThread(THREAD_SUSPEND_RESUME, false, thread_id) }
            .expect("open helper UI thread");
        // SAFETY: OpenThread returned a newly owned handle.
        let handle = unsafe { OwnedHandle::from_raw_handle(handle.0) };
        let raw_handle = HANDLE(handle.as_raw_handle());
        // SAFETY: raw_handle remains owned for the guard lifetime.
        let previous_count = unsafe { SuspendThread(raw_handle) };
        assert_ne!(previous_count, u32::MAX, "suspend helper UI thread");
        SuspendedThread {
            handle,
            suspended: true,
        }
    }
}

fn find_process_window(process_id: u32, class_name: PCWSTR) -> windows::Win32::Foundation::HWND {
    let deadline = Instant::now() + READY_TIMEOUT;
    loop {
        let mut after = None;
        while let Ok(hwnd) = unsafe { FindWindowExW(None, after, class_name, PCWSTR::null()) } {
            let mut pid = 0;
            // SAFETY: pid points to writable storage and hwnd came from FindWindowExW.
            unsafe { GetWindowThreadProcessId(hwnd, Some(&mut pid)) };
            if pid == process_id {
                return hwnd;
            }
            after = Some(hwnd);
        }
        assert!(
            Instant::now() < deadline,
            "helper HWND for class was not found before timeout"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

fn absolute_output_dir() -> PathBuf {
    std::env::temp_dir().join("cyrene-screenshot-smoke")
}

fn ready_event() -> serde_json::Value {
    serde_json::json!({"type": "ready", "protocolVersion": 1})
}

fn start_command(request_id: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "start",
        "requestId": request_id,
        "mode": "clipboard-only"
    })
}

#[test]
fn start_emits_accepted_then_selecting_then_overlay_visible() {
    let mut helper = Helper::spawn(std::process::id(), 1);
    helper.expect_ready();
    helper.send_command(start_command("start-visible"));

    assert_eq!(
        helper.next_event(EXIT_TIMEOUT),
        serde_json::json!({"type": "accepted", "requestId": "start-visible"})
    );
    assert_eq!(
        helper.next_event(EXIT_TIMEOUT),
        serde_json::json!({
            "type": "interaction-state",
            "requestId": "start-visible",
            "state": "selecting"
        })
    );
    assert_eq!(
        helper.next_event(EXIT_TIMEOUT),
        serde_json::json!({
            "type": "overlay-visible",
            "requestId": "start-visible",
            "freezeDurationMs": 0
        })
    );
    assert!(!helper.overlay_hwnd().is_invalid());
    helper.send_command(serde_json::json!({"type": "shutdown"}));
    assert!(helper.finish(EXIT_TIMEOUT).0.success());
}

#[test]
fn escape_after_selecting_cancels() {
    let mut helper = Helper::spawn(std::process::id(), 1);
    helper.expect_ready();
    helper.send_command(start_command("cancel-one"));
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["type"], "accepted");
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["state"], "selecting");
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["type"], "overlay-visible");

    helper.send_command(serde_json::json!({
        "type": "cancel",
        "requestId": "cancel-one"
    }));
    assert_eq!(
        helper.next_event(EXIT_TIMEOUT),
        serde_json::json!({
            "type": "cancelled",
            "requestId": "cancel-one",
            "reason": "electron-cancelled"
        })
    );

    helper.send_command(start_command("cancel-two"));
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["type"], "accepted");
    helper.send_command(serde_json::json!({"type": "shutdown"}));
    assert!(helper.finish(EXIT_TIMEOUT).0.success());
}

#[test]
fn enter_after_valid_selection_emits_not_implemented() {
    let mut helper = Helper::spawn(std::process::id(), 1);
    helper.expect_ready();
    helper.send_command(start_command("commit"));
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["type"], "accepted");
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["state"], "selecting");
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["type"], "overlay-visible");

    let hwnd = helper.overlay_hwnd();
    let point = |x: i32, y: i32| {
        windows::Win32::Foundation::LPARAM(
            ((y as u32 & 0xffff) << 16 | (x as u32 & 0xffff)) as isize,
        )
    };
    unsafe {
        PostMessageW(Some(hwnd), WM_LBUTTONDOWN, WPARAM(1), point(32, 32)).unwrap();
        PostMessageW(Some(hwnd), WM_MOUSEMOVE, WPARAM(1), point(96, 96)).unwrap();
        PostMessageW(Some(hwnd), WM_LBUTTONUP, WPARAM(0), point(96, 96)).unwrap();
    }
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["state"], "selected");
    unsafe {
        PostMessageW(
            Some(hwnd),
            WM_KEYDOWN,
            WPARAM(VK_RETURN.0 as usize),
            LPARAM(0),
        )
    }
    .unwrap();
    assert_eq!(
        helper.next_event(EXIT_TIMEOUT),
        serde_json::json!({
            "type": "interaction-state",
            "requestId": "commit",
            "state": "committing"
        })
    );
    let terminal = helper.next_event(EXIT_TIMEOUT);
    assert_eq!(terminal["type"], "error");
    assert_eq!(terminal["requestId"], "commit");
    assert_eq!(terminal["code"], "not-implemented");
    helper.send_command(serde_json::json!({"type": "shutdown"}));
    assert!(helper.finish(EXIT_TIMEOUT).0.success());
}

#[test]
fn busy_start_returns_error() {
    let mut helper = Helper::spawn(std::process::id(), 1);
    helper.expect_ready();
    helper.send_command(start_command("first"));
    helper.send_command(start_command("second"));
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["requestId"], "first");
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["state"], "selecting");
    assert_eq!(helper.next_event(EXIT_TIMEOUT)["type"], "overlay-visible");
    assert_eq!(
        helper.next_event(EXIT_TIMEOUT),
        serde_json::json!({
            "type": "error",
            "requestId": "second",
            "code": "busy",
            "message": "a screenshot interaction is already active",
            "recoverable": true
        })
    );
    helper.send_command(serde_json::json!({
        "type": "cancel",
        "requestId": "first"
    }));
    assert_eq!(
        helper.next_event(EXIT_TIMEOUT)["reason"],
        "electron-cancelled"
    );
    helper.send_command(serde_json::json!({"type": "shutdown"}));
    assert!(helper.finish(EXIT_TIMEOUT).0.success());
}

#[test]
fn valid_arguments_emit_ready_within_three_seconds() {
    let mut helper = Helper::spawn(std::process::id(), 1);
    helper.expect_ready();

    helper
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"{\"type\":\"shutdown\"}\n")
        .unwrap();
    let (status, events) = helper.finish(EXIT_TIMEOUT);
    assert!(status.success());
    assert_eq!(events, [ready_event()]);
}

#[test]
fn shutdown_command_exits_successfully() {
    let mut helper = Helper::spawn(std::process::id(), 1);
    helper.expect_ready();

    let stdin = helper.stdin.as_mut().unwrap();
    stdin.write_all(b"{\"type\":\"shutdown\"}\n").unwrap();
    stdin.flush().unwrap();

    let (status, events) = helper.finish(EXIT_TIMEOUT);
    assert!(status.success());
    assert_eq!(events, [ready_event()]);
}

#[test]
fn stdin_eof_exits_within_two_seconds() {
    let mut helper = Helper::spawn(std::process::id(), 1);
    helper.expect_ready();

    drop(helper.stdin.take());

    let (status, events) = helper.finish(EXIT_TIMEOUT);
    assert!(status.success());
    assert_eq!(events, [ready_event()]);
}

#[test]
fn protocol_version_mismatch_emits_structured_error_and_exits_nonzero() {
    let mut helper = Helper::spawn(std::process::id(), 2);

    let (status, events) = helper.finish(EXIT_TIMEOUT);
    assert!(!status.success());
    assert_eq!(
        events,
        [serde_json::json!({
            "type": "error",
            "code": "protocol-version-mismatch",
            "message": "unsupported protocol version 2; expected 1",
            "recoverable": false
        })]
    );
}

#[test]
fn parent_exit_stops_helper_within_two_seconds() {
    let parent = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 30",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn disposable parent");
    let mut parent = ChildGuard::new(parent);
    let mut helper = Helper::spawn(parent.child.id(), 1);
    helper.expect_ready();

    parent
        .terminate_and_reap(REAP_TIMEOUT)
        .expect("bounded disposable parent cleanup");

    let (status, events) = helper.finish(EXIT_TIMEOUT);
    assert!(status.success());
    assert_eq!(events, [ready_event()]);
}

#[test]
fn malformed_input_emits_recoverable_error_and_keeps_running() {
    let mut helper = Helper::spawn(std::process::id(), 1);
    helper.expect_ready();

    let stdin = helper.stdin.as_mut().unwrap();
    stdin.write_all(b"not-json\n").unwrap();
    stdin.flush().unwrap();

    let error = helper.next_event(EXIT_TIMEOUT);
    assert_eq!(error["type"], "error");
    assert_eq!(error["code"], "invalid-command");
    assert_eq!(error["recoverable"], true);

    helper
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"{\"type\":\"shutdown\"}\n")
        .unwrap();
    let (status, events) = helper.finish(EXIT_TIMEOUT);
    assert!(status.success());
    assert_eq!(events.len(), 2);
    assert_eq!(events[0], ready_event());
    assert_eq!(events[1], error);
}

#[test]
fn oversized_input_emits_recoverable_error_and_keeps_running() {
    let mut helper = Helper::spawn(std::process::id(), 1);
    helper.expect_ready();

    let stdin = helper.stdin.as_mut().unwrap();
    stdin
        .write_all(&vec![
            b'x';
            cyrene_screenshot::protocol::MAX_NDJSON_LINE_BYTES + 1
        ])
        .unwrap();
    stdin.write_all(b"\n").unwrap();
    stdin.flush().unwrap();

    let error = helper.next_event(EXIT_TIMEOUT);
    assert_eq!(error["type"], "error");
    assert_eq!(error["code"], "line-too-long");
    assert_eq!(error["recoverable"], true);

    helper
        .stdin
        .as_mut()
        .unwrap()
        .write_all(b"{\"type\":\"shutdown\"}\n")
        .unwrap();
    let (status, events) = helper.finish(EXIT_TIMEOUT);
    assert!(status.success());
    assert_eq!(events.len(), 2);
    assert_eq!(events[0], ready_event());
    assert_eq!(events[1], error);
}

#[test]
fn missing_parent_is_recoverable_and_stdin_eof_still_stops_helper() {
    let mut helper = Helper::spawn(u32::MAX, 1);
    helper.expect_ready();

    drop(helper.stdin.take());

    let (status, events) = helper.finish(EXIT_TIMEOUT);
    assert!(status.success());
    assert_eq!(events, [ready_event()]);
}

#[test]
fn parent_shutdown_closes_a_continuous_error_producer_and_drains_stdout() {
    let parent = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 30",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn disposable parent");
    let mut parent = ChildGuard::new(parent);
    let mut helper = Helper::spawn(parent.child.id(), 1);
    helper.expect_ready();
    let mut suspended_ui = helper.suspend_ui_thread();

    let mut stdin = helper.stdin.take().expect("helper stdin");
    let written = Arc::new(AtomicUsize::new(0));
    let writer_count = Arc::clone(&written);
    let (writer_done_tx, writer_done_rx) = mpsc::channel();
    thread::spawn(move || {
        let batch = b"not-json\n".repeat(256);
        while stdin.write_all(&batch).is_ok() {
            writer_count.fetch_add(256, Ordering::Release);
        }
        let _ = writer_done_tx.send(());
    });

    let write_deadline = Instant::now() + EXIT_TIMEOUT;
    while written.load(Ordering::Acquire) < 8_192 && Instant::now() < write_deadline {
        thread::sleep(Duration::from_millis(5));
    }
    assert!(
        written.load(Ordering::Acquire) >= 8_192,
        "continuous input producer did not establish a backlog"
    );
    parent
        .terminate_and_reap(REAP_TIMEOUT)
        .expect("bounded disposable parent cleanup");
    thread::sleep(Duration::from_millis(50));
    suspended_ui.resume();

    let natural_exit = helper
        .process
        .wait_timeout(EXIT_TIMEOUT)
        .expect("poll helper under continuous input");
    if natural_exit.is_none() {
        helper
            .process
            .terminate_and_reap(REAP_TIMEOUT)
            .expect("bounded helper cleanup after exit timeout");
    }
    writer_done_rx
        .recv_timeout(EXIT_TIMEOUT)
        .expect("stdin flood writer did not stop before timeout");
    let events = helper.finish_stdout(EXIT_TIMEOUT);

    assert!(
        natural_exit.is_some(),
        "helper did not close the active producer and exit before timeout"
    );
    assert_eq!(events[0], ready_event());
    assert!(events.len() > 1, "expected recoverable parse errors");
    assert!(events[1..].iter().all(|event| {
        event["type"] == "error"
            && event["code"] == "invalid-command"
            && event["recoverable"] == true
    }));
}

#[test]
fn parent_shutdown_closes_a_continuous_command_producer_and_drains_stdout() {
    let parent = Command::new("powershell.exe")
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            "Start-Sleep -Seconds 30",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn disposable parent");
    let mut parent = ChildGuard::new(parent);
    let mut helper = Helper::spawn(parent.child.id(), 1);
    helper.expect_ready();
    let mut suspended_ui = helper.suspend_ui_thread();

    let mut stdin = helper.stdin.take().expect("helper stdin");
    let written = Arc::new(AtomicUsize::new(0));
    let writer_count = Arc::clone(&written);
    let (writer_done_tx, writer_done_rx) = mpsc::channel();
    thread::spawn(move || {
        let command = b"{\"type\":\"cancel\",\"requestId\":\"flood\"}\n";
        let batch = command.repeat(256);
        while stdin.write_all(&batch).is_ok() {
            writer_count.fetch_add(256, Ordering::Release);
        }
        let _ = writer_done_tx.send(());
    });

    let write_deadline = Instant::now() + FLOOD_SETUP_TIMEOUT;
    let mut last_written = 0;
    let mut last_progress = Instant::now();
    let producer_stopped_while_suspended = loop {
        let current_written = written.load(Ordering::Acquire);
        if current_written >= 32_768 {
            break false;
        }
        if writer_done_rx.try_recv().is_ok() {
            break true;
        }
        if current_written != last_written {
            last_written = current_written;
            last_progress = Instant::now();
        } else if current_written >= 4_096 && last_progress.elapsed() >= Duration::from_millis(200)
        {
            break false;
        }
        assert!(
            Instant::now() < write_deadline,
            "continuous command producer did not fill the suspended UI backlog; completed writes: {}",
            current_written
        );
        thread::sleep(Duration::from_millis(5));
    };
    assert!(
        written.load(Ordering::Acquire) >= 4_096,
        "continuous command producer did not establish a message backlog"
    );
    parent
        .terminate_and_reap(REAP_TIMEOUT)
        .expect("bounded disposable parent cleanup");
    thread::sleep(Duration::from_millis(50));
    suspended_ui.resume();

    let natural_exit = helper
        .process
        .wait_timeout(EXIT_TIMEOUT)
        .expect("poll helper under continuous commands");
    if natural_exit.is_none() {
        helper
            .process
            .terminate_and_reap(REAP_TIMEOUT)
            .expect("bounded helper cleanup after command-flood timeout");
    }
    if !producer_stopped_while_suspended {
        writer_done_rx
            .recv_timeout(EXIT_TIMEOUT)
            .expect("command flood writer did not stop before timeout");
    }
    let events = helper.finish_stdout(EXIT_TIMEOUT);

    assert!(
        natural_exit.is_some(),
        "helper did not close the command producer and exit before timeout"
    );
    assert_eq!(events[0], ready_event());
    assert!(events.len() > 1, "expected request-scoped command events");
    assert!(events[1..].iter().all(|event| {
        event["type"] == "cancelled"
            && event["requestId"] == "flood"
            && event["reason"] == "no-active-capture"
    }));
}
