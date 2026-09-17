use std::os::fd::AsRawFd;
use std::os::unix::fs::PermissionsExt;

use serde_json::json;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixListener;

use super::*;

fn private_directory() -> tempfile::TempDir {
    tempfile::Builder::new()
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap()
}

fn handle(directory: &std::path::Path) -> MitmJsonlFlushHandle {
    let handle = MitmJsonlFlushHandle::default();
    handle.set_target(Some(ControlTarget {
        directory: directory.to_path_buf(),
        generation: "generation-1".into(),
    }));
    handle
}

#[tokio::test]
async fn flush_uses_real_python_writer_and_frozen_generation() {
    let directory = private_directory();
    let run_id = RunId::new_v4();
    let path = directory.path().join(format!("network-{run_id}.jsonl"));
    let mut child = tokio::process::Command::new("python3")
        .arg("-u")
        .arg("-c")
        .arg(
            r#"
import sys
from pathlib import Path
import jsonl_writer
from runner_control import ControlServer
directory, path = sys.argv[1:]
server = ControlServer(Path(directory), 'generation-1')
server.start()
try:
    for _ in range(100):
        jsonl_writer.write_jsonl_line(path, b'{"action":"ALLOW"}\n', 'network')
    print('ready', flush=True)
    sys.stdin.readline()
finally:
    server.stop()
    jsonl_writer.shutdown_writer(timeout=None)
"#,
        )
        .arg(directory.path())
        .arg(&path)
        .env(
            "PYTHONPATH",
            concat!(env!("CARGO_MANIFEST_DIR"), "/mitm-addon/src"),
        )
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let mut lines = tokio::io::BufReader::new(child.stdout.take().unwrap()).lines();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(5), lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .as_deref(),
        Some("ready")
    );
    let handle = handle(directory.path());
    let original_run = handle.for_run(run_id, path.clone());
    // Advancing the provider must not let an old job follow that generation.
    handle.set_target(Some(ControlTarget {
        directory: directory.path().to_path_buf(),
        generation: "generation-2".into(),
    }));
    assert!(original_run.flush().await);
    assert!(!handle.for_run(run_id, path.clone()).flush().await);
    assert_eq!(
        tokio::fs::read(&path).await.unwrap(),
        b"{\"action\":\"ALLOW\"}\n".repeat(100)
    );
    handle.set_target(None);
    assert!(!handle.for_run(run_id, path).flush().await);
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"stop\n")
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(5), child.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
    assert!(!original_run.flush().await);
}

#[tokio::test]
async fn flush_rejects_mismatched_or_unprocessed_results() {
    for defect in ["run", "path", "pending", "boundary", "deadline", "extra"] {
        let directory = private_directory();
        let dir_fd = std::fs::File::open(directory.path()).unwrap();
        let listener =
            UnixListener::bind(format!("/proc/self/fd/{}/control.sock", dir_fd.as_raw_fd()))
                .unwrap();
        let mut tasks = tokio::task::JoinSet::new();
        tasks.spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let size = stream.read_u32().await.unwrap() as usize;
            assert!(size <= 64 * 1024);
            let mut bytes = vec![0; size];
            stream.read_exact(&mut bytes).await.unwrap();
            let request: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
            assert_eq!(request["method"], "logs.flush");
            let mut data = json!({ "runId": request["params"]["runId"], "path": request["params"]["path"], "boundary": 1, "pending": 0, "state": "processed" });
            if defect == "run" {
                data["runId"] = json!(RunId::new_v4());
            } else if defect == "path" {
                data["path"] = json!("/another-log");
            } else if defect == "pending" {
                data["pending"] = json!(1);
            } else if defect == "boundary" {
                data["pending"] = json!(2);
            } else if defect == "deadline" {
                data["state"] = json!("deadline");
            } else {
                assert_eq!(defect, "extra");
                data["persisted"] = json!(true);
            }
            let response = serde_json::to_vec(&json!({"requestId": request["requestId"], "generation": request["generation"], "type": "result", "data": data})).unwrap();
            stream.write_u32(response.len() as u32).await.unwrap();
            stream.write_all(&response).await.unwrap();
        });
        let run_id = RunId::new_v4();
        let path = directory.path().join(format!("network-{run_id}.jsonl"));
        assert!(
            !handle(directory.path()).for_run(run_id, path).flush().await,
            "accepted {defect}"
        );
        tokio::time::timeout(Duration::from_secs(5), tasks.join_next())
            .await
            .unwrap()
            .unwrap()
            .unwrap();
    }
}
