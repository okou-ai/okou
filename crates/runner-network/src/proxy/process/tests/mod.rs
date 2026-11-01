use super::*;
use crate::proxy::MitmUsageHandle;
use runner_host::paths::HomePaths;
use runner_host::process::{ProcessStatRead, read_process_stat_checked};
use runner_types::ids::RunId;
use std::os::unix::fs::PermissionsExt;
use tokio::io::AsyncWriteExt;
use tracing::Level;
use tracing::instrument::WithSubscriber;
use tracing_subscriber::prelude::*;
use tracing_test_support::{CapturedEvent, CapturedEvents};

static ADDON_FILES: std::sync::LazyLock<Vec<(String, String)>> =
    std::sync::LazyLock::new(load_test_addon_files);

fn load_test_addon_files() -> Vec<(String, String)> {
    let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../runner/mitm-addon/src");
    let mut files = Vec::new();
    fn collect(root: &Path, directory: &Path, files: &mut Vec<(String, String)>) {
        for entry in std::fs::read_dir(directory).expect("read addon source directory") {
            let path = entry.expect("read addon source entry").path();
            if path.is_dir() {
                let name = path
                    .file_name()
                    .and_then(|name| name.to_str())
                    .unwrap_or("");
                if name != "__pycache__" && !name.starts_with('.') {
                    collect(root, &path, files);
                }
                continue;
            }
            let name = path
                .file_name()
                .and_then(|name| name.to_str())
                .unwrap_or("");
            if path.extension().is_some_and(|extension| extension == "py")
                || ["LICENSE", "COPYING", "NOTICE"]
                    .iter()
                    .any(|prefix| name.starts_with(prefix))
            {
                let relative = path
                    .strip_prefix(root)
                    .expect("addon path under source")
                    .to_string_lossy()
                    .replace('\\', "/");
                let content = std::fs::read_to_string(&path).expect("read addon source");
                files.push((relative, content));
            }
        }
    }
    collect(&root, &root, &mut files);
    files.sort_by(|a, b| a.0.cmp(&b.0));
    files
}

async fn capture_mitmdump_monitor_events<F>(future: F) -> (F::Output, Vec<CapturedEvent>)
where
    F: std::future::Future,
{
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let output = future.with_subscriber(subscriber).await;
    (output, captured.entries())
}

fn captured_event<'a>(events: &'a [CapturedEvent], message: &str) -> &'a CapturedEvent {
    events
        .iter()
        .find(|event| {
            event
                .fields
                .get("message")
                .is_some_and(|actual| actual == message)
        })
        .unwrap_or_else(|| panic!("missing event {message}; events={events:#?}"))
}

async fn write_oversized_record_then(mut writer: tokio::io::DuplexStream, next_record: &[u8]) {
    let oversized = vec![b'x'; MITMDUMP_LOG_RECORD_MAX_BYTES + 1];
    writer.write_all(&oversized).await.unwrap();
    writer.write_all(b"\n").await.unwrap();
    writer.write_all(next_record).await.unwrap();
    writer.write_all(b"\n").await.unwrap();
}

#[tokio::test]
async fn bounded_mitmdump_reader_accepts_record_at_limit() {
    let mut input = vec![b'x'; MITMDUMP_LOG_RECORD_MAX_BYTES];
    input.push(b'\n');
    let mut reader = tokio::io::BufReader::with_capacity(1024, input.as_slice());

    let record = read_mitmdump_log_record(&mut reader).await.unwrap();

    let MitmdumpLogRecord::Line(line) = record.unwrap() else {
        panic!("record at limit should not be discarded");
    };
    assert_eq!(line.len(), MITMDUMP_LOG_RECORD_MAX_BYTES);
    assert!(line.bytes().all(|byte| byte == b'x'));
}

#[tokio::test]
async fn bounded_mitmdump_reader_finishes_oversized_record_at_eof() {
    let input = vec![b'x'; MITMDUMP_LOG_RECORD_MAX_BYTES + 1];
    let mut reader = tokio::io::BufReader::with_capacity(1024, input.as_slice());

    let record = read_mitmdump_log_record(&mut reader).await.unwrap();

    assert_eq!(
        record,
        Some(MitmdumpLogRecord::Oversized {
            observed_bytes: MITMDUMP_LOG_RECORD_MAX_BYTES + 1,
        })
    );
    assert!(
        read_mitmdump_log_record(&mut reader)
            .await
            .unwrap()
            .is_none()
    );
}

#[tokio::test]
async fn stdout_monitor_discards_oversized_record_and_recovers() {
    let (writer, reader) = tokio::io::duplex(1024);
    let future = async {
        tokio::join!(
            write_oversized_record_then(writer, b"stdout recovered"),
            monitor_mitmdump_stdout(reader),
        );
    };

    let (_, events) = capture_mitmdump_monitor_events(future).await;

    assert_eq!(
        events.len(),
        2,
        "unexpected stdout monitor events: {events:#?}"
    );
    let overflow = captured_event(&events, "discarded oversized mitmdump log record");
    assert_eq!(
        overflow.fields.get("stream").map(String::as_str),
        Some("stdout")
    );
    assert_eq!(
        overflow.fields.get("max_bytes").map(String::as_str),
        Some(MITMDUMP_LOG_RECORD_MAX_BYTES.to_string().as_str())
    );
    assert_eq!(
        overflow.fields.get("observed_bytes").map(String::as_str),
        Some((MITMDUMP_LOG_RECORD_MAX_BYTES + 1).to_string().as_str())
    );
    assert_eq!(
        overflow.fields.len(),
        4,
        "overflow event leaked record content"
    );
    let recovered = captured_event(&events, "stdout recovered");
    assert_eq!(recovered.level, Level::INFO);
}

#[tokio::test]
async fn stderr_monitor_discards_oversized_record_and_recovers() {
    let next_record = br#"VM0_ADDON_EVENT {"version":1,"level":"error","message":"failed"}"#;
    let (writer, reader) = tokio::io::duplex(1024);
    let future = async {
        let (_, port_in_use) = tokio::join!(
            write_oversized_record_then(writer, next_record),
            monitor_mitmdump_stderr(reader, 4321),
        );
        port_in_use
    };

    let (port_in_use, events) = capture_mitmdump_monitor_events(future).await;

    assert!(!port_in_use);
    assert_eq!(
        events.len(),
        2,
        "unexpected stderr monitor events: {events:#?}"
    );
    let overflow = captured_event(&events, "discarded oversized mitmdump log record");
    assert_eq!(
        overflow.fields.get("stream").map(String::as_str),
        Some("stderr")
    );
    assert_eq!(
        overflow.fields.get("observed_bytes").map(String::as_str),
        Some((MITMDUMP_LOG_RECORD_MAX_BYTES + 1).to_string().as_str())
    );
    assert_eq!(
        overflow.fields.len(),
        4,
        "overflow event leaked record content"
    );

    let recovered = events
        .iter()
        .find(|event| event.level == Level::ERROR)
        .unwrap_or_else(|| panic!("missing recovered addon event; events={events:#?}"));
    assert_eq!(
        recovered.fields.len(),
        1,
        "unexpected fields: {recovered:#?}"
    );
    assert_eq!(
        serde_json::from_str::<serde_json::Value>(
            recovered
                .fields
                .get("message")
                .expect("recovered addon event should have a message"),
        )
        .expect("recovered addon event should contain a JSON log"),
        serde_json::json!({"level": "error", "message": "failed"})
    );
}

