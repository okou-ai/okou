use std::os::unix::fs::PermissionsExt;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};

use super::*;

fn reader(directory: &std::path::Path) -> MitmRunUsage {
    let control = ControlHandle::default();
    control.set_target(Some(ControlTarget {
        directory: directory.into(),
        generation: "generation-1".into(),
    }));
    MitmUsageHandle::new(control).for_run(RunId::new_v4())
}

fn private_directory() -> tempfile::TempDir {
    tempfile::Builder::new()
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap()
}

async fn request(stream: &mut UnixStream) -> Value {
    let length = stream.read_u32().await.unwrap();
    let mut bytes = vec![0; length as usize];
    stream.read_exact(&mut bytes).await.unwrap();
    let request: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(request["method"], "usage.snapshot");
    request
}

fn snapshot(run_id: RunId) -> Value {
    json!({
        "state": "available", "runId": run_id, "revision": 3,
        "sampledAtMs": 1, "observedResponses": 1, "outstandingResponses": 0,
        "complete": true, "reasons": [],
        "totals": {"input": 25, "cacheRead": 10, "cacheCreation": 15, "output": 20, "total": 70}
    })
}

async fn reply(stream: &mut UnixStream, request: &Value, data: Value) {
    let body = serde_json::to_vec(&json!({
        "type": "result", "requestId": request["requestId"],
        "generation": request["generation"], "data": data
    }))
    .unwrap();
    stream.write_u32(body.len() as u32).await.unwrap();
    stream.write_all(&body).await.unwrap();
    stream.shutdown().await.unwrap();
}

#[tokio::test]
async fn reads_typed_snapshots_and_rejects_incoherent_payloads() {
    let directory = private_directory();
    let listener = UnixListener::bind(directory.path().join("control.sock")).unwrap();
    let (proxy, _crash_rx) = crate::proxy::MitmProxy::noop();
    proxy.set_control_directory_for_test(directory.path().into());
    let reader = MitmUsageHandle::from(&proxy).for_run(RunId::new_v4());
    // Replacing the live target must not redirect a reader frozen for this run.
    proxy.set_control_directory_for_test(directory.path().join("replacement"));
    let valid = snapshot(reader.run_id);
    let defects = [
        ("/runId", json!(RunId::new_v4())),
        ("/totals/total", json!(95)),
        ("/totals/input", json!(-1)),
        ("/totals/output", json!(1.5)),
        ("/complete", json!(false)),
        ("/reasons", json!(["future_reason"])),
        ("/outstandingResponses", json!(1)),
        ("/observedResponses", json!(4097)),
        ("/observedResponses", json!(0)),
        ("/sampledAtMs", json!(0)),
        (
            "/totals",
            json!({"input": 1_u64 << 53, "cacheRead": 0, "cacheCreation": 0,
                "output": 0, "total": 1_u64 << 53}),
        ),
    ];
    let mut payloads = vec![valid.clone()];
    for (pointer, value) in defects {
        let mut data = valid.clone();
        *data.pointer_mut(pointer).unwrap() = value;
        payloads.push(data);
    }
    let mut repeated = valid.clone();
    repeated["complete"] = json!(false);
    repeated["reasons"] = json!(["missing_usage", "missing_usage"]);
    payloads.push(repeated);
    let mut extra = valid;
    extra["secret"] = json!("unexpected");
    payloads.push(extra);
    let count = payloads.len();
    let server = tokio::spawn(async move {
        for payload in payloads {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request = request(&mut stream).await;
            reply(&mut stream, &request, payload).await;
        }
    });
    let RunUsageObservation::Available(observed) = reader.snapshot().await.unwrap() else {
        panic!("expected available observation");
    };
    assert_eq!(observed.totals.total, 70);
    for _ in 1..count {
        assert!(reader.snapshot().await.is_err());
    }
    server.await.unwrap();
}

#[tokio::test]
async fn cancellation_releases_shared_bounded_admission_and_frozen_target() {
    let directory = private_directory();
    let listener = UnixListener::bind(directory.path().join("control.sock")).unwrap();
    let reader = reader(directory.path());
    let mut jobs = Vec::new();
    let mut peers = Vec::new();
    for _ in 0..8 {
        let reader = reader.clone();
        jobs.push(tokio::spawn(async move { reader.snapshot().await }));
        let (mut peer, _) = listener.accept().await.unwrap();
        request(&mut peer).await;
        peers.push(peer);
    }
    assert_eq!(
        reader.snapshot().await.unwrap_err().kind(),
        io::ErrorKind::WouldBlock
    );
    for job in jobs {
        job.abort();
        assert!(job.await.unwrap_err().is_cancelled());
    }
    for mut peer in peers {
        assert_eq!(peer.read(&mut [0; 1]).await.unwrap(), 0);
    }
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        let request = request(&mut stream).await;
        let data = json!({"state": "unavailable", "runId": request["params"]["runId"]});
        reply(&mut stream, &request, data).await;
    });
    assert!(matches!(
        reader.snapshot().await.unwrap(),
        RunUsageObservation::Unavailable { .. }
    ));
    assert_eq!(reader.generation(), Some("generation-1"));
    server.await.unwrap();
}

#[tokio::test]
async fn real_python_registry_and_socket_round_trip() {
    let directory = private_directory();
    let mut reader = reader(directory.path());
    let mut child = tokio::process::Command::new(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("mitm-addon/.venv/bin/python"),
    )
    .arg("-u")
    .arg("-c")
    .arg(
        r#"
import json, sys
from pathlib import Path
import registry, run_usage
from runner_control import ControlServer
directory = Path(sys.argv[1])
run_usage.initialize('generation-1')
path = directory / 'registry.json'
path.write_text(json.dumps({'sandboxes': {'10.200.0.1': {
    'runId': sys.argv[2], 'cliAgentType': 'codex', 'sandboxToken': 'synthetic',
    'billableFirewalls': [], 'usageGeneration': 'generation-1'
}}}))
registry.load_registry_state(str(path))
server = ControlServer(directory, 'generation-1', usage_snapshot=run_usage.snapshot)
server.start()
try:
    print('ready', flush=True)
    sys.stdin.readline()
finally:
    server.stop()
"#,
    )
    .arg(directory.path())
    .arg(reader.run_id.to_string())
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
    let RunUsageObservation::Available(observed) = reader.snapshot().await.unwrap() else {
        panic!("registered run unavailable");
    };
    assert_eq!(observed.totals.total, 0);
    assert_eq!(observed.observed_responses, 0);
    assert!(observed.complete);
    reader.target.as_mut().unwrap().generation = "stale-generation".into();
    assert!(reader.snapshot().await.is_err());
    child
        .stdin
        .take()
        .unwrap()
        .write_all(b"stop\n")
        .await
        .unwrap();
    assert!(
        tokio::time::timeout(Duration::from_secs(10), child.wait())
            .await
            .unwrap()
            .unwrap()
            .success()
    );
}
