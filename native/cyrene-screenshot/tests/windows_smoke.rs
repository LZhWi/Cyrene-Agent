#![cfg(windows)]

use std::{
    io::{BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, ChildStdin, Command, ExitStatus, Stdio},
    sync::mpsc::{self, Receiver},
    thread,
    time::{Duration, Instant},
};

const READY_TIMEOUT: Duration = Duration::from_secs(3);
const EXIT_TIMEOUT: Duration = Duration::from_secs(2);

struct ChildGuard {
    child: Child,
}

impl ChildGuard {
    fn new(child: Child) -> Self {
        Self { child }
    }

    fn wait_timeout(&mut self, timeout: Duration) -> Option<ExitStatus> {
        let deadline = Instant::now() + timeout;
        loop {
            if let Some(status) = self.child.try_wait().expect("poll child") {
                return Some(status);
            }
            if Instant::now() >= deadline {
                return None;
            }
            thread::sleep(Duration::from_millis(10));
        }
    }
}

impl Drop for ChildGuard {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
        }
        let _ = self.child.wait();
    }
}

struct Helper {
    process: ChildGuard,
    stdin: Option<ChildStdin>,
    stdout_lines: Receiver<String>,
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
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                stdout_tx.send(line.expect("read stdout line")).ok();
            }
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
        }
    }

    fn next_event(&self, timeout: Duration) -> serde_json::Value {
        let line = self
            .stdout_lines
            .recv_timeout(timeout)
            .expect("helper did not emit an NDJSON line before timeout");
        serde_json::from_str(&line).expect("stdout line is valid JSON")
    }

    fn expect_ready(&self) {
        assert_eq!(
            self.next_event(READY_TIMEOUT),
            serde_json::json!({"type": "ready", "protocolVersion": 1})
        );
    }

    fn wait_exit(&mut self, timeout: Duration) -> ExitStatus {
        self.process
            .wait_timeout(timeout)
            .expect("helper did not exit before timeout")
    }
}

fn absolute_output_dir() -> PathBuf {
    std::env::temp_dir().join("cyrene-screenshot-smoke")
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
    assert!(helper.wait_exit(EXIT_TIMEOUT).success());
}

#[test]
fn shutdown_command_exits_successfully() {
    let mut helper = Helper::spawn(std::process::id(), 1);
    helper.expect_ready();

    let stdin = helper.stdin.as_mut().unwrap();
    stdin.write_all(b"{\"type\":\"shutdown\"}\n").unwrap();
    stdin.flush().unwrap();

    assert!(helper.wait_exit(EXIT_TIMEOUT).success());
}

#[test]
fn stdin_eof_exits_within_two_seconds() {
    let mut helper = Helper::spawn(std::process::id(), 1);
    helper.expect_ready();

    drop(helper.stdin.take());

    assert!(helper.wait_exit(EXIT_TIMEOUT).success());
}

#[test]
fn protocol_version_mismatch_emits_structured_error_and_exits_nonzero() {
    let mut helper = Helper::spawn(std::process::id(), 2);

    assert_eq!(
        helper.next_event(READY_TIMEOUT),
        serde_json::json!({
            "type": "error",
            "code": "protocol-version-mismatch",
            "message": "unsupported protocol version 2; expected 1",
            "recoverable": false
        })
    );
    assert!(!helper.wait_exit(EXIT_TIMEOUT).success());
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

    parent.child.kill().expect("terminate disposable parent");
    parent.child.wait().expect("reap disposable parent");

    assert!(helper.wait_exit(EXIT_TIMEOUT).success());
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
    assert!(helper.wait_exit(EXIT_TIMEOUT).success());
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
    assert!(helper.wait_exit(EXIT_TIMEOUT).success());
}

#[test]
fn missing_parent_is_recoverable_and_stdin_eof_still_stops_helper() {
    let mut helper = Helper::spawn(u32::MAX, 1);
    helper.expect_ready();

    drop(helper.stdin.take());

    assert!(helper.wait_exit(EXIT_TIMEOUT).success());
}
