use super::super::super::*;
use super::super::support::{mock_run_config, shutdown, test_profiles, wait_status_mode};
use serde_json::{Value, json};
use std::os::unix::fs::PermissionsExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::{UnixListener, UnixStream};

fn catalog_peer(config: &RunConfig) -> UnixListener {
    let directory = config.paths.base_dir.join("catalog-control");
    std::fs::create_dir_all(&directory).unwrap();
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700)).unwrap();
    let listener = UnixListener::bind(directory.join("control.sock")).unwrap();
    config.proxy.mitm.set_control_directory_for_test(directory);
    listener
}

async fn warm_request(listener: &UnixListener) -> (UnixStream, Value) {
    let (mut stream, _) = tokio::time::timeout(Duration::from_secs(2), listener.accept())
        .await
        .unwrap()
        .unwrap();
    let size = stream.read_u32().await.unwrap();
    let mut bytes = vec![0; size as usize];
    stream.read_exact(&mut bytes).await.unwrap();
    let request: Value = serde_json::from_slice(&bytes).unwrap();
    assert_eq!(request["method"], "catalog.warm");
    assert_eq!(request["params"], json!({}));
    (stream, request)
}

async fn reply(stream: &mut UnixStream, request: &Value, result: Value) {
    let mut response = json!({
        "requestId": request["requestId"], "generation": request["generation"]
    });
    response
        .as_object_mut()
        .unwrap()
        .extend(result.as_object().unwrap().clone());
    let bytes = serde_json::to_vec(&response).unwrap();
    stream.write_u32(bytes.len() as u32).await.unwrap();
    stream.write_all(&bytes).await.unwrap();
    stream.shutdown().await.unwrap();
}

#[tokio::test]
async fn catalog_completion_precedes_running_and_discovery() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let listener = catalog_peer(&config);
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(run(config)));
    let (mut stream, request) = warm_request(&listener).await;
    wait_status_mode(&status_path, "starting", Duration::from_secs(2)).await;
    assert_eq!(env.handle.startup_readiness_calls(), 1);
    assert_eq!(env.handle.discover_started_count(), 0);
    reply(
        &mut stream,
        &request,
        json!({
            "type": "result", "data": {"state": "available",
            "file": {"device": 1, "inode": 2, "mtimeNs": 3, "size": 4},
            "digest": "a".repeat(64)}
        }),
    )
    .await;
    wait_status_mode(&status_path, "running", Duration::from_secs(5)).await;
    shutdown(&env, run_handle.detach()).await;
}

#[tokio::test]
async fn failed_catalog_initialization_does_not_admit_work() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let listener = catalog_peer(&config);
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(run(config)));
    let (mut stream, request) = warm_request(&listener).await;
    reply(
        &mut stream,
        &request,
        json!({"type": "error", "code": "internal_error"}),
    )
    .await;
    let error = tokio::time::timeout(Duration::from_secs(5), run_handle.detach())
        .await
        .unwrap()
        .unwrap()
        .expect_err("catalog failure must stop startup");
    assert!(
        error.to_string().contains("initialize addon catalog"),
        "{error}"
    );
    assert_eq!(env.handle.discover_started_count(), 0);
    wait_status_mode(&status_path, "stopped", Duration::from_secs(2)).await;
}

#[tokio::test]
async fn stop_during_catalog_initialization_does_not_wait_for_the_reply() {
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let listener = catalog_peer(&config);
    let status_path = env._temp_dir.path().join("status.json");
    let run_handle = tokio_util::task::AbortOnDropHandle::new(tokio::spawn(run(config)));
    let (_unanswered, _) = warm_request(&listener).await;
    env.cancel.cancel();
    tokio::time::timeout(Duration::from_secs(2), run_handle.detach())
        .await
        .unwrap()
        .unwrap()
        .unwrap();
    assert_eq!(env.handle.discover_started_count(), 0);
    wait_status_mode(&status_path, "stopped", Duration::from_secs(2)).await;
}
