use std::os::fd::AsRawFd;
use std::os::unix::fs::PermissionsExt;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};

use super::*;

fn fixture() -> (tempfile::TempDir, UnixListener, DeliveryTarget) {
    let directory = tempfile::Builder::new()
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap();
    let fd = std::fs::File::open(directory.path()).unwrap();
    let listener =
        UnixListener::bind(format!("/proc/self/fd/{}/control.sock", fd.as_raw_fd())).unwrap();
    let target = DeliveryTarget(ControlTarget {
        directory: directory.path().to_path_buf(),
        generation: "generation-1".into(),
    });
    (directory, listener, target)
}

async fn request(stream: &mut UnixStream) -> Value {
    let size = stream.read_u32().await.unwrap();
    assert!(size <= 64 * 1024);
    let mut bytes = vec![0; size as usize];
    stream.read_exact(&mut bytes).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

async fn reply(stream: &mut UnixStream, request: &Value, data: Value) {
    let bytes = serde_json::to_vec(&json!({"requestId": request["requestId"], "generation": request["generation"], "type": "result", "data": data})).unwrap();
    stream.write_u32(bytes.len() as u32).await.unwrap();
    stream.write_all(&bytes).await.unwrap();
    stream.shutdown().await.unwrap();
}

fn snapshot() -> Value {
    json!({"flows": 0, "buffered": 0, "reports": 0, "workerActive": false, "wakePending": false, "closed": false, "drainActive": true, "flushFailures": 0, "outcomes": {"success": 2, "retryable_failure": 1, "permanent_failure": 1}})
}

#[tokio::test]
async fn drain_validates_quiescence_without_erasing_known_failures() {
    for defect in ["none", "pending", "active", "closed", "extra", "negative"] {
        let (_directory, listener, target) = fixture();
        let mut observed = snapshot();
        match defect {
            "pending" => observed["reports"] = json!(1),
            "active" => observed["workerActive"] = json!(true),
            "closed" => observed["closed"] = json!(true),
            "extra" => observed["token"] = json!("must not be accepted"),
            "negative" => observed["outcomes"]["success"] = json!(-1),
            _ => {}
        }
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let req = request(&mut stream).await;
            assert_eq!(req["method"], "delivery.drain");
            assert_eq!(req["params"], json!({}));
            assert_eq!(req["generation"], "generation-1");
            reply(
                &mut stream,
                &req,
                json!({"state": "quiescent", "snapshot": observed}),
            )
            .await;
        });
        let result = target
            .observe_drain(Instant::now() + Duration::from_secs(2))
            .await;
        assert_eq!(result.is_ok(), defect == "none", "{defect}");
        if let Ok(observed) = result {
            assert_eq!(observed.outcomes.permanent_failure, 1);
        }
        server.await.unwrap();
    }
}

