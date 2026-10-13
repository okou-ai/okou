//! Actual process file/stderr/Axiom/Sentry composition, isolated in guarded children.

use std::{
    sync::{Arc, Mutex},
    time::Duration,
};

const PRIVATE_CANARY: &str = "NATIVE_PRIVATE_AUTH_URL_REGISTRATION_KEY_CANARY_37639";
const ORDINARY_PANIC: &str = "ordinary Runner panic canary";

#[derive(Clone)]
struct Capture(Arc<Mutex<Vec<Vec<u8>>>>);

impl sentry::Transport for Capture {
    fn send_envelope(&self, envelope: sentry::Envelope) {
        let mut bytes = Vec::new();
        envelope.to_writer(&mut bytes).unwrap();
        self.0.lock().unwrap().push(bytes);
    }
}

#[tokio::test]
async fn native_privacy_protects_worker_and_blocking_descendants_in_production_sinks() {
    for mode in ["worker", "blocking", "auth_error", "body_error"] {
        let evidence = tempfile::tempdir().unwrap();
        let evidence_path = evidence.path().to_str().expect("UTF-8 evidence path");
        let output = runner_host::test_fixtures::ignored_child::run_ignored_child_test(
            "native_privacy::native_privacy_child",
            ("OKOU_NATIVE_PRIVACY_CHILD", "1"),
            &[
                ("OKOU_NATIVE_PRIVACY_MODE", Some(mode)),
                ("OKOU_NATIVE_PRIVACY_EVIDENCE", Some(evidence_path)),
            ],
            Duration::from_secs(30),
        )
        .await;
        assert!(
            !output.truncated,
            "privacy checks require complete stdout and stderr"
        );
        let stdout = output.stdout;
        let stderr = output.stderr;
        let report: serde_json::Value =
            serde_json::from_slice(&std::fs::read(evidence.path().join("report.json")).unwrap())
                .unwrap();
        for bytes in [stdout.as_str(), stderr.as_str(), &report.to_string()] {
            assert!(
                !bytes.contains(PRIVATE_CANARY),
                "private diagnostic escaped its resource domain"
            );
        }
        assert!(stderr.contains("native Tailscale resource domain failed"));
        assert!(
            stderr.contains(ORDINARY_PANIC),
            "unrelated panic behavior is preserved"
        );
        assert!(stderr.contains("ordinary HTTP diagnostic"));
        assert!(
            report["files"]
                .as_str()
                .unwrap()
                .contains("native Tailscale resource domain failed")
        );
        assert!(
            report["axiom"]
                .to_string()
                .contains("native Tailscale resource domain failed")
        );
        if matches!(mode, "worker" | "blocking") {
            assert!(
                report["sentry"]
                    .to_string()
                    .contains("native Tailscale resource domain failed")
            );
        }
        assert!(report["sentry"].to_string().contains(ORDINARY_PANIC));
        assert_eq!(
            report["requested"].as_bool().unwrap(),
            matches!(mode, "worker" | "blocking")
        );
        assert_eq!(
            report["provider_operations"],
            match mode {
                "auth_error" => serde_json::json!(["oauth"]),
                "body_error" => serde_json::json!(["oauth", "create", "delete"]),
                _ => serde_json::json!(["oauth", "create", "http2", "delete"]),
            }
        );
    }
}

