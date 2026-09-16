use std::os::fd::AsRawFd;
use std::os::unix::fs::PermissionsExt;

use serde_json::{Value, json};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};

use super::*;

fn receipt(digest: &RegistryDigest) -> Value {
    json!({
        "expectedDigest": digest,
        "state": "applied",
        "snapshot": {
            "state": "available", "digest": digest,
            "file": {"device": 1, "inode": 2, "mtimeNs": 3, "size": 4},
            "catalog": {"state": "not_used"},
            "validEntries": 1, "rejectedEntries": 0, "omittedEntries": 0,
            "entries": [], "truncated": false
        }
    })
}

async fn request(stream: &mut UnixStream) -> Value {
    let size = stream.read_u32().await.unwrap();
    let mut bytes = vec![0; size as usize];
    stream.read_exact(&mut bytes).await.unwrap();
    serde_json::from_slice(&bytes).unwrap()
}

#[tokio::test]
async fn application_uses_frozen_generation_and_validates_actual_snapshot() {
    for defect in ["none", "digest", "catalog", "summary", "state", "extra"] {
        let directory = tempfile::Builder::new()
            .permissions(std::fs::Permissions::from_mode(0o700))
            .tempdir()
            .unwrap();
        let fd = std::fs::File::open(directory.path()).unwrap();
        let listener =
            UnixListener::bind(format!("/proc/self/fd/{}/control.sock", fd.as_raw_fd())).unwrap();
        let digest = RegistryDigest::of(b"published bytes");
        let mut data = receipt(&digest);
        match defect {
            "digest" => data["snapshot"]["digest"] = json!(RegistryDigest::of(b"other bytes")),
            "catalog" => {
                data["snapshot"]["catalog"] = json!({"state": "available", "digest": "invalid", "file": {"device": 1, "inode": 2, "mtimeNs": 3, "size": 4}})
            }
            "summary" => data["snapshot"]["truncated"] = json!(true),
            "state" => data["state"] = json!("rejected"),
            "extra" => data["snapshot"]["credentials"] = json!("must not be accepted"),
            _ => {}
        }
        let expected = digest.clone();
        let server = tokio::spawn(async move {
            let (mut stream, _) = listener.accept().await.unwrap();
            let request = request(&mut stream).await;
            assert_eq!(request["method"], "registry.apply");
            assert_eq!(request["params"], json!({"digest": expected}));
            assert_eq!(request["generation"], "generation-1");
            let bytes = serde_json::to_vec(&json!({
                "requestId": request["requestId"], "generation": request["generation"],
                "type": "result", "data": data
            }))
            .unwrap();
            stream.write_u32(bytes.len() as u32).await.unwrap();
            stream.write_all(&bytes).await.unwrap();
        });
        let publication = RegistryPublication {
            digest,
            target: Some(ControlTarget {
                directory: directory.path().to_path_buf(),
                generation: "generation-1".to_string(),
            }),
        };
        assert_eq!(
            publication.apply().await.is_ok(),
            defect == "none",
            "{defect}"
        );
        server.await.unwrap();
    }
}

#[tokio::test]
async fn lost_reply_is_unknown_and_does_not_replay_publication() {
    let directory = tempfile::Builder::new()
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap();
    let fd = std::fs::File::open(directory.path()).unwrap();
    let listener =
        UnixListener::bind(format!("/proc/self/fd/{}/control.sock", fd.as_raw_fd())).unwrap();
    let server = tokio::spawn(async move {
        let (mut stream, _) = listener.accept().await.unwrap();
        request(&mut stream).await;
        drop(stream);
        // A second connection would be an automatic replay after ambiguity.
        assert!(
            tokio::time::timeout(Duration::from_millis(100), listener.accept())
                .await
                .is_err()
        );
    });
    let publication = RegistryPublication {
        digest: RegistryDigest::of(b"published bytes"),
        target: Some(ControlTarget {
            directory: directory.path().to_path_buf(),
            generation: "generation-1".to_string(),
        }),
    };
    assert!(publication.apply().await.is_err());
    server.await.unwrap();
}