#[tokio::test]
async fn known_deadline_allows_observation_but_reply_loss_never_replays() {
    let (_directory, listener, target) = fixture();
    let server = tokio::spawn(async move {
        let (mut first, _) = listener.accept().await.unwrap();
        let req = request(&mut first).await;
        let mut pending = snapshot();
        pending["reports"] = json!(1);
        reply(
            &mut first,
            &req,
            json!({"state": "deadline", "snapshot": pending}),
        )
        .await;
        let (mut second, _) = listener.accept().await.unwrap();
        request(&mut second).await;
        drop(second);
        assert!(
            tokio::time::timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
    });
    assert!(
        target
            .observe_drain(Instant::now() + Duration::from_secs(2))
            .await
            .is_err()
    );
    server.await.unwrap();
}

#[tokio::test]
async fn wake_owner_bounds_queued_work_and_does_not_block_the_caller() {
    let (_directory, listener, target) = fixture();
    let worker = FlushTask::new();
    assert!(worker.request(target.0.clone()));
    let (mut first, _) = tokio::time::timeout(Duration::from_secs(2), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let req = request(&mut first).await;
    assert_eq!(req["method"], "delivery.flush");
    for _ in 0..100 {
        assert!(worker.request(target.0.clone()));
    }
    reply(&mut first, &req, json!({"state": "admitted"})).await;
    let (mut second, _) = tokio::time::timeout(Duration::from_secs(2), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let req = request(&mut second).await;
    reply(&mut second, &req, json!({"state": "coalesced"})).await;
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn correlated_busy_can_be_reobserved_but_never_past_total_deadline() {
    for budget in [Duration::from_secs(2), Duration::ZERO] {
        let (_directory, listener, target) = fixture();
        let server = tokio::spawn(async move {
            if budget.is_zero() {
                assert!(
                    tokio::time::timeout(BUSY_POLL, listener.accept())
                        .await
                        .is_err()
                );
                return;
            }
            let (mut stream, _) = listener.accept().await.unwrap();
            let req = request(&mut stream).await;
            let bytes = serde_json::to_vec(&json!({
                "requestId": req["requestId"], "generation": req["generation"],
                "type": "error", "code": "busy"
            }))
            .unwrap();
            stream.write_u32(bytes.len() as u32).await.unwrap();
            stream.write_all(&bytes).await.unwrap();
            stream.shutdown().await.unwrap();
            let (mut stream, _) = listener.accept().await.unwrap();
            let req = request(&mut stream).await;
            reply(
                &mut stream,
                &req,
                json!({"state": "quiescent", "snapshot": snapshot()}),
            )
            .await;
        });
        let result = target.observe_drain(Instant::now() + budget).await;
        if budget > BUSY_POLL {
            assert!(result.is_ok());
        } else {
            assert_eq!(result.unwrap_err().kind(), io::ErrorKind::TimedOut);
        }
        server.await.unwrap();
    }
}

#[tokio::test]
async fn retiring_wake_owner_disconnects_and_discards_queued_launch_requests() {
    let (_directory, listener, target) = fixture();
    let worker = FlushTask::new();
    assert!(worker.request(target.0.clone()));
    let (mut stream, _) = listener.accept().await.unwrap();
    request(&mut stream).await;
    assert!(worker.request(target.0));
    drop(worker);
    let mut byte = [0];
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(2), stream.read(&mut byte))
            .await
            .unwrap()
            .unwrap(),
        0
    );
    assert!(
        tokio::time::timeout(Duration::from_millis(100), listener.accept())
            .await
            .is_err()
    );
}

#[tokio::test]
async fn real_python_delivery_round_trip_and_generation_rejection() {
    let directory = tempfile::Builder::new()
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap();
    let mut child = tokio::process::Command::new(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("mitm-addon/.venv/bin/python"),
    )
    .arg("-u")
    .arg("-c")
    .arg(
        r#"
import sys
from pathlib import Path
from runner_control import ControlServer
from runner_flush_lifecycle import DeliveryControl, drain_and_close
from usage import webhook
server = ControlServer(Path(sys.argv[1]), 'generation-1', delivery_owner=DeliveryControl())
server.start()
try:
    print('ready', flush=True)
    sys.stdin.readline()
finally:
    server.stop()
    drain_and_close()
    webhook.shutdown_delivery_executor(wait=True)
"#,
    )
    .arg(directory.path())
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
        tokio::time::timeout(Duration::from_secs(10), lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .as_deref(),
        Some("ready")
    );
    let mut target = DeliveryTarget(ControlTarget {
        directory: directory.path().to_path_buf(),
        generation: "generation-1".into(),
    });
    let observed = target
        .observe_drain(Instant::now() + Duration::from_secs(5))
        .await
        .unwrap();
    assert_eq!(observed.outcomes.success, 0);
    target.0.generation = "old-generation".into();
    assert!(
        target
            .observe_drain(Instant::now() + Duration::from_secs(2))
            .await
            .is_err()
    );
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
}
