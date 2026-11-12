use super::*;
use std::os::unix::fs::PermissionsExt;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixStream;
use uuid::Uuid;

use super::test_support::{HOST, TOKEN};

fn identity(id: u128) -> RunnerProcessIdentity {
    RunnerProcessIdentity::new(Uuid::from_u128(id), 7).unwrap()
}

fn namespace() -> (tempfile::TempDir, PathBuf) {
    let root = tempfile::tempdir().unwrap();
    let path = root.path().join("ingress");
    std::fs::create_dir(&path).unwrap();
    std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o710)).unwrap();
    (root, path)
}

async fn request(path: &std::path::Path, request: &str) -> (u16, String) {
    tokio::time::timeout(Duration::from_secs(5), async {
        let mut stream = UnixStream::connect(path).await.unwrap();
        stream.write_all(request.as_bytes()).await.unwrap();
        let mut bytes = Vec::new();
        stream.read_to_end(&mut bytes).await.unwrap();
        let response = String::from_utf8(bytes).unwrap();
        let (head, body) = response.split_once("\r\n\r\n").unwrap();
        (
            head.split_whitespace().nth(1).unwrap().parse().unwrap(),
            body.to_owned(),
        )
    })
    .await
    .unwrap()
}

fn health_request(id: RunnerProcessIdentity, credential: &str) -> String {
    format!(
        "GET /runners/{}/control/health HTTP/1.1\r\nHost: {HOST}\r\nAuthorization: Bearer {credential}\r\n\r\n",
        id.runner_id()
    )
}

fn dispatch_request(
    id: RunnerProcessIdentity,
    run: runner_types::ids::RunId,
    body: &str,
) -> String {
    format!(
        "POST /runners/{}/control/runs/{run}/dispatch HTTP/1.1\r\nHost: {HOST}\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
        id.runner_id(),
        body.len()
    )
}

#[tokio::test]
async fn dispatch_rejects_untrusted_routing_auth_and_bounded_body_without_custody() {
    use serde_json::json;
    let (_root, directory) = namespace();
    let id = identity(1);
    let runtime = IngressRuntime::start(directory.clone(), id, HOST.into(), TOKEN)
        .await
        .unwrap();
    let (intake, mut receiver) =
        dispatch::DispatchIntake::new(Arc::new(tokio::sync::Semaphore::new(4)));
    runtime.enable_dispatch(intake);
    let socket = directory.join(format!("{}.sock", id.runner_id()));
    let run_id = runner_types::ids::RunId::new_v4();
    let valid = json!({
        "runnerId": id.runner_id(), "heartbeatGeneration": id.heartbeat_generation(),
        "profile": "vm0/default", "notAfter": dispatch::now_ms() + 60_000,
        "executionContext": {"runId": run_id, "sandboxToken": "run-token", "prompt": "hello", "cliAgentType": "", "platformEnvironment": {}, "connectorRuntimeTargets": [], "contentBundles": {"format": "tar-gzip-v1", "skills": []}}
    });
    let base = dispatch_request(id, run_id, &valid.to_string());
    for (bad, status) in [
        (base.replace(TOKEN, "bad-token"), 401),
        (base.replace(HOST, "other.example.org"), 404),
        (base.replace("/control/runs/", "/sandbox/runs/"), 404),
        (base.replace("/control/runs/", "/control%2fruns/"), 404),
        (
            base.replace("/dispatch HTTP", "/dispatch?query=1 HTTP"),
            404,
        ),
        (
            base.replace("Content-Type: application/json", "Content-Type: text/plain"),
            400,
        ),
        (
            base.replace(
                "Content-Type: application/json",
                "Content-Type: application/json\r\nContent-Encoding: gzip",
            ),
            400,
        ),
        (
            base.replace(
                "Content-Type: application/json",
                "Content-Type: application/json\r\nUpgrade: websocket",
            ),
            400,
        ),
        (
            base.replace(
                &format!("Content-Length: {}", valid.to_string().len()),
                "Content-Length: 4194305",
            ),
            413,
        ),
    ] {
        assert_eq!(request(&socket, &bad).await.0, status);
    }
    let mut invalids = vec!["{".to_owned()];
    for (key, value) in [
        ("runnerId", json!(identity(2).runner_id())),
        ("heartbeatGeneration", json!(8)),
        ("notAfter", json!(1)),
        ("notAfter", json!(dispatch::now_ms() + 120_000)),
    ] {
        let mut body = valid.clone();
        body[key] = value;
        invalids.push(body.to_string());
    }
    for (key, value) in [
        ("runId", json!(runner_types::ids::RunId::new_v4())),
        ("sandboxToken", json!("")),
        ("platformEnvironment", json!(null)),
        ("contentBundles", json!({"format":"unknown", "skills":[]})),
    ] {
        let mut body = valid.clone();
        body["executionContext"][key] = value;
        invalids.push(body.to_string());
    }
    for body in invalids {
        let response = request(&socket, &dispatch_request(id, run_id, &body)).await;
        assert_eq!(response.0, 200);
        assert_eq!(
            serde_json::from_str::<serde_json::Value>(&response.1).unwrap()["disposition"],
            "unknown"
        );
    }
    assert!(matches!(
        receiver.try_recv(),
        Err(tokio::sync::mpsc::error::TryRecvError::Empty)
    ));
    runtime.shutdown().await;

    // A replacement process cannot answer for the previous generation's custody.
    let restarted =
        RunnerProcessIdentity::new(id.runner_id(), id.heartbeat_generation() + 1).unwrap();
    let runtime = IngressRuntime::start(directory, restarted, HOST.into(), TOKEN)
        .await
        .unwrap();
    let (intake, mut receiver) =
        dispatch::DispatchIntake::new(Arc::new(tokio::sync::Semaphore::new(4)));
    runtime.enable_dispatch(intake);
    let response = request(
        &socket,
        &dispatch_request(restarted, run_id, &valid.to_string()),
    )
    .await;
    let body: serde_json::Value = serde_json::from_str(&response.1).unwrap();
    assert_eq!(body["disposition"], "unknown");
    assert_eq!(
        body["heartbeatGeneration"],
        restarted.heartbeat_generation()
    );
    assert!(matches!(
        receiver.try_recv(),
        Err(tokio::sync::mpsc::error::TryRecvError::Empty)
    ));
    runtime.shutdown().await;
}