fn with_addon_python(script: &str) -> String {
    let python =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../runner/mitm-addon/.venv/bin/python");
    let quoted_python = format!("'{}'", python.to_str().unwrap().replace('\'', "'\\''"));
    script.replace("@ADDON_PYTHON@", &quoted_python).replace(
        "@ADDON_REGISTRY_OWNER@",
        r#"import asyncio
import os
import socket
import threading
from types import SimpleNamespace
from mitmproxy import ctx
from registry_control import RegistryControl

def option(name):
    return next(argument.split('=', 1)[1] for argument in sys.argv if argument.startswith(name + '='))

ctx.options = SimpleNamespace(okou_builtin_firewall_catalog_cache_path=option('okou_builtin_firewall_catalog_cache_path'))
catalog_path = Path(option('okou_builtin_firewall_catalog_cache_path'))
gate_path = catalog_path.with_suffix('.gate')
if gate_path.exists():
    catalog_inode = catalog_path.stat().st_ino
    original_read = os.read
    gate_armed = True

    def read_catalog(fd, size):
        global gate_armed
        if gate_armed and os.fstat(fd).st_ino == catalog_inode:
            gate_armed = False
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as peer:
                peer.settimeout(5)
                peer.connect(str(gate_path))
                peer.sendall(b'loading')
                assert peer.recv(1) == b'!'
        return original_read(fd, size)

    os.read = read_catalog
owner_loop = asyncio.new_event_loop()
threading.Thread(target=owner_loop.run_forever, daemon=True).start()
registry_owner = RegistryControl(owner_loop, option('okou_proxy_registry_path'))
"#,
    )
}

fn write_fake_listening_mitmdump(path: &Path) {
    std::fs::write(
        path,
        with_addon_python(
            r#"#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$@" > "$0.args"
printf '%s\n%s\n' "$TMPDIR" "$OKOU_MITMDUMP_RUNTIME_DIR" > "$0.env"
cp -f "/proc/$$/environ" "$0.environ"
port=""
control_dir=""
usage_state_id=""
prev=""
for arg in "$@"; do
  if [ "$prev" = "--listen-port" ]; then
    port="$arg"
  fi
  case "$arg" in
    okou_control_socket_dir=*) control_dir="${arg#okou_control_socket_dir=}" ;;
    okou_usage_state_id=*) usage_state_id="${arg#okou_usage_state_id=}" ;;
  esac
  prev="$arg"
done
exec @ADDON_PYTHON@ - "$port" "$control_dir" "$usage_state_id" "$@" <<'PY'
import socket
import sys
from pathlib import Path

port = int(sys.argv[1])
control_dir = Path(sys.argv[2])
sock = socket.socket()
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
try:
    sock.bind(("127.0.0.1", port))
except OSError as error:
    print(
        f"Transparent Proxy failed to listen on *:{port}: {error}",
        file=sys.stderr,
    )
    raise SystemExit(1) from error
sock.listen(1)
sys.path.insert(0, str(Path(sys.argv[sys.argv.index("--scripts") + 1]).parent))
from runner_control import ControlServer
@ADDON_REGISTRY_OWNER@
control = ControlServer(control_dir, sys.argv[3], registry_owner)
control.start()
while True:
    conn, _ = sock.accept()
    conn.close()
PY
"#,
        ),
    )
    .unwrap();
    let mut perms = std::fs::metadata(path).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(path, perms).unwrap();
}

fn write_forking_ready_mitmdump(path: &Path) {
    std::fs::write(
        path,
        with_addon_python(
            r#"#!/usr/bin/env bash
set -euo pipefail
printf '%s\n%s\n' "$TMPDIR" "$OKOU_MITMDUMP_RUNTIME_DIR" > "$0.env"
control_dir=""
usage_state_id=""
for arg in "$@"; do
  case "$arg" in
    okou_control_socket_dir=*) control_dir="${arg#okou_control_socket_dir=}" ;;
    okou_usage_state_id=*) usage_state_id="${arg#okou_usage_state_id=}" ;;
  esac
done
@ADDON_PYTHON@ - "$control_dir" "$usage_state_id" "$0.descendant" "$@" <<'PY' &
import os
import signal
import sys
from pathlib import Path

for handled in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
    signal.signal(handled, signal.SIG_IGN)
Path(sys.argv[3]).write_text(str(os.getpid()), encoding="utf-8")
control_dir = Path(sys.argv[1])
sys.path.insert(0, str(Path(sys.argv[sys.argv.index("--scripts") + 1]).parent))
from runner_control import ControlServer
@ADDON_REGISTRY_OWNER@
control = ControlServer(control_dir, sys.argv[2], registry_owner)
control.start()
while True:
    signal.pause()
PY
wait "$!"
"#,
        ),
    )
    .unwrap();
    let mut perms = std::fs::metadata(path).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(path, perms).unwrap();
}

fn write_graceful_parent_with_descendant_mitmdump(path: &Path) {
    std::fs::write(
        path,
        with_addon_python(
            r#"#!/usr/bin/env bash
exec @ADDON_PYTHON@ - "$0" "$@" <<'PY'
import os
import signal
import socket
import sys
import time
from pathlib import Path

sys.argv = sys.argv[1:]
Path(f"{sys.argv[0]}.env").write_text(
    f"{os.environ['TMPDIR']}\n"
    f"{os.environ['OKOU_MITMDUMP_RUNTIME_DIR']}\n",
    encoding="utf-8",
)
port = None
control_dir = None
usage_state_id = None
previous = None
for argument in sys.argv[1:]:
    if previous == "--listen-port":
        port = int(argument)
    if argument.startswith("okou_control_socket_dir="):
        control_dir = Path(argument.removeprefix("okou_control_socket_dir="))
    if argument.startswith("okou_usage_state_id="):
        usage_state_id = argument.removeprefix("okou_usage_state_id=")
    previous = argument

descendant_pid = os.fork()
if descendant_pid == 0:
    for handled in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
        signal.signal(handled, signal.SIG_IGN)
    Path(f"{sys.argv[0]}.descendant").write_text(
        str(os.getpid()), encoding="utf-8"
    )
    while True:
        time.sleep(60)

signal.signal(signal.SIGTERM, lambda _signum, _frame: sys.exit(0))
sock = socket.socket()
sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
sock.bind(("127.0.0.1", port))
sock.listen(1)
sys.path.insert(0, str(Path(sys.argv[sys.argv.index("--scripts") + 1]).parent))
from runner_control import ControlServer
@ADDON_REGISTRY_OWNER@
control = ControlServer(control_dir, usage_state_id, registry_owner)
control.start()
while True:
    connection, _ = sock.accept()
    connection.close()
PY
"#,
        ),
    )
    .unwrap();
    let mut perms = std::fs::metadata(path).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(path, perms).unwrap();
}

fn write_forking_failing_mitmdump(path: &Path) {
    std::fs::write(
        path,
        with_addon_python(
            r#"#!/usr/bin/env bash
set -euo pipefail
printf '%s\n%s\n' "$TMPDIR" "$OKOU_MITMDUMP_RUNTIME_DIR" > "$0.env"
printf 'attempt\n' >> "$0.attempts"
@ADDON_PYTHON@ - "$0.descendant" <<'PY' &
import os
import signal
import sys
import time
from pathlib import Path

for handled in (signal.SIGHUP, signal.SIGINT, signal.SIGTERM):
    signal.signal(handled, signal.SIG_IGN)
Path(sys.argv[1]).write_text(str(os.getpid()), encoding="utf-8")
while True:
    time.sleep(60)
PY
while [ ! -s "$0.descendant" ]; do
  sleep 0.01
done
printf 'addon warning: address already in use\n' >&2
exit 42
"#,
        ),
    )
    .unwrap();
    let mut perms = std::fs::metadata(path).unwrap().permissions();
    perms.set_mode(0o755);
    std::fs::set_permissions(path, perms).unwrap();
}

