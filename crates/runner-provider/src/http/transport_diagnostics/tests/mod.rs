use super::*;
use crate::error::ProviderError;
use crate::http::{HttpClient, HttpClientConfig};
use raw_http_test_support::raw_http::{RawHttpAction, RawHttpTestServer, join_raw_http_task};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tracing::instrument::WithSubscriber;
use tracing_subscriber::prelude::*;
use tracing_test_support::{CapturedEvents, find_captured_event};

pub(super) struct Signal(pub(super) mpsc::Sender<()>);

impl<S: tracing::Subscriber> tracing_subscriber::Layer<S> for Signal {
    fn on_event(&self, event: &tracing::Event<'_>, _: tracing_subscriber::layer::Context<'_, S>) {
        if event.metadata().target() == TARGET {
            let _ = self.0.try_send(());
        }
    }
}

pub(super) async fn wait_for_event(
    captured: &CapturedEvents,
    signal: &mut mpsc::Receiver<()>,
    predicate: impl Fn(&tracing_test_support::CapturedEvent) -> bool,
) {
    tokio::time::timeout(Duration::from_secs(5), async {
        loop {
            if captured.entries().iter().any(&predicate) {
                return;
            }
            signal.recv().await.expect("event signal sender retained");
        }
    })
    .await
    .expect("expected diagnostic event");
}

trait Peer: AsyncRead + AsyncWrite + Unpin + Send {
    fn reset(&self);
}

impl Peer for TcpStream {
    fn reset(&self) {
        self.set_zero_linger().unwrap();
    }
}

impl Peer for tokio_rustls::server::TlsStream<TcpStream> {
    fn reset(&self) {
        self.get_ref().0.set_zero_linger().unwrap();
    }
}

async fn request(peer: &mut dyn Peer) -> String {
    let mut bytes = Vec::new();
    loop {
        assert!(bytes.len() < 16 * 1024, "bounded fixture request");
        bytes.push(peer.read_u8().await.unwrap());
        if bytes.ends_with(b"\r\n\r\n") {
            break;
        }
    }
    String::from_utf8(bytes).unwrap()
}

fn client(url: &str) -> HttpClient {
    let client = HttpClient::new(HttpClientConfig {
        api_url: url.into(),
        vercel_bypass: Some("private-bypass-canary".into()),
        client_session_id: "transport-session".into(),
        runner_version: "1.2.3",
    })
    .unwrap();
    // Native validation can require the real AF_PACKET path; ordinary tests
    // still exercise best-effort behavior on hosts without CAP_NET_RAW.
    if std::env::var("OKOU_RUNNER_REQUIRE_TCP_CAPTURE").as_deref() == Ok("1") {
        assert_eq!(
            client.inner.diagnostics.0.shared.state().capture_status,
            "ready"
        );
    }
    client
}

#[tokio::test]
async fn reused_http_reset_keeps_the_failed_socket_when_another_request_succeeds() {
    reset_case(false).await;
}

#[tokio::test]
async fn reused_https_reset_before_headers_keeps_the_underlying_tcp_tuple() {
    reset_case(true).await;
}