#[tokio::test]
async fn dispatch_bounds_chunked_bodies_even_without_content_length() {
    let (_root, directory) = namespace();
    let id = identity(1);
    let runtime = IngressRuntime::start(directory.clone(), id, HOST.into(), TOKEN)
        .await
        .unwrap();
    let (intake, mut receiver) =
        dispatch::DispatchIntake::new(Arc::new(tokio::sync::Semaphore::new(4)));
    runtime.enable_dispatch(intake);
    let socket = directory.join(format!("{}.sock", id.runner_id()));
    let run_id = runner_types::ids::RunId::new_v4();
    let mut stream = UnixStream::connect(&socket).await.unwrap();
    stream.write_all(format!("POST /runners/{}/control/runs/{run_id}/dispatch HTTP/1.1\r\nHost: {HOST}\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n{:x}\r\n", id.runner_id(), dispatch::MAX_BODY+1).as_bytes()).await.unwrap();
    let body = vec![b' '; dispatch::MAX_BODY + 1];
    // Early rejection may close the writer after the limit is crossed.
    let _ = stream.write_all(&body).await;
    let _ = stream.write_all(b"\r\n0\r\n\r\n").await;
    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut response))
        .await
        .unwrap()
        .unwrap();
    assert!(
        String::from_utf8(response)
            .unwrap()
            .starts_with("HTTP/1.1 413")
    );
    assert!(matches!(
        receiver.try_recv(),
        Err(tokio::sync::mpsc::error::TryRecvError::Empty)
    ));
    runtime.shutdown().await;
}

#[tokio::test]
async fn incomplete_dispatch_body_times_out_and_releases_its_transaction_slot() {
    let (_root, directory) = namespace();
    let id = identity(1);
    let runtime = IngressRuntime::start(directory.clone(), id, HOST.into(), TOKEN)
        .await
        .unwrap();
    let (intake, _receiver) =
        dispatch::DispatchIntake::new(Arc::new(tokio::sync::Semaphore::new(1)));
    runtime.enable_dispatch(intake);
    let socket = directory.join(format!("{}.sock", id.runner_id()));
    let run_id = runner_types::ids::RunId::new_v4();
    let mut stream = UnixStream::connect(&socket).await.unwrap();
    stream.write_all(format!("POST /runners/{}/control/runs/{run_id}/dispatch HTTP/1.1\r\nHost: {HOST}\r\nAuthorization: Bearer {TOKEN}\r\nContent-Type: application/json\r\nContent-Length: 2\r\nExpect: 100-continue\r\n\r\n", id.runner_id()).as_bytes()).await.unwrap();
    let mut interim = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), async {
        while !interim.ends_with(b"\r\n\r\n") {
            interim.push(stream.read_u8().await.unwrap());
        }
    })
    .await
    .unwrap();
    assert!(
        String::from_utf8(interim)
            .unwrap()
            .starts_with("HTTP/1.1 100")
    );
    // 100 Continue proves the real body read is armed; only its timer phase uses virtual time.
    raw_http_test_support::clock::advance_timer_phase(Duration::from_secs(6)).await;
    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(5), stream.read_to_end(&mut response))
        .await
        .unwrap()
        .unwrap();
    assert!(
        String::from_utf8(response)
            .unwrap()
            .starts_with("HTTP/1.1 408")
    );
    assert_eq!(
        request(&socket, &dispatch_request(id, run_id, "{")).await.0,
        200,
        "the sole shared slot must be available again"
    );
    runtime.shutdown().await;
}