#[tokio::test]
async fn retry_text_busy_spawn_retries_text_busy_errors() {
    let spawn_calls = std::cell::Cell::new(0usize);
    let retry_count = std::cell::Cell::new(0usize);
    let spawned = retry_text_busy_spawn(
        Path::new("fake-mitmdump"),
        Duration::ZERO,
        || {
            let calls = spawn_calls.get() + 1;
            spawn_calls.set(calls);
            if calls == 1 {
                Err(std::io::Error::from_raw_os_error(nix::libc::ETXTBSY))
            } else {
                Ok("spawned")
            }
        },
        |attempt, error| {
            assert!(is_text_file_busy(error), "unexpected retry error: {error}");
            retry_count.set(attempt);
        },
    )
    .await
    .unwrap();

    assert_eq!(spawned, "spawned");
    assert_eq!(spawn_calls.get(), 2);
    assert_eq!(retry_count.get(), 1);
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn retry_text_busy_spawn_does_not_retry_other_errors() {
    let spawn_calls = std::cell::Cell::new(0usize);
    let retry_count = std::cell::Cell::new(0usize);
    let error = retry_text_busy_spawn::<()>(
        Path::new("fake-mitmdump"),
        Duration::ZERO,
        || {
            spawn_calls.set(spawn_calls.get() + 1);
            Err(std::io::Error::from_raw_os_error(nix::libc::ENOENT))
        },
        |_attempt, _error| retry_count.set(retry_count.get() + 1),
    )
    .await
    .unwrap_err();

    assert_eq!(spawn_calls.get(), 1);
    assert_eq!(retry_count.get(), 0);
    assert!(
        error.to_string().contains("spawn mitmdump fake-mitmdump"),
        "unexpected error: {error}",
    );
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn retry_text_busy_spawn_stops_after_retry_limit() {
    let spawn_calls = std::cell::Cell::new(0usize);
    let last_retry_attempt = std::cell::Cell::new(0usize);
    let error = retry_text_busy_spawn::<()>(
        Path::new("fake-mitmdump"),
        Duration::ZERO,
        || {
            spawn_calls.set(spawn_calls.get() + 1);
            Err(std::io::Error::from_raw_os_error(nix::libc::ETXTBSY))
        },
        |attempt, error| {
            assert!(is_text_file_busy(error), "unexpected retry error: {error}");
            last_retry_attempt.set(attempt);
        },
    )
    .await
    .unwrap_err();

    assert_eq!(spawn_calls.get(), TEXT_BUSY_SPAWN_MAX_RETRIES + 1);
    assert_eq!(last_retry_attempt.get(), TEXT_BUSY_SPAWN_MAX_RETRIES);
    assert!(
        error.to_string().contains("spawn mitmdump fake-mitmdump"),
        "unexpected error: {error}",
    );
}

async fn wait_for_reaped_pid(pid: u32, starttime: u64) -> bool {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            // Observing must not reap the child on behalf of its owner.
            match read_process_stat_checked(pid).await {
                ProcessStatRead::Found(stat) if stat.starttime == starttime => {}
                ProcessStatRead::Found(_) | ProcessStatRead::Missing => return,
                observation => panic!("cannot observe pid {pid} being reaped: {observation:?}"),
            }
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .is_ok()
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn wait_for_reaped_pid_leaves_zombie_for_owner() {
    struct UnreapedChild(std::process::Child);

    impl Drop for UnreapedChild {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    // A standard-library child has no async reaper that could mask a bad observer.
    let mut child = UnreapedChild(
        std::process::Command::new("sh")
            .args(["-c", "exit 23"])
            .spawn()
            .unwrap(),
    );
    let pid = child.0.id();
    let ProcessStatRead::Found(initial_stat) = read_process_stat_checked(pid).await else {
        panic!("child process stat is unavailable for pid {pid}");
    };
    let starttime = initial_stat.starttime;
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match read_process_stat_checked(pid).await {
                ProcessStatRead::Found(stat) if stat.starttime == starttime => {
                    if stat.state == 'Z' {
                        return;
                    }
                }
                observation => panic!("cannot observe zombie pid {pid}: {observation:?}"),
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("child should exit without being reaped");

    assert!(
        !wait_for_reaped_pid(pid, starttime).await,
        "a matching zombie must not be reported as reaped"
    );
    let status = child
        .0
        .try_wait()
        .expect("observation must leave the exit status available to the owner")
        .expect("the zombie child has already exited");
    assert_eq!(status.code(), Some(23));
    assert!(
        wait_for_reaped_pid(pid, starttime).await,
        "observation should succeed after the owner reaps the child"
    );
}

async fn wait_for_pid_absent(pid: u32) -> bool {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match runner_host::process::read_process_stat(pid).await {
                Some(stat) if runner_host::process::process_stat_is_live(&stat) => {
                    tokio::time::sleep(Duration::from_millis(20)).await;
                }
                Some(_) | None => return,
            }
        }
    })
    .await
    .is_ok()
}

async fn wait_for_pid_file(path: &Path) -> u32 {
    let mut last_observation = "no read completed".to_string();
    let result = tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            match tokio::fs::read_to_string(path).await {
                Ok(contents) => match contents.parse::<u32>() {
                    Ok(pid) => return pid,
                    Err(error) => {
                        last_observation =
                            format!("contents {contents:?} did not parse as a PID: {error}");
                    }
                },
                Err(error) => {
                    last_observation = format!("read failed: {error}");
                }
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await;
    result.unwrap_or_else(|_| {
        panic!(
            "timed out waiting for PID in {}: {last_observation}",
            path.display()
        )
    })
}

async fn acquire_test_runtime(config: &ProxyConfig) -> Arc<MitmdumpRuntime> {
    tokio::fs::create_dir_all(&config.addon_dir).await.unwrap();
    for (name, content) in ADDON_FILES.iter() {
        tokio::fs::create_dir_all(config.addon_dir.join(name).parent().unwrap())
            .await
            .unwrap();
        tokio::fs::write(config.addon_dir.join(name), content)
            .await
            .unwrap();
    }
    MitmdumpRuntime::acquire(config.runtime_dir.clone(), config.runtime_lock_path.clone())
        .await
        .unwrap()
}

fn test_proxy_config(root: &Path, home: &HomePaths, mitmdump_bin: PathBuf) -> ProxyConfig {
    ProxyConfig {
        mitmdump_bin,
        ca_dir: home.ca_dir(),
        ca_lock_path: home.ca_lock(),
        addon_dir: root.join("addon"),
        registry_path: root.join("proxy-registry.json"),
        registry_lock_path: root.join("proxy-registry.json.lock"),
        builtin_firewall_catalog_cache_path: root.join("builtin-firewall-catalog-cache.json"),
        runtime_dir: root.join("mitmdump-runtime"),
        runtime_lock_path: root.join("mitmdump-runtime.lock"),
        api_url: None,
        client_session_id: "runner-session-test".to_string(),
        client_version: "test-runner-version",
    }
}

async fn assert_no_launch_dirs(runtime_dir: &Path) {
    let mut entries = tokio::fs::read_dir(runtime_dir).await.unwrap();
    while let Some(entry) = entries.next_entry().await.unwrap() {
        assert!(
            !entry.file_name().as_encoded_bytes().starts_with(b"launch-"),
            "unexpected live launch directory: {}",
            entry.path().display()
        );
    }
}

async fn wait_for_path_absent(path: &Path) -> bool {
    tokio::time::timeout(Duration::from_secs(2), async {
        while tokio::fs::try_exists(path).await.unwrap_or(false) {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    })
    .await
    .is_ok()
}

#[tokio::test]
async fn initial_start_retries_an_occupied_selected_port() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    crate::ca::ensure(&home).await.unwrap();
    let fake_mitmdump = dir.path().join("fake-mitmdump");
    write_fake_listening_mitmdump(&fake_mitmdump);
    let config = test_proxy_config(dir.path(), &home, fake_mitmdump);
    let (mut proxy, mut crash_rx) = MitmProxy::new(config, ADDON_FILES.as_slice())
        .await
        .unwrap();
    let occupied_port = proxy.port();
    let unrelated_listener = tokio::net::TcpListener::bind(("0.0.0.0", occupied_port))
        .await
        .unwrap();

    proxy.start().await.unwrap();

    assert_ne!(proxy.port(), occupied_port);
    tokio::net::TcpStream::connect(("127.0.0.1", proxy.port()))
        .await
        .unwrap();
    assert!(
        matches!(
            crash_rx.try_recv(),
            Err(tokio::sync::mpsc::error::TryRecvError::Empty)
        ),
        "failed startup attempt must not report a crash after retry"
    );

    proxy.stop().await.unwrap();
    drop(unrelated_listener);
}

#[tokio::test]
async fn initial_and_replacement_readiness_join_catalog_initialization() {
    use tokio::io::AsyncReadExt;

    let directory = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(directory.path().join("home"));
    crate::ca::ensure(&home).await.unwrap();
    let executable = directory.path().join("fake-mitmdump");
    write_fake_listening_mitmdump(&executable);
    let config = test_proxy_config(directory.path(), &home, executable);
    let cache = config.builtin_firewall_catalog_cache_path.clone();
    let gate = tokio::net::UnixListener::bind(cache.with_extension("gate")).unwrap();
    let (mut proxy, _crashes) = MitmProxy::new(config, ADDON_FILES.as_slice())
        .await
        .unwrap();
    runner_host::state_file::write_private_atomic(
        &cache,
        serde_json::to_vec(&serde_json::json!({
            "schemaVersion": 1, "catalogDigest": format!("sha256:{}", "a".repeat(64)),
            "catalogVersion": "catalog-a", "updatedAt": "2026-11-01T00:00:00Z",
            "firewalls": {"example": {"name": "example", "apis": [{
                "base": "https://example.com", "auth": {"headers": {}}, "permissions": []
            }]}}
        }))
        .unwrap()
        .as_slice(),
    )
    .await
    .unwrap();

    for replacement in [false, true] {
        let port = proxy.port();
        let task = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(async move {
            if replacement {
                let child = proxy.begin_restart().spawn().await.unwrap();
                proxy.complete_restart(child);
            } else {
                proxy.start().await.unwrap();
            }
            proxy
        }));
        let (mut peer, _) = tokio::time::timeout(Duration::from_secs(5), gate.accept())
            .await
            .unwrap()
            .unwrap();
        let mut marker = [0; 7];
        peer.read_exact(&mut marker).await.unwrap();
        assert_eq!(&marker, b"loading");
        // Listener availability alone must not release initial or replacement readiness.
        tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        assert!(!task.is_finished());
        peer.write_all(b"!").await.unwrap();
        proxy = tokio::time::timeout(Duration::from_secs(5), task.detach())
            .await
            .unwrap()
            .unwrap();
    }
    proxy.stop().await.unwrap();
}

#[tokio::test]
async fn mitm_proxy_new_fails_when_stale_addon_dir_cleanup_fails() {
    let dir = tempfile::tempdir().unwrap();
    let addon_dir = dir.path().join("addon");
    tokio::fs::write(&addon_dir, b"not a directory")
        .await
        .unwrap();
    let config = ProxyConfig {
        mitmdump_bin: dir.path().join("mitmdump"),
        ca_dir: dir.path().join("ca"),
        ca_lock_path: dir.path().join("ca.lock"),
        addon_dir: addon_dir.clone(),
        registry_path: dir.path().join("proxy-registry.json"),
        registry_lock_path: dir.path().join("proxy-registry.json.lock"),
        builtin_firewall_catalog_cache_path: dir.path().join("builtin-firewall-catalog-cache.json"),
        runtime_dir: dir.path().join("mitmdump-runtime"),
        runtime_lock_path: dir.path().join("mitmdump-runtime.lock"),
        api_url: None,
        client_session_id: "runner-session-test".to_string(),
        client_version: "test-runner-version",
    };

    let result = MitmProxy::new(config, ADDON_FILES.as_slice()).await;

    let error = result.err().expect("expected addon cleanup failure");
    assert!(
        error.to_string().contains("remove stale addon dir"),
        "unexpected error: {error}"
    );
    assert_eq!(
        tokio::fs::read(&addon_dir).await.unwrap(),
        b"not a directory"
    );
}

#[tokio::test]
async fn mitm_proxy_new_succeeds_when_addon_dir_is_missing() {
    let dir = tempfile::tempdir().unwrap();
    let addon_dir = dir.path().join("addon");
    let registry_path = dir.path().join("proxy-registry.json");
    let config = ProxyConfig {
        mitmdump_bin: dir.path().join("mitmdump"),
        ca_dir: dir.path().join("ca"),
        ca_lock_path: dir.path().join("ca.lock"),
        addon_dir: addon_dir.clone(),
        registry_path: registry_path.clone(),
        registry_lock_path: dir.path().join("proxy-registry.json.lock"),
        builtin_firewall_catalog_cache_path: dir.path().join("builtin-firewall-catalog-cache.json"),
        runtime_dir: dir.path().join("mitmdump-runtime"),
        runtime_lock_path: dir.path().join("mitmdump-runtime.lock"),
        api_url: None,
        client_session_id: "runner-session-test".to_string(),
        client_version: "test-runner-version",
    };

    let (_proxy, _crash_rx) = MitmProxy::new(config, ADDON_FILES.as_slice())
        .await
        .unwrap();

    assert!(addon_dir.join("mitm_addon.py").is_file());
    let raw = tokio::fs::read_to_string(&registry_path).await.unwrap();
    let registry: serde_json::Value = serde_json::from_str(&raw).unwrap();
    assert_eq!(registry["sandboxes"], serde_json::json!({}));
}

#[tokio::test]
async fn wait_for_ready_returns_error_on_timeout() {
    // `sleep` never listens on TCP — guarantees timeout.
    let mut child = tokio::process::Command::new("sleep")
        .arg("60")
        .kill_on_drop(true)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();

    let raw_pid = child.id().unwrap() as i32;
    let pid = nix::unistd::Pid::from_raw(raw_pid);
    let port = find_available_port().unwrap();
    let dir = tempfile::tempdir().unwrap();

    let result = wait_for_ready(
        &mut child,
        port,
        dir.path(),
        "usage-state-test",
        Duration::from_millis(500),
    )
    .await;
    assert!(result.is_err());

    // Process must still be alive — wait_for_ready does NOT kill on error.
    // This is the scenario that caused orphaned processes before the fix:
    // the caller (spawn_mitmdump) is responsible for killing.
    assert!(
        nix::sys::signal::kill(pid, None).is_ok(),
        "process should still be alive after timeout"
    );

    // Simulate spawn_mitmdump error path: kill the child.
    let _ = child.kill().await;

    assert!(
        nix::sys::signal::kill(pid, None).is_err(),
        "process should be dead after kill"
    );
}

#[tokio::test]
async fn wait_for_ready_returns_error_on_early_exit() {
    // `true` exits immediately with status 0.
    let mut child = tokio::process::Command::new("true")
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();

    // Wait for `true` to actually exit before calling wait_for_ready,
    // so the first try_wait() inside the function detects it immediately.
    let _ = child.wait().await;

    let port = find_available_port().unwrap();
    let dir = tempfile::tempdir().unwrap();
    let result = wait_for_ready(
        &mut child,
        port,
        dir.path(),
        "usage-state-test",
        Duration::from_secs(5),
    )
    .await;
    assert!(result.is_err());
}

#[tokio::test]
async fn wait_for_ready_requires_control_when_port_is_open() {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let dir = tempfile::tempdir().unwrap();
    let mut child = tokio::process::Command::new("sleep")
        .arg("60")
        .kill_on_drop(true)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();

    let error = wait_for_ready(
        &mut child,
        port,
        dir.path(),
        "current-usage-state",
        Duration::from_millis(500),
    )
    .await
    .unwrap_err();

    assert!(error.to_string().contains("did not initialize its addon"));
    let _ = child.kill().await;
}

#[tokio::test]
async fn wait_for_ready_rejects_unresponsive_control_when_port_is_open() {
    let listener = tokio::net::TcpListener::bind(("127.0.0.1", 0))
        .await
        .unwrap();
    let port = listener.local_addr().unwrap().port();
    let dir = tempfile::tempdir().unwrap();
    std::fs::set_permissions(dir.path(), std::fs::Permissions::from_mode(0o700)).unwrap();
    let control_listener =
        tokio::net::UnixListener::bind(dir.path().join(control::SOCKET_NAME)).unwrap();
    let mut child = tokio::process::Command::new("sleep")
        .arg("60")
        .kill_on_drop(true)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();

    let error = wait_for_ready(
        &mut child,
        port,
        dir.path(),
        "current-usage-state",
        Duration::from_millis(500),
    )
    .await
    .unwrap_err();

    assert!(error.to_string().contains("did not initialize its addon"));
    // Prove this exercised an unanswered request, not a directory rejection.
    let (mut connection, _) =
        tokio::time::timeout(Duration::from_secs(1), control_listener.accept())
            .await
            .unwrap()
            .unwrap();
    use tokio::io::AsyncReadExt;
    assert!(connection.read(&mut [0; 4]).await.unwrap() > 0);
    let _ = child.kill().await;
}

#[tokio::test]
async fn spawn_mitmdump_passes_runner_options_and_preserves_ca() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    crate::ca::ensure(&home).await.unwrap();
    let original_cert = std::fs::read(home.ca_dir().join(crate::ca::CA_CERT)).unwrap();
    std::fs::remove_file(home.ca_dir().join("mitmproxy-ca.pem")).unwrap();
    let fake_mitmdump = dir.path().join("fake-mitmdump");
    write_fake_listening_mitmdump(&fake_mitmdump);
    let builtin_firewall_catalog_cache_path =
        dir.path().join("builtin-firewall-catalog-cache.json");

    let config = ProxyConfig {
        mitmdump_bin: fake_mitmdump.clone(),
        ca_dir: home.ca_dir(),
        ca_lock_path: home.ca_lock(),
        addon_dir: dir.path().join("addon"),
        registry_path: dir.path().join("proxy-registry.json"),
        registry_lock_path: dir.path().join("proxy-registry.json.lock"),
        builtin_firewall_catalog_cache_path: builtin_firewall_catalog_cache_path.clone(),
        runtime_dir: dir.path().join("mitmdump-runtime"),
        runtime_lock_path: dir.path().join("mitmdump-runtime.lock"),
        api_url: None,
        client_session_id: "runner-session-test".to_string(),
        client_version: "test-runner-version",
    };
    let (crash_tx, _crash_rx) = mpsc::channel(1);
    let stopping = Arc::new(AtomicBool::new(false));
    let port = find_available_port().unwrap();

    let runtime = acquire_test_runtime(&config).await;
    let child = spawn_mitmdump(
        &config,
        &runtime,
        port,
        &crash_tx,
        &stopping,
        "usage-state-test",
    )
    .await
    .unwrap();
    stopping.store(true, Ordering::Release);
    child.stop_gracefully().await.unwrap();

    let args = std::fs::read_to_string(fake_mitmdump.with_extension("args")).unwrap();
    let environment = std::fs::read_to_string(fake_mitmdump.with_extension("env")).unwrap();
    let environment: Vec<&str> = environment.lines().collect();
    assert_eq!(environment.len(), 2);
    assert_eq!(environment[0], environment[1]);
    let launched_environ = std::fs::read(fake_mitmdump.with_extension("environ")).unwrap();
    let tmpdir = launched_environ
        .split(|byte| *byte == 0)
        .find_map(|entry| entry.strip_prefix(b"TMPDIR="))
        .expect("launched mitmdump environment should contain TMPDIR");
    let mut canonical_markers = launched_environ
        .split(|byte| *byte == 0)
        .filter_map(|entry| entry.strip_prefix(b"OKOU_MITMDUMP_RUNTIME_DIR="));
    assert_eq!(
        canonical_markers.next(),
        Some(tmpdir),
        "the canonical runtime marker must equal TMPDIR"
    );
    assert!(
        canonical_markers.next().is_none(),
        "the launched mitmdump environment must contain exactly one canonical runtime marker"
    );
    let launch_path = Path::new(environment[0]);
    assert_eq!(launch_path.parent(), Some(config.runtime_dir.as_path()));
    assert!(
        launch_path
            .file_name()
            .is_some_and(|name| name.as_encoded_bytes().starts_with(b"launch-"))
    );
    assert!(!launch_path.exists());
    assert!(
        home.ca_dir().join("mitmproxy-ca.pem").is_file(),
        "proxy preparation should rebuild missing combined CA"
    );
    assert!(
        std::fs::read(home.ca_dir().join(crate::ca::CA_CERT)).unwrap() == original_cert,
        "proxy preparation must not rotate the standalone identity"
    );
    assert!(
        args.lines().any(|arg| arg == "upstream_cert=false"),
        "mitmdump args should scope generated certificates to TLS SNI; got:\n{args}",
    );
    assert!(
        args.lines()
            .any(|arg| arg == "okou_usage_state_id=usage-state-test"),
        "mitmdump args should include okou_usage_state_id option; got:\n{args}",
    );
    assert!(
        args.lines()
            .any(|arg| { arg == format!("okou_control_socket_dir={}", launch_path.display()) }),
        "mitmdump args should include its owned control directory; got:\n{args}",
    );
    assert!(
        args.lines().any(|arg| {
            arg == format!(
                "okou_builtin_firewall_catalog_cache_path={}",
                builtin_firewall_catalog_cache_path.display()
            )
        }),
        "mitmdump args should include okou_builtin_firewall_catalog_cache_path option; got:\n{args}",
    );
    assert!(
        args.lines()
            .any(|arg| arg == "okou_client_session_id=runner-session-test"),
        "mitmdump args should include okou_client_session_id option; got:\n{args}",
    );
    assert!(
        args.lines()
            .any(|arg| arg == "okou_client_version=test-runner-version"),
        "mitmdump args should include okou_client_version option; got:\n{args}",
    );
    assert!(!args.contains("runner-token"));
    assert!(
        args.lines().all(|arg| arg != "connection_strategy=lazy"),
        "mitmdump args must not use global lazy upstream connections because server-first TCP protocols must keep working; got:\n{args}",
    );
}

#[tokio::test]
async fn spawn_mitmdump_rejects_unrecoverable_ca_before_spawn() {
    let dir = tempfile::tempdir().unwrap();
    let ca_dir = dir.path().join("ca");
    std::fs::create_dir(&ca_dir).unwrap();
    let fake_mitmdump = dir.path().join("fake-mitmdump");
    write_fake_listening_mitmdump(&fake_mitmdump);
    let config = ProxyConfig {
        mitmdump_bin: fake_mitmdump.clone(),
        ca_dir,
        ca_lock_path: dir.path().join("ca.lock"),
        addon_dir: dir.path().join("addon"),
        registry_path: dir.path().join("proxy-registry.json"),
        registry_lock_path: dir.path().join("proxy-registry.json.lock"),
        builtin_firewall_catalog_cache_path: dir.path().join("builtin-firewall-catalog-cache.json"),
        runtime_dir: dir.path().join("mitmdump-runtime"),
        runtime_lock_path: dir.path().join("mitmdump-runtime.lock"),
        api_url: None,
        client_session_id: "runner-session-test".to_string(),
        client_version: "test-runner-version",
    };
    let (crash_tx, _crash_rx) = mpsc::channel(1);
    let stopping = Arc::new(AtomicBool::new(false));
    let port = find_available_port().unwrap();

    let runtime = acquire_test_runtime(&config).await;
    let error = spawn_mitmdump(
        &config,
        &runtime,
        port,
        &crash_tx,
        &stopping,
        "usage-state-test",
    )
    .await
    .err()
    .expect("expected unrecoverable CA error");

    assert!(
        error.to_string().contains("proxy CA") && error.to_string().contains("not recoverable"),
        "unexpected error: {error}"
    );
    assert!(
        !fake_mitmdump.with_extension("args").exists(),
        "mitmdump must not be spawned for unrecoverable CA state"
    );
}

#[tokio::test]
async fn spawn_mitmdump_kills_child_when_handle_is_dropped() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    crate::ca::ensure(&home).await.unwrap();
    let fake_mitmdump = dir.path().join("fake-mitmdump");
    write_fake_listening_mitmdump(&fake_mitmdump);

    let config = ProxyConfig {
        mitmdump_bin: fake_mitmdump.clone(),
        ca_dir: home.ca_dir(),
        ca_lock_path: home.ca_lock(),
        addon_dir: dir.path().join("addon"),
        registry_path: dir.path().join("proxy-registry.json"),
        registry_lock_path: dir.path().join("proxy-registry.json.lock"),
        builtin_firewall_catalog_cache_path: dir.path().join("builtin-firewall-catalog-cache.json"),
        runtime_dir: dir.path().join("mitmdump-runtime"),
        runtime_lock_path: dir.path().join("mitmdump-runtime.lock"),
        api_url: None,
        client_session_id: "runner-session-test".to_string(),
        client_version: "test-runner-version",
    };
    let (crash_tx, _crash_rx) = mpsc::channel(1);
    let stopping = Arc::new(AtomicBool::new(false));
    let port = find_available_port().unwrap();

    let runtime = acquire_test_runtime(&config).await;
    let child = spawn_mitmdump(
        &config,
        &runtime,
        port,
        &crash_tx,
        &stopping,
        "usage-state-test",
    )
    .await
    .unwrap();
    let pid = child.id().unwrap();
    let ProcessStatRead::Found(stat) = read_process_stat_checked(pid).await else {
        panic!("mitmdump process stat is unavailable for pid {pid}");
    };
    let environment = std::fs::read_to_string(fake_mitmdump.with_extension("env")).unwrap();
    let launch_path = PathBuf::from(environment.lines().next().unwrap());
    stopping.store(true, Ordering::Release);
    drop(child);

    assert!(
        wait_for_reaped_pid(pid, stat.starttime).await,
        "dropping mitmdump Child should kill and reap the process"
    );
    assert!(
        wait_for_path_absent(&launch_path).await,
        "drop cleanup should remove {}",
        launch_path.display()
    );
}