async fn reset_case(tls: bool) {
    let captured = CapturedEvents::default();
    let (signal, mut events) = mpsc::channel(128);
    let subscriber = tracing_subscriber::registry()
        .with(captured.clone())
        .with(Signal(signal));
    async {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let cert = rcgen::generate_simple_self_signed(vec!["localhost".into()]).unwrap();
        let server = rustls::ServerConfig::builder_with_provider(Arc::new(
            rustls::crypto::aws_lc_rs::default_provider(),
        ))
        .with_safe_default_protocol_versions()
        .unwrap()
        .with_no_client_auth()
        .with_single_cert(
            vec![cert.cert.der().clone()],
            rustls::pki_types::PrivatePkcs8KeyDer::from(cert.signing_key.serialize_der()).into(),
        )
        .unwrap();
        let (read_tx, read_rx) = oneshot::channel();
        let (reset_tx, reset_rx) = oneshot::channel();
        let task = tokio::spawn(async move {
            let (tcp, remote) = listener.accept().await.unwrap();
            let mut peer: Box<dyn Peer> = if tls {
                Box::new(
                    tokio_rustls::TlsAcceptor::from(Arc::new(server))
                        .accept(tcp)
                        .await
                        .unwrap(),
                )
            } else {
                Box::new(tcp)
            };
            let first = request(peer.as_mut()).await;
            assert!(
                first
                    .to_lowercase()
                    .contains("authorization: bearer private-auth-canary")
            );
            peer.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\ncf-ray: 0123456789abcdef-SEA\r\nx-private-test: private-response-canary\r\n\r\nok")
                .await
                .unwrap();
            peer.flush().await.unwrap();
            let second = request(peer.as_mut()).await;
            assert!(second.starts_with("POST /reset?secret=private-query-canary HTTP/1.1"));
            read_tx.send(remote).unwrap();
            reset_rx.await.unwrap();
            peer.reset();
        });
        let url = format!(
            "{}://localhost:{}",
            if tls { "https" } else { "http" },
            address.port()
        );
        let mut http = client(&url);
        if tls {
            // Only the external TLS trust boundary is replaced. Production
            // layers, timeout, pool, finalized requests and send path remain.
            let root = reqwest::Certificate::from_der(cert.cert.der()).unwrap();
            Arc::get_mut(&mut http.inner).unwrap().client = Arc::new(
                super::super::ClientPool::new(move || {
                    reqwest::Client::builder()
                        .timeout(super::super::DEFAULT_TIMEOUT)
                        .connector_layer(ConnectionDiagnosticsLayer)
                        .add_root_certificate(root.clone())
                        .build()
                        .map_err(|error| crate::error::ProviderError::Internal(error.to_string()))
                })
                .unwrap(),
            );
        }
        let response = http
            .authenticated_request(
                reqwest::Method::GET,
                format!("{url}/warm"),
                "private-auth-canary",
            )
            .send("warm")
            .await
            .unwrap();
        let warm_tuple = Tuple::from_info(response.extensions().get::<HttpInfo>().unwrap());
        assert_eq!(response.text().await.unwrap(), "ok");
        let capture_ready = http.inner.diagnostics.0.shared.state().capture_status == "ready";
        if capture_ready {
            wait_for_event(&captured, &mut events, |e| {
                e.fields.get("message").map(String::as_str)
                    == Some("API TCP capture filter updated")
            })
            .await;
        }
        let failing = http
            .authenticated_request(
                reqwest::Method::POST,
                format!("{url}/reset?secret=private-query-canary"),
                "private-auth-canary",
            )
            .prepare("reset")
            .unwrap();
        let request_id = failing.context().client_request_id.clone();
        let failing = tokio::spawn(failing.send().with_current_subscriber());
        let peer_addr = tokio::time::timeout(Duration::from_secs(5), read_rx)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(warm_tuple.local, peer_addr);

        let healthy = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(
            b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\ncf-ray: fedcba9876543210-DFW\r\n\r\nok".to_vec(),
        )])
        .await;
        let response = http
            .authenticated_request(reqwest::Method::GET, healthy.url(), "private-auth-canary")
            .send("healthy")
            .await
            .unwrap();
        let healthy_tuple = Tuple::from_info(response.extensions().get::<HttpInfo>().unwrap());
        assert_ne!(warm_tuple, healthy_tuple);
        assert_eq!(response.text().await.unwrap(), "ok");
        healthy.assert_finished().await;
        assert!(
            captured.entries().iter().all(|e| {
                !matches!(
                    e.fields.get("message").map(String::as_str),
                    Some("API transport failure diagnostics" | "API TCP packet metadata")
                )
            }),
            "successful requests must not dump fault evidence"
        );
        reset_tx.send(()).unwrap();
        let error = join_raw_http_task(failing, "failed request diagnostics")
            .await
            .unwrap_err();
        assert!(matches!(error, ProviderError::ApiTransport(ref e)
            if e.failure_cause == crate::error::ApiTransportCause::ConnectionReset));
        join_raw_http_task(task, "keepalive RST peer").await;
        if capture_ready {
            wait_for_event(&captured, &mut events, |e| {
                e.fields.get("client_request_id") == Some(&request_id)
                    && e.fields.get("message").map(String::as_str)
                        == Some("API TCP packet metadata")
                    && e.fields
                        .get("flags")
                        .and_then(|f| f.parse::<u8>().ok())
                        .is_some_and(|f| f & 4 != 0)
                    && e.fields.get("outbound").map(String::as_str) == Some("false")
            })
            .await;
        } else {
            assert!(
                captured
                    .entries()
                    .iter()
                    .any(|e| e.fields.get("message").map(String::as_str)
                        == Some("API TCP capture unavailable"))
            );
        }
        let events = captured.entries();
        let diagnostic = find_captured_event(&events, "API transport failure diagnostics")
            .unwrap();
        assert_eq!(diagnostic.level, tracing::Level::INFO);
        assert_eq!(diagnostic.fields["client_request_id"], request_id);
        assert_eq!(
            diagnostic.fields["local_addr"],
            format!("Some({})", warm_tuple.local)
        );
        assert_eq!(
            diagnostic.fields["remote_addr"],
            format!("Some({})", warm_tuple.remote)
        );
        assert_eq!(diagnostic.fields["socket_metadata_available"], "true");
        assert_eq!(diagnostic.fields["responses_observed"], "1");
        assert_eq!(
            diagnostic.fields["last_response_cf_ray"],
            "0123456789abcdef-SEA"
        );
        assert_eq!(diagnostic.fields["last_response_http_version"], "HTTP/1.1");
        assert_eq!(diagnostic.fields["raw_os_error"], "104");
        #[cfg(target_os = "linux")]
        if capture_ready {
            let packet = events
                .iter()
                .find(|e| {
                    e.fields.get("client_request_id") == Some(&request_id)
                        && e.fields.get("message").map(String::as_str)
                            == Some("API TCP packet metadata")
                        && e.fields.get("outbound").map(String::as_str) == Some("false")
                        && e.fields.get("flags").and_then(|f| f.parse::<u8>().ok())
                            .is_some_and(|f| f & 4 != 0)
                })
                .unwrap();
            // SAFETY: the interface name is a valid, terminated C string.
            let loopback = unsafe { nix::libc::if_nametoindex(c"lo".as_ptr()) };
            assert!(loopback > 0);
            assert_eq!(packet.fields["capture_ifindex"], loopback.to_string());
            let packet_type = packet.fields["capture_packet_type"].parse::<u8>().unwrap();
            assert!(matches!(
                packet_type,
                nix::libc::PACKET_HOST | nix::libc::PACKET_OUTGOING
            ));
            assert!(packet.fields["ip_ttl"].parse::<u8>().unwrap() > 0);
            packet.fields["ipv4_id"].parse::<u16>().unwrap();
        }
        for secret in [
            "private-auth-canary",
            "private-bypass-canary",
            "private-query-canary",
            "private-response-canary",
        ] {
            assert!(!format!("{events:?}").contains(secret));
        }
        assert!(!error.to_string().contains(&warm_tuple.local.to_string()));
    }
    .with_subscriber(subscriber)
    .await;
}