#[tokio::test]
async fn unix_health_uses_official_service_auth_and_routes_are_disjoint() {
    let (_root, directory) = namespace();
    let first = IngressRuntime::start(directory.clone(), identity(1), HOST.into(), TOKEN)
        .await
        .unwrap();
    let second = IngressRuntime::start(directory.clone(), identity(2), HOST.into(), TOKEN)
        .await
        .unwrap();
    let first_path = directory.join(format!("{}.sock", identity(1).runner_id()));
    let second_path = directory.join(format!("{}.sock", identity(2).runner_id()));
    let token = TOKEN;
    let valid = health_request(identity(1), token);
    let (status, body) = request(&first_path, &valid).await;
    assert_eq!(status, 200);
    assert_eq!(body, "ok");
    assert_eq!(
        request(&second_path, &health_request(identity(2), token))
            .await
            .0,
        200
    );
    for (bad, expected) in [
        (
            valid.replace(token, &format!("vm0_official_{}", "f".repeat(64))),
            401,
        ),
        (
            valid.replace(&format!("Authorization: Bearer {token}\r\n"), ""),
            401,
        ),
        (valid.replace(HOST, "other.example.org"), 404),
        (
            valid.replace("control/health", "sandbox/control/health"),
            404,
        ),
        (valid.replace("control/health", "control%2fhealth"), 404),
        (
            valid.replace("control/health", "sandbox/../control/health"),
            404,
        ),
        (
            valid.replace(
                "control/health",
                "sandbox/runs/00000000-0000-0000-0000-000000000001/dispatch",
            ),
            404,
        ),
        (
            valid.replace("control/health", "control/health?query=1"),
            404,
        ),
        (valid.replacen("GET", "POST", 1), 405),
        (
            valid.replace("\r\n\r\n", "\r\nUpgrade: websocket\r\n\r\n"),
            400,
        ),
        (
            valid.replace("\r\n\r\n", "\r\nContent-Length: 1\r\n\r\nx"),
            400,
        ),
    ] {
        let (status, body) = request(&first_path, &bad).await;
        assert_eq!(status, expected, "{bad}");
        assert!(body.is_empty());
    }
    assert_eq!(
        request(&first_path, &health_request(identity(2), token))
            .await
            .0,
        404
    );
    first.shutdown().await;
    second.shutdown().await;
    assert_eq!(std::fs::read_dir(directory).unwrap().count(), 0);
}

#[tokio::test]
async fn shutdown_joins_connections_and_service_auth_survives_runner_restart() {
    let (_root, directory) = namespace();
    let first = IngressRuntime::start(directory.clone(), identity(1), HOST.into(), TOKEN)
        .await
        .unwrap();
    let path = directory.join(format!("{}.sock", identity(1).runner_id()));
    let mut slow = UnixStream::connect(&path).await.unwrap();
    slow.write_all(b"GET ").await.unwrap();
    first.shutdown().await;
    assert!(!path.exists());
    let mut buffer = [0u8; 32];
    let closed = tokio::time::timeout(Duration::from_secs(5), slow.read(&mut buffer))
        .await
        .unwrap();
    assert!(matches!(closed, Ok(0) | Err(_)));
    let restarted = RunnerProcessIdentity::new(identity(1).runner_id(), 8).unwrap();
    let second = IngressRuntime::start(directory, restarted, HOST.into(), TOKEN)
        .await
        .unwrap();
    assert_eq!(
        request(&path, &health_request(restarted, TOKEN)).await.0,
        200
    );
    second.shutdown().await;
}

#[tokio::test]
async fn unsafe_namespace_or_noncanonical_host_fails_ingress_startup() {
    let (_root, directory) = namespace();
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o777)).unwrap();
    assert!(
        IngressRuntime::start(directory.clone(), identity(1), HOST.into(), TOKEN)
            .await
            .is_err()
    );
    assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 0);
    std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o710)).unwrap();
    for hostname in [
        "localhost",
        "127.0.0.1",
        "runner.internal",
        "Runner.example.org",
        "runner.example.org:443",
    ] {
        assert!(
            IngressRuntime::start(directory.clone(), identity(1), hostname.into(), TOKEN)
                .await
                .is_err()
        );
        assert_eq!(std::fs::read_dir(&directory).unwrap().count(), 0);
    }
}

#[tokio::test]
async fn public_health_requires_successful_bounded_ok_response() {
    use httpmock::{Method::GET, MockServer};

    let server = MockServer::start_async().await;
    let client = reqwest::Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(HEALTH_TIMEOUT)
        .build()
        .unwrap();
    let health = IngressHandler::new(identity(1), HOST.into(), TOKEN);
    let path = format!("/runners/{}/control/health", identity(1).runner_id());
    for (status, body, accepted) in [
        (200, "ok".into(), true),
        (401, String::new(), false),
        (302, "ok".into(), false),
        (200, "no".into(), false),
        (200, " ".repeat(MAX_HEALTH_RESPONSE_BYTES + 1), false),
    ] {
        let mock = server
            .mock_async(|when, then| {
                when.method(GET)
                    .path(&path)
                    .header("authorization", format!("Bearer {TOKEN}"));
                then.status(status).body(body);
            })
            .await;
        assert_eq!(
            health.check(&client, &server.url(&path)).await.is_ok(),
            accepted
        );
        mock.assert_async().await;
        mock.delete_async().await;
    }
}