#[test]
fn dropped_mitmdump_without_current_runtime_preserves_launch_for_recovery() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    let fake_mitmdump = dir.path().join("fake-mitmdump");
    write_fake_listening_mitmdump(&fake_mitmdump);
    let config = test_proxy_config(dir.path(), &home, fake_mitmdump.clone());
    let tokio_runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    let (child, pid, starttime, launch_path) = tokio_runtime.block_on(async {
        crate::ca::ensure(&home).await.unwrap();
        let runtime = acquire_test_runtime(&config).await;
        let (crash_tx, _crash_rx) = mpsc::channel(1);
        let stopping = Arc::new(AtomicBool::new(false));
        let child = spawn_mitmdump(
            &config,
            &runtime,
            find_available_port().unwrap(),
            &crash_tx,
            &stopping,
            "usage-state-test",
        )
        .await
        .unwrap();
        let pid = child.id().unwrap();
        let ProcessStatRead::Found(stat) = read_process_stat_checked(pid).await else {
            panic!("mitmdump process stat is unavailable for pid {pid}");
        };
        let environment = std::fs::read_to_string(fake_mitmdump.with_extension("env")).unwrap();
        let launch_path = PathBuf::from(environment.lines().next().unwrap());
        stopping.store(true, Ordering::Release);
        // Leave the launch as the sole owner of the exclusive runtime lock.
        drop(runtime);
        (child, pid, stat.starttime, launch_path)
    });

    assert!(tokio::runtime::Handle::try_current().is_err());
    drop(child);
    assert!(
        launch_path.is_dir(),
        "drop without a current runtime must preserve extraction data"
    );

    tokio_runtime.block_on(async {
        assert!(
            wait_for_reaped_pid(pid, starttime).await,
            "drop fallback should kill and reap the direct mitmdump child"
        );
        let _recovered_runtime = acquire_test_runtime(&config).await;
        assert!(
            !launch_path.exists(),
            "the next runtime owner must recover the preserved launch directory"
        );
        assert_no_launch_dirs(&config.runtime_dir).await;
    });
}