#[test]
#[ignore = "only the ordinary parent invokes this guarded process fixture"]
fn native_privacy_child() {
    if !runner_host::test_fixtures::ignored_child::ignored_child_test_env_guard_enabled((
        "OKOU_NATIVE_PRIVACY_CHILD",
        "1",
    )) {
        return;
    }
    let mode = std::env::var("OKOU_NATIVE_PRIVACY_MODE").unwrap();
    let blocking = mode == "blocking";
    let directory =
        std::path::PathBuf::from(std::env::var_os("OKOU_NATIVE_PRIVACY_EVIDENCE").unwrap());
    let captured = Arc::new(Mutex::new(Vec::new()));
    let transport: Arc<dyn sentry::Transport> = Arc::new(Capture(Arc::clone(&captured)));
    let mut options = sentry::ClientOptions::new()
        .default_integrations(false)
        .add_integration(sentry::integrations::panic::PanicIntegration::default());
    options.transport = Some(Arc::new(move |_: &sentry::ClientOptions| {
        Arc::clone(&transport)
    }));
    let _sentry = sentry::init(("http://synthetic@127.0.0.1/1", options));
    super::install_native_panic_hook();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        use bytes::Bytes;
        use http_body_util::{BodyExt, Full};
        use hyper::{Response, server::conn::{http1, http2}, service::service_fn};
        use hyper_util::rt::{TokioExecutor, TokioIo};

        let axiom = httpmock::MockServer::start_async().await;
        let ingests = Arc::new(Mutex::new(Vec::<Vec<u8>>::new()));
        let incoming = Arc::clone(&ingests);
        let _ingest = axiom.mock_async(move |when, then| {
            when.method("POST").path("/v1/datasets/vm0-web-logs-native-privacy/ingest");
            then.respond_with(move |request: &httpmock::HttpMockRequest| {
                incoming.lock().unwrap().push(request.body_ref().to_vec());
                httpmock::HttpMockResponse::builder().status(200).build()
            });
        }).await;
        let (layer, guard) = super::axiom_layer::init_with_base_url(&axiom.base_url(), "synthetic-token", "native-privacy").unwrap();
        let file_guard = super::init_tracing_at(directory.join("logs"), Some(layer)).unwrap();
        tracing::warn!(target: "hyper", "ordinary HTTP diagnostic");

        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let requested = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let observed = Arc::clone(&requested);
        let operations = Arc::new(Mutex::new(Vec::new()));
        let recorded = Arc::clone(&operations);
        let peer = tokio::spawn(async move {
            let steps = match mode.as_str() {
                "auth_error" => vec![0],
                "body_error" => vec![0, 1, 3],
                _ => vec![0, 1, 2, 3],
            };
            let auth_error = mode == "auth_error";
            let body_error = mode == "body_error";
            for index in steps {
                let (socket, _) = listener.accept().await.unwrap();
                let observed = Arc::clone(&observed);
                let recorded = Arc::clone(&recorded);
                let service = service_fn(move |request: hyper::Request<hyper::body::Incoming>| {
                    let observed = Arc::clone(&observed);
                    let recorded = Arc::clone(&recorded);
                    async move {
                        let (head, body) = request.into_parts();
                        let body = body.collect().await.unwrap().to_bytes();
                        let response = match index {
                            0 => {
                                assert_eq!(head.method, "POST");
                                assert_eq!(head.uri.path(), "/api/v2/oauth/token");
                                assert_eq!(head.headers["Host"], "api.tailscale.com");
                                assert!(String::from_utf8_lossy(&body).contains(PRIVATE_CANARY));
                                recorded.lock().unwrap().push("oauth");
                                let mut response = serde_json::json!({"access_token": PRIVATE_CANARY, "token_type": "Bearer", "expires_in": 3600, "scope": "auth_keys"});
                                if auth_error {
                                    response["error"] = format!("https://private.synthetic.invalid/{PRIVATE_CANARY}").into();
                                }
                                serde_json::to_vec(&response).unwrap()
                            }
                            1 => {
                                assert_eq!(head.method, "POST");
                                assert_eq!(head.uri.path(), "/api/v2/tailnet/-/keys");
                                assert_eq!(head.headers["Authorization"], format!("Bearer {PRIVATE_CANARY}"));
                                let body: serde_json::Value = serde_json::from_slice(&body).unwrap();
                                assert_eq!(body["expirySeconds"], 7200);
                                assert_eq!(body["capabilities"]["devices"]["create"], serde_json::json!({"reusable": false, "ephemeral": true, "preauthorized": true, "tags": ["tag:ssh"]}));
                                recorded.lock().unwrap().push("create");
                                let now = chrono::Utc::now();
                                let mut response = serde_json::json!({"id": format!("{PRIVATE_CANARY}/key"), "key": format!("tskey-auth-{PRIVATE_CANARY}"), "created": now.to_rfc3339(), "expires": (now + chrono::Duration::hours(2)).to_rfc3339(), "capabilities": body["capabilities"]});
                                if body_error {
                                    response["capabilities"]["devices"]["create"]["reusable"] = true.into();
                                }
                                serde_json::to_vec(&response).unwrap()
                            }
                            2 => {
                                assert_eq!(head.uri.path(), "/native-privacy-qualification");
                                assert_eq!(head.headers["Authorization"], format!("Bearer {PRIVATE_CANARY}"));
                                observed.store(true, std::sync::atomic::Ordering::Release);
                                recorded.lock().unwrap().push("http2");
                                b"qualified".to_vec()
                            }
                            3 => {
                                assert_eq!(head.method, "DELETE");
                                assert_eq!(head.uri.path(), format!("/api/v2/tailnet/-/keys/{PRIVATE_CANARY}%2Fkey"));
                                assert_eq!(head.headers["Authorization"], format!("Bearer {PRIVATE_CANARY}"));
                                assert!(body.is_empty());
                                recorded.lock().unwrap().push("delete");
                                b"{}".to_vec()
                            }
                            _ => panic!("unexpected synthetic provider request"),
                        };
                        Ok::<_, std::convert::Infallible>(Response::new(Full::new(Bytes::from(response))))
                    }
                });
                if index == 2 {
                    let _ = http2::Builder::new(TokioExecutor::new()).serve_connection(TokioIo::new(socket), service).await;
                } else {
                    http1::Builder::new().serve_connection(TokioIo::new(socket), service).await.unwrap();
                }
            }
        });
        let result = tokio::time::timeout(Duration::from_secs(15), runner_remote::tailscale::diagnostic_fixture(address, blocking, PRIVATE_CANARY)).await.unwrap();
        assert_eq!(result, Err(runner_remote::tailscale::Failure::DomainFailed));
        tokio::time::timeout(Duration::from_secs(5), peer).await.unwrap().unwrap();
        let _ = std::panic::catch_unwind(|| panic!("{ORDINARY_PANIC}"));
        guard.shutdown().await;
        drop(file_guard);
        let mut files = String::new();
        for entry in std::fs::read_dir(directory.join("logs")).unwrap() {
            files.push_str(&std::fs::read_to_string(entry.unwrap().path()).unwrap());
        }
        let report = serde_json::json!({
            "files": files,
            "axiom": ingests.lock().unwrap().iter().map(|body| serde_json::from_slice::<serde_json::Value>(body).unwrap()).collect::<Vec<_>>(),
            "sentry": captured.lock().unwrap().iter().map(|body| String::from_utf8_lossy(body).into_owned()).collect::<Vec<_>>(),
            "requested": requested.load(std::sync::atomic::Ordering::Acquire),
            "provider_operations": *operations.lock().unwrap(),
        });
        std::fs::write(directory.join("report.json"), serde_json::to_vec(&report).unwrap()).unwrap();
    });
}
