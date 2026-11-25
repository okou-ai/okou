use std::sync::Arc;
use std::time::Duration;

use guest_contracts::stdout_framing::MEMORY_PUBLISHED_MARKER;
use runner_types::storage_manifest::{ArtifactEntry, StorageManifest};
use sandbox::ProcessOutputChunk;
use sandbox_mock::MockSandboxOverrides;
use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio_util::task::AbortOnDropHandle;

use super::super::super::*;
use super::super::support::{
    minimal_context, mock_run_config_with_overrides_and_api_url, push_job, shutdown, test_profiles,
};
use crate::test_fixtures::raw_http::{http_response, json_response, read_http_request};
use crate::tests::status_active_run_records;

#[tokio::test]
async fn committed_memory_lookup_starts_after_run_settlement() {
    run_memory_lookup_case(Some(LookupResponse::MissingRoute)).await;
}

#[tokio::test]
async fn committed_memory_lookup_warms_the_published_archive() {
    run_memory_lookup_case(Some(LookupResponse::Archive)).await;
}

#[tokio::test]
async fn committed_memory_lookup_skips_runs_without_a_publication_hint() {
    run_memory_lookup_case(None).await;
}

#[derive(Clone, Copy)]
enum LookupResponse {
    MissingRoute,
    Archive,
}

async fn run_memory_lookup_case(lookup_response: Option<LookupResponse>) {
    const WAIT: Duration = Duration::from_secs(5);
    const VERSION: &str = "committed-memory-version";
    const ARCHIVE: &[u8] = b"committed memory archive bytes";
    let run_id = RunId::new_v4();
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let api_url = format!("http://{}", listener.local_addr().unwrap());
    let (lookup, mut observed_lookup) = oneshot::channel();
    let (stop, mut stopped) = oneshot::channel();
    let server = AbortOnDropHandle::new(tokio::spawn(async move {
        let mut lookup = Some(lookup);
        loop {
            let (mut socket, _) = tokio::select! {
                _ = &mut stopped => return,
                accepted = listener.accept() => accepted.unwrap(),
            };
            let request = read_http_request(&mut socket).await.unwrap();
            let request_line = request.lines().next().unwrap();
            let response = if request_line
                .starts_with("GET /api/webhooks/run/storages/memory-archive?includeDeltaBase=true ")
            {
                assert!(request.lines().any(|line| {
                    line.split_once(':').is_some_and(|(name, value)| {
                        name.eq_ignore_ascii_case("authorization")
                            && value.trim() == "Bearer host-firewall-token"
                    })
                }));
                lookup
                    .take()
                    .expect("one Memory lookup")
                    .send(socket)
                    .unwrap();
                continue;
            } else if request_line.starts_with("GET /committed-memory.tar.gz ") {
                assert!(matches!(lookup_response, Some(LookupResponse::Archive)));
                http_response("200 OK", ARCHIVE)
            } else if request_line.starts_with(&format!("PUT /api/runners/runs/{run_id}/startup "))
            {
                http_response("204 No Content", b"")
            } else {
                assert!(request_line.starts_with("POST /api/webhooks/run/telemetry "));
                json_response("200 OK", r#"{"success":true,"id":"ok"}"#)
            };
            socket.write_all(&response).await.unwrap();
        }
    }));

    let overrides = Arc::new(MockSandboxOverrides::new());
    if lookup_response.is_some() {
        let (first, last) = MEMORY_PUBLISHED_MARKER.as_bytes().split_at(10);
        overrides.push_start_process_stdout_chunks(
            [first, last]
                .into_iter()
                .map(|bytes| ProcessOutputChunk {
                    bytes: bytes.to_vec(),
                    truncated: false,
                })
                .collect(),
        );
    }
    let (config, env) = mock_run_config_with_overrides_and_api_url(
        test_profiles(),
        2,
        4096,
        1,
        overrides,
        &api_url,
    );
    let budget = Arc::clone(&config.capacity.budget);
    let status_path = env._temp_dir.path().join("status.json");
    let cached_archive = config
        .exec_config
        .home
        .storage_cache_dir("memory", VERSION)
        .join("archive.tar.gz");
    let mut context = minimal_context(run_id);
    context.firewall_token = Some("host-firewall-token".into());
    context.storage_manifest = Some(StorageManifest {
        artifacts: vec![ArtifactEntry {
            mount_path: "/home/user/memory".into(),
            vas_storage_name: "memory".into(),
            vas_storage_id: "fixture-memory".into(),
            vas_version_id: "empty-memory".into(),
            archive_url: None,
            archive_size: None,
            empty: Some(true),
            missing_root_policy: None,
        }],
        ..StorageManifest::default()
    });
    let runner = AbortOnDropHandle::new(tokio::spawn(run(config)));
    push_job(&env, run_id, "vm0/default", Some(context));

    let Some(lookup_response) = lookup_response else {
        let completed = env.handle.wait_completion(run_id, WAIT).await.unwrap();
        assert_eq!(completed.exit_code, 0);
        shutdown(&env, runner.detach()).await;
        stop.send(()).unwrap();
        server.await.unwrap();
        assert!(matches!(
            observed_lookup.try_recv(),
            Err(oneshot::error::TryRecvError::Closed)
        ));
        return;
    };

    let mut lookup = tokio::time::timeout(WAIT, observed_lookup)
        .await
        .expect("Runner should request the committed Memory archive")
        .unwrap();
    let completed = env
        .handle
        .wait_completion(run_id, Duration::ZERO)
        .await
        .expect("completion must already be reported when the lookup begins");
    assert_eq!(completed.exit_code, 0);
    assert_eq!(env.handle.completion_in_flight(), 0);
    assert!(!env.active_runs.contains(run_id));
    assert_eq!(budget.allocated().2, 0);
    assert!(status_active_run_records(&status_path).await.is_empty());

    let reply = match lookup_response {
        LookupResponse::MissingRoute => http_response("404 Not Found", b""),
        LookupResponse::Archive => json_response(
            "200 OK",
            &serde_json::json!({
                "archive": {
                    "versionId": VERSION,
                    "archiveSize": ARCHIVE.len(),
                    "archiveUrl": format!("{api_url}/committed-memory.tar.gz"),
                },
            })
            .to_string(),
        ),
    };
    lookup.write_all(&reply).await.unwrap();
    drop(lookup);
    if matches!(lookup_response, LookupResponse::Archive) {
        let content = tokio::time::timeout(WAIT, async {
            loop {
                match tokio::fs::read(&cached_archive).await {
                    Ok(content) => break content,
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        tokio::task::yield_now().await;
                    }
                    Err(error) => panic!("read warmed archive: {error}"),
                }
            }
        })
        .await
        .expect("Runner should publish the fetched archive to its versioned cache");
        assert_eq!(content, ARCHIVE);
    }
    shutdown(&env, runner.detach()).await;
    stop.send(()).unwrap();
    server.await.unwrap();
}