#[tokio::test]
async fn startup_failure_kills_forked_descendant_and_removes_launch_directory() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    crate::ca::ensure(&home).await.unwrap();
    let fake_mitmdump = dir.path().join("failing-mitmdump");
    write_forking_failing_mitmdump(&fake_mitmdump);
    let config = test_proxy_config(dir.path(), &home, fake_mitmdump.clone());
    let runtime_dir = config.runtime_dir.clone();
    let (mut proxy, _crash_rx) = MitmProxy::new(config, ADDON_FILES.as_slice())
        .await
        .unwrap();
    let selected_port = proxy.port();

    let error = proxy.start().await.expect_err("expected startup failure");

    assert!(
        error
            .to_string()
            .contains("mitmdump exited immediately with 42"),
        "unexpected error: {error}"
    );
    assert_eq!(proxy.port(), selected_port);
    assert_eq!(
        std::fs::read_to_string(fake_mitmdump.with_extension("attempts"))
            .unwrap()
            .lines()
            .count(),
        1,
        "non-port startup failures must not be retried"
    );
    let descendant_pid: u32 = std::fs::read_to_string(fake_mitmdump.with_extension("descendant"))
        .unwrap()
        .parse()
        .unwrap();
    assert!(
        wait_for_pid_absent(descendant_pid).await,
        "startup failure left forked descendant {descendant_pid} alive"
    );
    let environment = std::fs::read_to_string(fake_mitmdump.with_extension("env")).unwrap();
    let launch_path = PathBuf::from(environment.lines().next().unwrap());
    assert!(!launch_path.exists());
    assert_no_launch_dirs(&runtime_dir).await;
}

