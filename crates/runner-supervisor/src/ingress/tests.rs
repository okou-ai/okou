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
                "control/runs/00000000-0000-0000-0000-000000000001/dispatch",
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
    let health = Health::new(identity(1), HOST.into(), TOKEN);
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