#[tokio::test]
async fn latest_response_without_valid_ray_clears_the_prior_connection_ray() {
    for (ray_header, version) in [
        ("", "HTTP/1.1"),
        ("cf-ray: private-response-canary\r\n", "HTTP/1.0"),
    ] {
        let captured = CapturedEvents::default();
        let subscriber = tracing_subscriber::registry().with(captured.clone());
        async {
            let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
            let url = format!("http://{}", listener.local_addr().unwrap());
            let task = tokio::spawn(async move {
                let (mut peer, _) = listener.accept().await.unwrap();
                request(&mut peer).await;
                peer.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\ncf-ray: 0123456789abcdef-SEA\r\n\r\n")
                    .await
                    .unwrap();
                request(&mut peer).await;
                peer.write_all(
                    format!("{version} 200 OK\r\nContent-Length: 0\r\nConnection: keep-alive\r\n{ray_header}\r\n")
                        .as_bytes(),
                )
                .await
                .unwrap();
                assert!(request(&mut peer).await.starts_with("POST /reset "));
                peer.reset();
            });
            let http = client(&url);
            for path in ["warm", "latest"] {
                let response = http
                    .authenticated_request(
                        reqwest::Method::GET,
                        format!("{url}/{path}"),
                        "private-auth-canary",
                    )
                    .send(path)
                    .await
                    .unwrap();
                assert!(response.bytes().await.unwrap().is_empty());
            }
            let error = http
                .authenticated_request(
                    reqwest::Method::POST,
                    format!("{url}/reset"),
                    "private-auth-canary",
                )
                .send("reset")
                .await
                .unwrap_err();
            assert!(matches!(error, ProviderError::ApiTransport(ref e)
                if e.failure_cause == crate::error::ApiTransportCause::ConnectionReset));
            join_raw_http_task(task, "reset after replacing response snapshot").await;
            let events = captured.entries();
            let fault = find_captured_event(&events, "API transport failure diagnostics")
                .unwrap();
            assert_eq!(fault.fields["responses_observed"], "2");
            assert_eq!(fault.fields["last_response_http_version"], version);
            assert!(
                !fault.fields.contains_key("last_response_cf_ray"),
                "absent or invalid Ray is not an older response's edge"
            );
            assert!(!format!("{events:?}").contains("private-response-canary"));
        }
        .with_subscriber(subscriber)
        .await;
    }
}