#[tokio::test]
async fn restart_kills_forked_descendant_and_replaces_launch_directory() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    crate::ca::ensure(&home).await.unwrap();
    let fake_mitmdump = dir.path().join("forking-mitmdump");
    write_forking_ready_mitmdump(&fake_mitmdump);
    let config = test_proxy_config(dir.path(), &home, fake_mitmdump.clone());
    let runtime_dir = config.runtime_dir.clone();
    let readiness_listener = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let readiness_port = readiness_listener.local_addr().unwrap().port();
    let (mut proxy, _crash_rx) = MitmProxy::new(config, ADDON_FILES.as_slice())
        .await
        .unwrap();
    proxy.port = readiness_port;
    proxy.start().await.unwrap();

    let descendant_path = fake_mitmdump.with_extension("descendant");
    let old_descendant_pid = wait_for_pid_file(&descendant_path).await;
    let environment = std::fs::read_to_string(fake_mitmdump.with_extension("env")).unwrap();
    let old_launch = PathBuf::from(environment.lines().next().unwrap());
    let usage = MitmUsageHandle::from(&proxy);
    let run_id = RunId::new_v4();
    let frozen_usage = usage.for_run(run_id);
    let initial_generation = frozen_usage.generation().unwrap().to_owned();

    let gate = crate::test_fixtures::ReapGate::new();
    proxy.set_reap_gate_for_test(gate.clone());
    let restart = proxy.begin_restart();
    assert!(usage.for_run(run_id).generation().is_none());
    assert_eq!(frozen_usage.generation(), Some(initial_generation.as_str()));
    let restart_task = tokio::spawn(restart.spawn());
    tokio::time::timeout(Duration::from_secs(2), gate.entered.notified())
        .await
        .unwrap();
    assert!(!restart_task.is_finished());
    assert!(
        old_launch.exists(),
        "old launch must remain owned until reaping completes"
    );
    assert_eq!(
        std::fs::read_to_string(fake_mitmdump.with_extension("env")).unwrap(),
        environment,
        "replacement must not start before old-child cleanup completes"
    );
    gate.release.add_permits(1);
    let child = restart_task.await.unwrap().unwrap();

    assert!(
        wait_for_pid_absent(old_descendant_pid).await,
        "restart left forked descendant {old_descendant_pid} alive"
    );
    assert!(!old_launch.exists(), "restart left old launch directory");
    proxy.complete_restart(child);
    let replacement_usage = usage.for_run(run_id);
    assert!(replacement_usage.generation().is_some());
    assert_ne!(
        replacement_usage.generation(),
        Some(initial_generation.as_str())
    );
    assert_eq!(frozen_usage.generation(), Some(initial_generation.as_str()));
    proxy.kill_now().await.unwrap();
    assert!(usage.for_run(run_id).generation().is_none());
    assert_no_launch_dirs(&runtime_dir).await;
}

