use std::os::fd::AsRawFd;
use std::os::unix::fs::PermissionsExt;

use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};

use super::*;

mod observer;

const PYTHON_OWNER_GENERATION: &str = "generation-1";

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

async fn start_real_python_registry_owner(directory: &std::path::Path) -> tokio::process::Child {
    let python = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../runner/mitm-addon/.venv/bin/python");
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
    server = ControlServer(directory, sys.argv[2], owner)
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
        .arg(directory)
        .arg(PYTHON_OWNER_GENERATION)
        .env(
            "PYTHONPATH",
            concat!(env!("CARGO_MANIFEST_DIR"), "/../runner/mitm-addon/src"),
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
    child
}

async fn stop_real_python_registry_owner(mut child: tokio::process::Child) {
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
async fn real_python_registry_owner_accepts_rust_writer_source_bound_inline_builtin() {
    use std::collections::HashMap;
    use std::path::Path;

    use crate::proxy::{ProxyRegistryHandle, SandboxRegistration};
    use runner_types::types::{
        ConnectorRuntimeTargetRegistration, Firewall, FirewallApi, FirewallAuth, FirewallEntry,
    };

    let directory = tempfile::Builder::new()
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap();
    let registry_path = directory.path().join("registry.json");
    runner_host::state_file::write_private_atomic(
        &registry_path,
        br#"{"sandboxes":{},"updatedAt":1}"#,
    )
    .await
    .unwrap();
    let child = start_real_python_registry_owner(directory.path()).await;
    let registry =
        ProxyRegistryHandle::new(registry_path, directory.path().join("proxy-registry.lock"));
    registry.set_control_target_for_test(
        directory.path().to_path_buf(),
        PYTHON_OWNER_GENERATION.to_owned(),
    );

    let source_id = "550e8400-e29b-41d4-a716-446655440001";
    let firewalls = [FirewallEntry::Inline {
        firewall: Firewall {
            name: "builtin-mcp".to_owned(),
            apis: vec![FirewallApi {
                id: "builtin-mcp:0".to_owned(),
                base: "https://mcp.example.test/server".to_owned(),
                auth: FirewallAuth {
                    headers: HashMap::new(),
                    base: None,
                    query: None,
                    aws_sigv4: None,
                },
                host_policy: None,
                permissions: None,
            }],
        },
        custom_connector_id: None,
        source_id: Some(source_id.to_owned()),
    }];
    let targets = [ConnectorRuntimeTargetRegistration::Builtin {
        connector_slug: "builtin-mcp".to_owned(),
        base_url_vars: None,
        source_id: Some(source_id.to_owned()),
    }];
    let registration = SandboxRegistration {
        run_id: "run-source-bound-inline-builtin",
        cli_agent_type: "claude-code",
        sandbox_token: "synthetic-token",
        network_log_path: Path::new("/tmp/network-source-bound-inline-builtin.jsonl"),
        proxy_log_path: Path::new("/tmp/proxy-source-bound-inline-builtin.jsonl"),
        firewalls: Some(&firewalls),
        network_policies: None,
        connector_runtime_targets: Some(&targets),
        encrypted_secrets: None,
        secret_connector_map: None,
        secret_connector_metadata_map: None,
        vars: None,
        capture_network_bodies: false,
        billable_firewalls: &[],
        model_usage_provider: None,
    };
    // #35930 escaped because the Python test hand-authored target metadata that
    // this production writer did not emit. Keep this boundary writer-owned.
    let publication = registry
        .register_sandbox("10.200.0.1", &registration)
        .await
        .unwrap();
    let applied = publication.apply().await.unwrap();

    assert!(matches!(&applied.state, ApplicationState::Applied));
    assert!(
        matches!(
            &applied.snapshot,
            RegistrySnapshot::Available {
                catalog: CatalogSnapshot::NotUsed,
                valid_entries: 1,
                rejected_entries: 0,
                ..
            }
        ),
        "{applied:?}"
    );
    stop_real_python_registry_owner(child).await;
}

#[tokio::test]
async fn real_python_registry_owner_reports_publication_and_catalog_evidence() {
    let directory = tempfile::Builder::new()
        .permissions(std::fs::Permissions::from_mode(0o700))
        .tempdir()
        .unwrap();
    let path = directory.path().join("registry.json");
    let content = br#"{"sandboxes":{},"updatedAt":1}"#;
    runner_host::state_file::write_private_atomic(&path, content)
        .await
        .unwrap();
    let child = start_real_python_registry_owner(directory.path()).await;
    let publication = RegistryPublication {
        digest: RegistryDigest::of(content),
        target: Some(ControlTarget {
            directory: directory.path().to_path_buf(),
            generation: PYTHON_OWNER_GENERATION.to_owned(),
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
    runner_host::state_file::write_private_atomic(&path, br#"{"sandboxes":{},"updatedAt":2}"#)
        .await
        .unwrap();
    let observed: RegistrySnapshot = control::exchange(
        directory.path(),
        PYTHON_OWNER_GENERATION,
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
    runner_host::state_file::write_private_atomic(
        &catalog_path,
        &serde_json::to_vec(&catalog).unwrap(),
    )
    .await
    .unwrap();
    let builtin_registry = serde_json::to_vec(&json!({
        "sandboxes": {"10.200.0.1": {
            "runId": "run-1", "billableFirewalls": [], "cliAgentType": "claude-code",
            "firewalls": [{"kind": "builtin", "name": "example"}]
        }}, "updatedAt": 2
    }))
    .unwrap();
    runner_host::state_file::write_private_atomic(&path, &builtin_registry)
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
    runner_host::state_file::write_private_atomic(&path, b"{invalid")
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
    stop_real_python_registry_owner(child).await;
}