#[tokio::test]
async fn real_python_registry_owner_reports_publication_and_catalog_evidence() {
    use tokio::io::AsyncBufReadExt;

    let directory = tempfile::Builder::new()
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap();
    let path = directory.path().join("registry.json");
    let content = br#"{"sandboxes":{},"updatedAt":1}"#;
    crate::state_file::write_private_atomic(&path, content)
        .await
        .unwrap();
    let python =
        std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("mitm-addon/.venv/bin/python");
    let mut child = tokio::process::Command::new(python)
        .arg("-u")
        .arg("-c")
        .arg(
            r#"
import asyncio
import sys
from pathlib import Path
from types import SimpleNamespace
from mitmproxy import ctx
from registry_control import RegistryControl
from runner_control import ControlServer

async def main():
    directory = Path(sys.argv[1])
    ctx.options = SimpleNamespace(okou_builtin_firewall_catalog_cache_path=str(directory / 'catalog.json'))
    owner = RegistryControl(asyncio.get_running_loop(), str(directory / 'registry.json'))
    server = ControlServer(directory, 'generation-1', owner)
    server.start()
    try:
        print('ready', flush=True)
        await asyncio.to_thread(sys.stdin.readline)
    finally:
        owner.close()
        server.stop()

asyncio.run(main())
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
        .expect("run uv sync --locked in crates/runner/mitm-addon before runner tests");
    let mut lines = tokio::io::BufReader::new(child.stdout.take().unwrap()).lines();
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(10), lines.next_line())
            .await
            .unwrap()
            .unwrap()
            .as_deref(),
        Some("ready")
    );
    let publication = RegistryPublication {
        digest: RegistryDigest::of(content),
        target: Some(ControlTarget {
            directory: directory.path().to_path_buf(),
            generation: "generation-1".to_owned(),
        }),
    };
    let applied = publication.apply().await.unwrap();
    assert!(matches!(applied.state, ApplicationState::Applied));
    assert!(matches!(
        applied.snapshot,
        RegistrySnapshot::Available {
            catalog: CatalogSnapshot::NotUsed,
            valid_entries: 0,
            ..
        }
    ));
    crate::state_file::write_private_atomic(&path, br#"{"sandboxes":{},"updatedAt":2}"#)
        .await
        .unwrap();
    let observed: RegistrySnapshot = control::exchange(
        directory.path(),
        "generation-1",
        "registry.status",
        json!({}),
        tokio::time::Instant::now() + Duration::from_secs(5),
    )
    .await
    .unwrap();
    assert!(
        matches!(observed, RegistrySnapshot::Available { digest, .. } if digest == publication.digest)
    );
    assert!(matches!(
        publication.apply().await.unwrap().state,
        ApplicationState::Superseded
    ));
    let catalog_path = directory.path().join("catalog.json");
    let catalog_digest = "a".repeat(64);
    let catalog = json!({
        "schemaVersion": api_contracts::generated::constants::runners::BUILTIN_FIREWALL_CATALOG_CACHE_SCHEMA_VERSION,
        "catalogDigest": format!("sha256:{catalog_digest}"),
        "catalogVersion": "control-test",
        "updatedAt": "2026-09-15T00:00:00.000Z",
        "firewalls": {"example": {"name": "example", "apis": [{
            "base": "https://example.com", "auth": {"headers": {}},
            "permissions": [{"name": "read", "rules": ["GET /items"]}]
        }]}}
    });
    crate::state_file::write_private_atomic(&catalog_path, &serde_json::to_vec(&catalog).unwrap())
        .await
        .unwrap();
    let builtin_registry = serde_json::to_vec(&json!({
        "sandboxes": {"10.200.0.1": {
            "runId": "run-1", "billableFirewalls": [], "cliAgentType": "claude-code",
            "firewalls": [{"kind": "builtin", "name": "example"}]
        }}, "updatedAt": 2
    }))
    .unwrap();
    crate::state_file::write_private_atomic(&path, &builtin_registry)
        .await
        .unwrap();
    let publication = RegistryPublication {
        digest: RegistryDigest::of(&builtin_registry),
        target: publication.target,
    };
    assert!(matches!(
        publication.apply().await.unwrap().snapshot,
        RegistrySnapshot::Available {
            catalog: CatalogSnapshot::Available { digest, .. },
            valid_entries: 1,
            omitted_entries: 0,
            ..
        } if digest.0 == catalog_digest
    ));
    tokio::fs::remove_file(&catalog_path).await.unwrap();
    let missing_catalog = publication.apply().await.unwrap();
    assert!(
        matches!(
            missing_catalog.snapshot,
            RegistrySnapshot::Available {
                catalog: CatalogSnapshot::Unavailable {
                    reason: CatalogUnavailableReason::FileMissing,
                    ..
                },
                valid_entries: 0,
                rejected_entries: 1,
                omitted_entries: 0,
                ..
            },
        ),
        "{missing_catalog:?}"
    );
    crate::state_file::write_private_atomic(&path, b"{invalid")
        .await
        .unwrap();
    let rejected = publication.apply().await.unwrap();
    assert!(matches!(rejected.state, ApplicationState::Rejected));
    assert!(matches!(
        rejected.snapshot,
        RegistrySnapshot::Unavailable {
            reason: RegistryUnavailableReason::Parse,
            ..
        }
    ));
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