#[tokio::test]
async fn graceful_stop_kills_descendant_after_parent_exits_cleanly() {
    assert_graceful_stop_with_cleanup_stat(None, true).await;
}

#[tokio::test]
async fn graceful_stop_accepts_terminal_stat_with_unavailable_pgid() {
    assert_graceful_stop_with_cleanup_stat(Some(("X", "-1")), true).await;
}

#[tokio::test]
async fn graceful_stop_preserves_launch_after_malformed_terminal_stat() {
    assert_graceful_stop_with_cleanup_stat(Some(("X", "not-a-number")), false).await;
}

#[tokio::test]
async fn graceful_stop_preserves_launch_after_malformed_state_with_unavailable_pgid() {
    assert_graceful_stop_with_cleanup_stat(Some(("XX", "-1")), false).await;
}

async fn assert_graceful_stop_with_cleanup_stat(
    cleanup_stat: Option<(&str, &str)>,
    expect_success: bool,
) {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    crate::ca::ensure(&home).await.unwrap();
    let fake_mitmdump = dir.path().join("graceful-parent-mitmdump");
    write_graceful_parent_with_descendant_mitmdump(&fake_mitmdump);
    let config = test_proxy_config(dir.path(), &home, fake_mitmdump.clone());
    let runtime_dir = config.runtime_dir.clone();
    let (mut proxy, _crash_rx) = MitmProxy::new(config, ADDON_FILES.as_slice())
        .await
        .unwrap();
    proxy.start().await.unwrap();

    let descendant_path = fake_mitmdump.with_extension("descendant");
    let descendant_pid = wait_for_pid_file(&descendant_path).await;
    let environment = std::fs::read_to_string(fake_mitmdump.with_extension("env")).unwrap();
    let launch_path = PathBuf::from(environment.lines().next().unwrap());

    if let Some((state, pgid)) = cleanup_stat {
        let ProcessStatRead::Found(stat) = read_process_stat_checked(descendant_pid).await else {
            panic!("live descendant stat must be readable");
        };
        let proc_root = dir.path().join("cleanup-proc");
        let pid_dir = proc_root.join(descendant_pid.to_string());
        std::fs::create_dir_all(&pid_dir).unwrap();
        // Sanitized kernel exit-transition record, changing one selected
        // field for malformed-input cases. Preserve descendant starttime.
        let fields = [
            state, "0", pgid, "-1", "0", "-1", "0", "0", "0", "0", "0", "0", "0", "0", "0", "0",
            "0", "0", "0",
        ];
        std::fs::write(
            pid_dir.join("stat"),
            format!(
                "{descendant_pid} (python3) {} {}\n",
                fields.join(" "),
                stat.starttime,
            ),
        )
        .unwrap();
        proxy
            .runtime
            .as_ref()
            .unwrap()
            .set_test_cleanup_stat_read(descendant_pid, proc_root);
    }

    let usage = MitmUsageHandle::from(&proxy);
    let run_id = RunId::new_v4();
    let frozen_usage = usage.for_run(run_id);
    let initial_generation = frozen_usage.generation().unwrap().to_owned();

    let stopped = proxy.stop().await;
    assert!(usage.for_run(run_id).generation().is_none());
    assert_eq!(frozen_usage.generation(), Some(initial_generation.as_str()));
    if expect_success {
        stopped.unwrap();
        assert!(!launch_path.exists(), "graceful stop left launch directory");
        assert_no_launch_dirs(&runtime_dir).await;
    } else {
        let error = stopped.unwrap_err().to_string();
        assert!(error.contains(&format!("parse /proc/{descendant_pid}/stat")));
        assert!(
            launch_path.is_dir(),
            "uncertain cleanup removed launch directory"
        );
    }

    assert!(
        wait_for_pid_absent(descendant_pid).await,
        "graceful stop left forked descendant {descendant_pid} alive"
    );
}

#[tokio::test]
async fn repeated_start_keeps_the_active_process_and_launch_directory() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    crate::ca::ensure(&home).await.unwrap();
    let fake_mitmdump = dir.path().join("fake-mitmdump");
    write_fake_listening_mitmdump(&fake_mitmdump);
    let config = test_proxy_config(dir.path(), &home, fake_mitmdump.clone());
    let (mut proxy, _crash_rx) = MitmProxy::new(config, ADDON_FILES.as_slice())
        .await
        .unwrap();
    proxy.start().await.unwrap();
    let environment = std::fs::read_to_string(fake_mitmdump.with_extension("env")).unwrap();
    let launch_path = PathBuf::from(environment.lines().next().unwrap());

    let error = proxy.start().await.unwrap_err();

    assert!(error.to_string().contains("already started"));
    assert!(launch_path.is_dir());
    assert!(
        proxy.child.as_mut().unwrap().try_wait().unwrap().is_none(),
        "repeated start terminated the active mitmdump"
    );
    proxy.kill_now().await.unwrap();
    assert!(!launch_path.exists());
}

#[tokio::test]
async fn proxy_runtime_lock_prevents_concurrent_owners() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    let config = test_proxy_config(dir.path(), &home, dir.path().join("mitmdump"));
    let (first, _first_crash_rx) = MitmProxy::new(config.clone(), ADDON_FILES.as_slice())
        .await
        .unwrap();

    let error = MitmProxy::new(config.clone(), ADDON_FILES.as_slice())
        .await
        .err()
        .expect("expected runtime lock conflict");
    assert!(
        error.to_string().contains("mitmdump runtime lock")
            && error.to_string().contains("already held"),
        "unexpected error: {error}"
    );

    drop(first);
    let (_next, _next_crash_rx) = MitmProxy::new(config, ADDON_FILES.as_slice())
        .await
        .unwrap();
}