#[tokio::test]
async fn fresh_connection_reset_keeps_its_own_registration_and_typed_cause() {
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    async {
        let server = RawHttpTestServer::spawn(vec![RawHttpAction::ResetConnection]).await;
        let http = client(&server.url());
        let request = http
            .authenticated_request(reqwest::Method::POST, server.url(), "private-auth-canary")
            .prepare("fresh reset")
            .unwrap();
        let request_id = request.context().client_request_id.clone();
        let error = request.send().await.unwrap_err();
        assert!(matches!(error, ProviderError::ApiTransport(ref e)
            if e.failure_cause == crate::error::ApiTransportCause::ConnectionReset));
        server.assert_finished().await;
        let entries = captured.entries();
        let summary = find_captured_event(&entries, "API transport failure diagnostics").unwrap();
        assert_eq!(summary.fields["client_request_id"], request_id);
        assert_eq!(summary.fields["socket_metadata_available"], "true");
        assert_eq!(summary.fields["connection_generation_status"], "registered");
        assert_eq!(summary.fields["responses_observed"], "0");
        assert_eq!(summary.fields["raw_os_error"], "104");
    }
    .with_subscriber(subscriber)
    .await;
}

#[tokio::test]
async fn diagnostic_state_contention_never_blocks_a_failed_request() {
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    drop(listener);
    let http = client(&url);
    let request = http
        .authenticated_request(reqwest::Method::GET, url.clone(), "private-auth-canary")
        .prepare("connect")
        .unwrap();
    let error = http
        .inner
        .client
        .current()
        .get(url)
        .send()
        .await
        .unwrap_err();
    let state = http.inner.diagnostics.0.shared.state();
    let diagnostics = http.inner.diagnostics.clone();
    let context = request.context().clone();
    let (finished, completion) = std::sync::mpsc::sync_channel(1);
    let worker = std::thread::spawn(move || {
        tracing::subscriber::with_default(subscriber, || {
            diagnostics.failure(&context, Instant::now(), &error);
        });
        finished.send(()).unwrap();
    });
    let result = completion.recv_timeout(Duration::from_secs(5));
    drop(state);
    worker.join().unwrap();
    result.expect("diagnostics must finish while the registry is locked");
    let events = captured.entries();
    assert_eq!(
        events.last().unwrap().fields["capture_status"],
        "state_busy"
    );
    assert!(events.iter().all(|e| e.level == tracing::Level::INFO));
}

#[tokio::test]
async fn delayed_response_cannot_update_a_replacement_registration() {
    let server = RawHttpTestServer::spawn(vec![RawHttpAction::Respond(
        b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\ncf-ray: 0123456789abcdef-SEA\r\n\r\nok".to_vec(),
    )])
    .await;
    let http = client(&server.url());
    let started = Instant::now();
    let response = http
        .inner
        .client
        .current()
        .get(server.url())
        .send()
        .await
        .unwrap();
    let tuple = Tuple::from_info(response.extensions().get::<HttpInfo>().unwrap());
    // Model the external observation after the old registry entry was evicted:
    // reqwest exposes a tuple, not a kernel socket cookie. Use real response
    // metadata; deterministic OS ephemeral-port reuse is not a fixture API.
    http.inner
        .diagnostics
        .0
        .shared
        .state()
        .register(tuple, Arc::from("replacement-request"));
    assert!(
        http.inner
            .diagnostics
            .0
            .shared
            .state()
            .connections
            .front()
            .unwrap()
            .registered
            > started
    );
    http.inner
        .diagnostics
        .response(&response, "original-request", started);
    {
        let state = http.inner.diagnostics.0.shared.state();
        let replacement = state.connections.front().unwrap();
        assert_eq!(
            replacement.responses, 0,
            "old headers are not replacement-generation evidence"
        );
        assert!(replacement.last_response.is_none());
    }
    assert_eq!(
        http.inner
            .diagnostics
            .0
            .shared
            .dropped_updates
            .load(Ordering::Relaxed),
        1
    );
    assert_eq!(response.text().await.unwrap(), "ok");
    server.assert_finished().await;
}