#[tokio::test]
async fn proxy_startup_reconciles_canonical_marker_and_only_private_launches() {
    let dir = tempfile::tempdir().unwrap();
    let home = HomePaths::with_root(dir.path().join("home"));
    let config = test_proxy_config(dir.path(), &home, dir.path().join("mitmdump"));
    let runtime = acquire_test_runtime(&config).await;
    let stale_launch = config.runtime_dir.join("launch-canonical");
    std::fs::create_dir(&stale_launch).unwrap();
    std::fs::create_dir(stale_launch.join("_MEI-stale")).unwrap();
    std::fs::write(stale_launch.join("_MEI-stale/payload"), b"stale").unwrap();

    let mut stale_process = tokio::process::Command::new("sleep")
        .arg("60")
        .env_remove(CANONICAL_RUNTIME_MARKER_ENV)
        .env("TMPDIR", &stale_launch)
        .env(CANONICAL_RUNTIME_MARKER_ENV, &stale_launch)
        .process_group(0)
        .kill_on_drop(true)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let stale_pid = stale_process.id().unwrap();
    drop(runtime);

    let unrelated_sibling = config.runtime_dir.join("keep-me");
    std::fs::create_dir(&unrelated_sibling).unwrap();
    let unrelated_shared = tempfile::Builder::new()
        .prefix("_MEI-vm0-unrelated-")
        .tempdir_in("/tmp")
        .unwrap();

    let (_proxy, _crash_rx) = MitmProxy::new(config, ADDON_FILES.as_slice())
        .await
        .unwrap();

    let status = tokio::time::timeout(Duration::from_secs(2), stale_process.wait())
        .await
        .expect("stale canonical-marked process was not terminated")
        .unwrap();
    assert!(
        !status.success(),
        "stale process unexpectedly exited cleanly"
    );
    assert!(
        wait_for_pid_absent(stale_pid).await,
        "stale canonical-marked process {stale_pid} remains live"
    );
    assert!(!stale_launch.exists(), "stale launch directory remains");
    assert!(unrelated_sibling.is_dir());
    assert!(unrelated_shared.path().is_dir());
}

#[tokio::test]
async fn usage_flush_target_returns_target_for_running_child() {
    let (mut proxy, _crash_rx) = MitmProxy::noop();
    let child = tokio::process::Command::new("sleep")
        .arg("60")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    proxy.set_child_for_test(child);

    let control_directory = tempfile::tempdir().unwrap();
    proxy.set_control_directory_for_test(control_directory.path().to_path_buf());
    assert!(proxy.usage_flush_target().is_some());

    proxy.stop().await.unwrap();
}

#[tokio::test]
async fn usage_flush_target_retains_exited_child_for_async_cleanup() {
    let (mut proxy, _crash_rx) = MitmProxy::noop();
    let mut child = tokio::process::Command::new("true")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    child.wait().await.unwrap();
    proxy.set_child_for_test(child);

    assert!(proxy.usage_flush_target().is_none());
    assert!(proxy.child.is_some());
    proxy.kill_now().await.unwrap();
}

#[tokio::test]
async fn kill_now_reaps_exited_child() {
    let (mut proxy, _crash_rx) = MitmProxy::noop();
    let mut child = tokio::process::Command::new("true")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    child.wait().await.unwrap();
    proxy.set_child_for_test(child);

    proxy.kill_now().await.unwrap();

    assert!(proxy.child.is_none());
}

#[test]
fn request_usage_flush_returns_false_without_child() {
    let (mut proxy, _crash_rx) = MitmProxy::noop();

    assert!(!proxy.request_usage_flush());
}

#[tokio::test]
async fn request_usage_flush_retains_exited_child_for_async_cleanup() {
    let (mut proxy, _crash_rx) = MitmProxy::noop();
    let mut child = tokio::process::Command::new("bash")
        .arg("-c")
        .arg("echo ready")
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
        .unwrap();
    let stdout = child.stdout.take().unwrap();
    let mut ready_lines = tokio::io::BufReader::new(stdout).lines();
    assert_eq!(
        ready_lines.next_line().await.unwrap().as_deref(),
        Some("ready")
    );
    assert!(ready_lines.next_line().await.unwrap().is_none());
    let status = child.wait().await.unwrap();
    assert!(status.success(), "child exited with {status}");
    proxy.set_child_for_test(child);

    assert!(!proxy.request_usage_flush());
    assert!(proxy.child.is_some());
    proxy.kill_now().await.unwrap();
}

/// Regression for #10624: `begin_restart` must lock the old
/// monitor's `stopping` at `true` and hand the caller a fresh
/// `Arc<AtomicBool>` for the next child. If the old flag were
/// shared across the restart boundary, the old stdout monitor
/// could race in after `kill().await` returned, read `stopping ==
/// false`, and emit a spurious crash notification.
#[tokio::test]
async fn begin_restart_isolates_stopping_flag_per_child() {
    let (mut proxy, _crash_rx) = MitmProxy::noop();
    let old_stopping = Arc::clone(&proxy.stopping);

    let params = proxy.begin_restart();

    // Old flag is now permanently `true`; any task still holding
    // `old_stopping` (the old monitor) will observe graceful
    // shutdown semantics regardless of when it wakes up.
    assert!(old_stopping.load(Ordering::Acquire));

    // The next child's monitor starts from a clean slate.
    assert!(!params.stopping.load(Ordering::Acquire));

    // And the proxy holds that same fresh `Arc` — so subsequent
    // `stop()` / `Drop` calls operate on the new child, not the
    // already-silenced old one.
    assert!(Arc::ptr_eq(&proxy.stopping, &params.stopping));
    assert!(!Arc::ptr_eq(&old_stopping, &params.stopping));
}

/// `spawn_mitmdump` can fail (e.g. port still in use), leaving the
/// caller to retry without ever calling `complete_restart`. Each
/// `begin_restart` in that retry chain must still hand out a fresh
/// `Arc` and lock every previous one — otherwise a stale flag
/// could be reset on the next round, resurrecting the race.
#[tokio::test]
async fn repeated_begin_restart_produces_independent_flags() {
    let (mut proxy, _crash_rx) = MitmProxy::noop();

    let first = proxy.begin_restart();
    let second = proxy.begin_restart();
    let third = proxy.begin_restart();

    // Every handed-out Arc is distinct.
    assert!(!Arc::ptr_eq(&first.stopping, &second.stopping));
    assert!(!Arc::ptr_eq(&second.stopping, &third.stopping));
    assert!(!Arc::ptr_eq(&first.stopping, &third.stopping));

    // Superseded flags are permanently locked; only the most
    // recent one remains mutable.
    assert!(first.stopping.load(Ordering::Acquire));
    assert!(second.stopping.load(Ordering::Acquire));
    assert!(!third.stopping.load(Ordering::Acquire));
    assert!(Arc::ptr_eq(&proxy.stopping, &third.stopping));
}

/// `stop()` must set the *current* child's flag, not the one just
/// superseded by `begin_restart`. A regression here would make
/// `stop()` a silent no-op (the old Arc is already `true`), while
/// the new child's monitor — which is what `stop()` exists to
/// silence — would keep reading `false`.
#[tokio::test]
async fn stop_after_begin_restart_targets_current_flag() {
    let (mut proxy, _crash_rx) = MitmProxy::noop();
    let params = proxy.begin_restart();
    let current = Arc::clone(&params.stopping);
    assert!(!current.load(Ordering::Acquire));

    proxy.stop().await.unwrap();

    assert!(current.load(Ordering::Acquire));
}
