use super::*;
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use guest_channel_server::{
    Categories, Filesystem, Notice, Operation, Params, Peer, Service, ServiceFuture,
};
use runner_lifecycle::active_runs::ActiveRunGuard;
use runner_remote::guest_duplex::Registration;
use sandbox::{AcceptedGuestDuplex, GuestDuplexAcceptor, Sandbox, SandboxId};
use sandbox_mock::MockSandbox;
use std::{
    collections::HashSet,
    path::PathBuf,
    sync::atomic::{AtomicBool, AtomicUsize, Ordering},
};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

struct Grants {
    path: Vec<String>,
    seen: Mutex<HashSet<String>>,
}

struct WaitingAuthority(tokio::sync::Notify);
#[async_trait]
impl GrantConsumer for WaitingAuthority {
    async fn consume(
        &self,
        _: RunId,
        _: Uuid,
        _: &str,
        _: &str,
    ) -> io::Result<Option<ConsumeResponse>> {
        self.0.notify_one();
        std::future::pending().await
    }
}
#[async_trait]
impl GrantConsumer for Grants {
    async fn consume(
        &self,
        run: RunId,
        runner: Uuid,
        origin: &str,
        ticket: &str,
    ) -> io::Result<Option<ConsumeResponse>> {
        if !self.seen.lock().unwrap().insert(ticket.into()) {
            return Ok(None);
        }
        Ok(Some(serde_json::from_value(serde_json::json!({
            "runId":run,"runnerId":runner,"origin":origin,
            "orgId":"org","userId":"user","path":self.path,"digest":hex::encode(Sha256::digest(ticket.as_bytes())),
        })).unwrap()))
    }
}

struct ObservedService {
    inner: Arc<dyn Service>,
    bytes: Arc<AtomicUsize>,
    read_progress: Arc<tokio::sync::Notify>,
    mutate_finish: Arc<AtomicBool>,
    stale_version: Arc<AtomicBool>,
    path: PathBuf,
}
impl Service for ObservedService {
    fn categories(&self) -> Categories {
        let mut categories = self.inner.categories();
        if self.stale_version.load(Ordering::SeqCst) {
            categories.insert("fs".into(), 2);
        }
        categories
    }
    fn notice(&self, notice: Notice, peer: Peer) -> ServiceFuture<()> {
        self.inner.notice(notice, peer)
    }
    fn request(
        &self,
        operation: Operation,
        params: Params,
        peer: Peer,
    ) -> ServiceFuture<serde_json::Value> {
        let inner = self.inner.clone();
        let bytes = self.bytes.clone();
        let read_progress = self.read_progress.clone();
        let mutate =
            operation == Operation::FsFinish && self.mutate_finish.swap(false, Ordering::SeqCst);
        let path = self.path.clone();
        Box::pin(async move {
            if mutate {
                std::fs::write(path, b"changed before final validation").unwrap();
            }
            let result = inner.request(operation, params, peer).await?;
            if operation == Operation::FsRead {
                bytes.fetch_add(
                    result["length"].as_u64().unwrap() as usize,
                    Ordering::SeqCst,
                );
                read_progress.notify_one();
            }
            Ok(result)
        })
    }
}
struct Boundary {
    sandbox: SandboxId,
    fs: Filesystem,
    tasks: Mutex<JoinSet<()>>,
    bytes: Arc<AtomicUsize>,
    read_progress: Arc<tokio::sync::Notify>,
    mutate_finish: Arc<AtomicBool>,
    stale_version: Arc<AtomicBool>,
    path: PathBuf,
    cancelled: CancellationToken,
}
#[async_trait]
impl GuestDuplexAcceptor for Boundary {
    async fn accept(&self) -> io::Result<AcceptedGuestDuplex> {
        let (mut host, guest) = tokio::io::duplex(64 * 1024);
        let service = Arc::new(ObservedService {
            inner: self.fs.service(),
            bytes: self.bytes.clone(),
            read_progress: self.read_progress.clone(),
            mutate_finish: self.mutate_finish.clone(),
            stale_version: self.stale_version.clone(),
            path: self.path.clone(),
        });
        self.tasks.lock().unwrap().spawn(async move {
            let _ = guest_channel_server::serve(guest, service).await;
        });
        assert_eq!(
            host.read_u8().await?,
            guest_contracts::private_duplex::ACTIVATED
        );
        Ok(AcceptedGuestDuplex {
            sandbox_id: self.sandbox.to_string(),
            stream: Box::new(host),
            cancelled: self.cancelled.clone(),
        })
    }
}
struct Fixture {
    _dir: tempfile::TempDir,
    path: PathBuf,
    run: RunId,
    guard: Option<ActiveRunGuard>,
    _registration: Registration,
    boundary: Arc<Boundary>,
    admission: Admission,
}
impl Fixture {
    async fn new(size: u64) -> Self {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("binary-文件.bin");
        let file = std::fs::File::create(&path).unwrap();
        file.set_len(size).unwrap(); // Sparse file, with no file-sized fixture allocation.
        let run = RunId::new_v4();
        let sandbox = SandboxId::new_v4();
        let active = ActiveRuns::new(Arc::new(tokio::sync::Notify::new()));
        let guard = active.register(run, None, "download-test".into());
        let status = Arc::new(StatusTracker::new(dir.path().join("status"), 1, None, None));
        status.add_run(run, sandbox).await.unwrap();
        let guest = RunGuestChannels::default();
        let boundary = Arc::new(Boundary {
            sandbox,
            fs: Filesystem::new().unwrap(),
            tasks: Mutex::new(JoinSet::new()),
            bytes: Arc::new(AtomicUsize::new(0)),
            read_progress: Arc::new(tokio::sync::Notify::new()),
            mutate_finish: Arc::new(AtomicBool::new(false)),
            stale_version: Arc::new(AtomicBool::new(false)),
            path: path.clone(),
            cancelled: CancellationToken::new(),
        });
        let mut provider =
            MockSandbox::new(sandbox.to_string()).with_guest_duplex(boundary.clone());
        provider.bind_run_control(&run.to_string()).unwrap();
        let registration = guest
            .register(run, &provider, &CancellationToken::new())
            .unwrap();
        let tokens = path
            .components()
            .filter_map(|part| match part {
                std::path::Component::Normal(name) => {
                    Some(URL_SAFE_NO_PAD.encode(name.as_encoded_bytes()))
                }
                _ => None,
            })
            .collect();
        let admission = Admission::new(
            Uuid::new_v4(),
            Some("https://runner.okou.ai:443".into()),
            Arc::new(Grants {
                path: tokens,
                seen: Mutex::new(HashSet::new()),
            }),
            guest,
            active,
            status,
        );
        Self {
            _dir: dir,
            path,
            run,
            guard: Some(guard),
            _registration: registration,
            boundary,
            admission,
        }
    }
    async fn connect(
        &mut self,
        ticket: &str,
        extra: &str,
        method: &str,
    ) -> (u16, String, BufReader<UnixStream>) {
        let (server, mut client) = UnixStream::pair().unwrap();
        self.admission.accept(server);
        client.write_all(format!("{method} /downloads/{}/{}/{ticket} HTTP/1.1\r\nHost: irrelevant\r\n{extra}Connection: close\r\n\r\n", self.admission.context.runner, self.run).as_bytes()).await.unwrap();
        let mut reader = BufReader::new(client);
        let mut headers = String::new();
        loop {
            let mut line = String::new();
            let count = tokio::time::timeout(Duration::from_secs(5), reader.read_line(&mut line))
                .await
                .unwrap()
                .unwrap();
            assert!(count > 0, "headers must be complete");
            headers.push_str(&line);
            if line == "\r\n" {
                break;
            }
        }
        let status = headers.split_whitespace().nth(1).unwrap().parse().unwrap();
        (status, headers.to_ascii_lowercase(), reader)
    }
    async fn retire(&mut self) {
        self.admission.stop().await;
        let mut tasks = { std::mem::take(&mut *self.boundary.tasks.lock().unwrap()) };
        while let Some(result) = tokio::time::timeout(Duration::from_secs(5), tasks.join_next())
            .await
            .unwrap()
        {
            result.unwrap();
        }
        assert_eq!(
            self.admission.context.downloads.available_permits(),
            MAX_DOWNLOADS
        );
        assert_eq!(
            self.admission.connections.available_permits(),
            MAX_CONNECTIONS
        );
    }
}

#[tokio::test]
async fn sparse_128_mib_stream_is_exact_incremental_and_not_a_preview_limit() {
    const SIZE: u64 = 128 * 1024 * 1024;
    let mut f = Fixture::new(SIZE).await;
    let (status, headers, mut reader) = f.connect(&"A".repeat(43), "", "GET").await;
    assert_eq!(status, 200);
    for expected in [
        "content-length: 134217728",
        "application/octet-stream",
        "attachment;",
        "filename*=utf-8''",
        "no-store, no-transform",
        "nosniff",
        "accept-ranges: none",
    ] {
        assert!(headers.contains(expected), "{expected}");
    }
    let mut count = 0u64;
    let mut hash = Sha256::new();
    let mut expected = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let n = reader.read(&mut buffer).await.unwrap();
        if n == 0 {
            break;
        }
        count += n as u64;
        hash.update(&buffer[..n]);
    }
    for _ in 0..SIZE / buffer.len() as u64 {
        expected.update([0; 64 * 1024]);
    }
    assert_eq!(count, SIZE);
    assert_eq!(hash.finalize(), expected.finalize());
    assert_eq!(f.connect(&"A".repeat(43), "", "GET").await.0, 503);
    f.retire().await;
}

#[tokio::test]
async fn binary_bytes_and_unicode_attachment_names_survive_the_native_http_boundary() {
    let mut f = Fixture::new(70_003).await;
    let expected: Vec<u8> = (0..70_003).map(|i| (i % 256) as u8).collect();
    std::fs::write(&f.path, &expected).unwrap();
    let (status, headers, mut reader) = f.connect(&"M".repeat(43), "", "GET").await;
    assert_eq!(status, 200);
    assert!(headers.contains("filename=\"binary-__.bin\""));
    assert!(headers.contains("filename*=utf-8''binary-%e6%96%87%e4%bb%b6.bin"));
    let mut received = Vec::new();
    reader.read_to_end(&mut received).await.unwrap();
    assert_eq!(received, expected);
    f.retire().await;
}

#[tokio::test]
async fn empty_finishes_before_success_and_final_mutation_never_completes_a_body() {
    for size in [0, 70_003] {
        let mut f = Fixture::new(size).await;
        f.boundary.mutate_finish.store(true, Ordering::SeqCst);
        let (status, _, mut reader) = f.connect(&"B".repeat(43), "", "GET").await;
        let mut bytes = Vec::new();
        reader.read_to_end(&mut bytes).await.unwrap();
        if size == 0 {
            assert_eq!(status, 503);
        } else {
            assert_eq!(status, 200);
            assert!(bytes.len() < size as usize);
        }
        f.retire().await;
    }
    let mut f = Fixture::new(0).await;
    assert_eq!(f.connect(&"C".repeat(43), "", "GET").await.0, 200);
    f.retire().await;
}

#[tokio::test]
async fn stalled_client_bounds_guest_progress_run_admission_and_disconnect_releases_everything() {
    let mut f = Fixture::new(128 * 1024 * 1024).await;
    let (_, _, first) = f.connect(&"D".repeat(43), "", "GET").await;
    let (_, _, second) = f.connect(&"E".repeat(43), "", "GET").await;
    assert_eq!(f.connect(&"F".repeat(43), "", "GET").await.0, 503);
    // Observe a forbidden amount of Guest progress while clients do not read.
    // The deadline bounds this negative assertion; no sleep guesses when the
    // producer has settled or requires two scheduling-dependent samples to match.
    let excessive = async {
        loop {
            let progress = f.boundary.read_progress.notified();
            if f.boundary.bytes.load(Ordering::SeqCst) >= 2 * 1024 * 1024 {
                break;
            }
            progress.await;
        }
    };
    assert!(
        tokio::time::timeout(Duration::from_millis(400), excessive)
            .await
            .is_err(),
        "two unread clients must backpressure Guest reads"
    );
    let before = f.boundary.bytes.load(Ordering::SeqCst);
    assert!(
        before < 2 * 1024 * 1024,
        "Guest stopped after {before} bytes for two unread clients"
    );
    eprintln!(
        "blocked HTTP clients: Guest bytes read={before}; file bytes={}",
        128 * 1024 * 1024
    );
    drop((first, second));
    f.retire().await;
    assert!(f.boundary.bytes.load(Ordering::SeqCst) < 2 * 1024 * 1024);
}

#[tokio::test]
async fn run_end_and_observed_replacement_interrupt_actual_http_bodies() {
    for interruption in ["run-end", "replacement", "assignment-cancel"] {
        let mut f = Fixture::new(128 * 1024 * 1024).await;
        let (status, _, mut reader) = f.connect(&"G".repeat(43), "", "GET").await;
        assert_eq!(status, 200);
        let mut first = [0; 32768];
        reader.read_exact(&mut first).await.unwrap();
        if interruption == "replacement" {
            let new = f.path.with_extension("new");
            std::fs::write(&new, b"replacement").unwrap();
            std::fs::rename(new, &f.path).unwrap();
        } else if interruption == "run-end" {
            drop(f.guard.take());
        } else {
            f.boundary.cancelled.cancel();
        }
        let count = tokio::time::timeout(
            Duration::from_secs(5),
            tokio::io::copy(&mut reader, &mut tokio::io::sink()),
        )
        .await
        .unwrap()
        .unwrap();
        assert!(count + 32768 < 128 * 1024 * 1024);
        f.retire().await;
    }
}

#[tokio::test]
async fn a_blocked_physical_socket_write_obeys_its_idle_deadline() {
    let (server, _client) = UnixStream::pair().unwrap();
    let bytes = [0; 32768];
    server.writable().await.unwrap();
    loop {
        match server.try_write(&bytes) {
            Ok(_) => (),
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
            Err(error) => panic!("filling the owned socket failed: {error}"),
        }
    }
    let mut writer = transfer::WriteDeadline::new(server);
    let mut writing = Box::pin(async {
        loop {
            writer.write_all(&bytes).await?;
        }
    });
    // Fill the real socket before pausing only the armed timer phase.
    assert!(futures_util::poll!(writing.as_mut()).is_pending());
    tokio::time::pause();
    tokio::time::advance(Duration::from_secs(31)).await;
    tokio::time::resume();
    let result: io::Result<()> = writing.await;
    assert_eq!(result.unwrap_err().kind(), io::ErrorKind::TimedOut);
}

#[tokio::test]
async fn method_and_range_rejections_do_not_spend_the_grant() {
    let mut f = Fixture::new(3).await;
    let ticket = "H".repeat(43);
    let (status, headers, _) = f.connect(&ticket, "", "HEAD").await;
    assert_eq!(status, 405);
    assert!(headers.contains("allow: get"));
    assert_eq!(
        f.connect(&ticket, "Range: bytes=0-1\r\n", "GET").await.0,
        404
    );
    let (status, _, mut reader) = f.connect(&ticket, "", "GET").await;
    assert_eq!(status, 200);
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes).await.unwrap();
    assert_eq!(bytes, [0; 3]);
    f.retire().await;
}

#[tokio::test]
async fn browser_and_ingress_header_counts_fit_the_bounded_http_parser() {
    let mut f = Fixture::new(3).await;
    let headers = (0..20)
        .map(|i| format!("X-Browser-Ingress-{i}: fixture\r\n"))
        .collect::<String>();
    let (status, _, mut reader) = f.connect(&"N".repeat(43), &headers, "GET").await;
    assert_eq!(status, 200);
    let mut bytes = Vec::new();
    reader.read_to_end(&mut bytes).await.unwrap();
    assert_eq!(bytes, [0; 3]);
    f.retire().await;
}

#[tokio::test]
async fn native_http_requires_exact_fs_version_and_preserves_large_decimal_lengths() {
    let size = 5 * 1024 * 1024 * 1024 + 17;
    let mut f = Fixture::new(size).await;
    f.boundary.stale_version.store(true, Ordering::SeqCst);
    assert_eq!(f.connect(&"J".repeat(43), "", "GET").await.0, 503);
    f.boundary.stale_version.store(false, Ordering::SeqCst);
    let (status, headers, mut reader) = f.connect(&"K".repeat(43), "", "GET").await;
    assert_eq!(status, 200);
    assert!(headers.contains(&format!("content-length: {size}")));
    let mut first = [0; 32768];
    reader.read_exact(&mut first).await.unwrap();
    assert_eq!(first, [0; 32768]);
    drop(reader);
    f.retire().await;
}

#[tokio::test]
async fn run_end_cancels_pending_authority_before_success_headers_or_guest_attachment() {
    let mut f = Fixture::new(3).await;
    let authority = Arc::new(WaitingAuthority(tokio::sync::Notify::new()));
    f.admission.context.consumer = authority.clone();
    let (server, mut client) = UnixStream::pair().unwrap();
    f.admission.accept(server);
    client
        .write_all(
            format!(
                "GET /downloads/{}/{}/{} HTTP/1.1\r\nHost: ignored\r\nConnection: close\r\n\r\n",
                f.admission.context.runner,
                f.run,
                "L".repeat(43)
            )
            .as_bytes(),
        )
        .await
        .unwrap();
    tokio::time::timeout(Duration::from_secs(5), authority.0.notified())
        .await
        .unwrap();
    drop(f.guard.take());
    let mut response = Vec::new();
    tokio::time::timeout(Duration::from_secs(2), client.read_to_end(&mut response))
        .await
        .unwrap()
        .unwrap();
    assert!(response.starts_with(b"HTTP/1.1 503"));
    assert_eq!(f.boundary.bytes.load(Ordering::SeqCst), 0);
    f.retire().await;
}

#[tokio::test]
async fn guest_cancellation_retires_a_transfer_while_its_status_check_is_blocked() {
    let mut f = Fixture::new(3).await;
    let context = f.admission.context.clone();
    let sandbox = context.status.running_sandbox(f.run).await.unwrap();
    let channel = context
        .guest
        .open_for_sandbox(f.run, &sandbox.to_string())
        .await
        .unwrap();
    let guest = channel.cancellation();
    let mut live = context.active_runs.watch_live_run(f.run).unwrap();
    let stop = CancellationToken::new();
    let held = context.status.hold_state_for_test().await;
    let mut transfer = Box::pin(transfer::while_live(
        std::future::pending::<io::Result<()>>(),
        transfer::Fence {
            context: &context,
            run: f.run,
            sandbox,
            live: &mut live,
            stop: &stop,
            guest: Some(&guest),
        },
    ));
    // The interval's first tick is immediate. Poll through that tick until its
    // real status-lock wait is pending, before cancelling the Guest boundary.
    assert!(futures_util::poll!(transfer.as_mut()).is_pending());
    f.boundary.cancelled.cancel();
    assert!(
        tokio::time::timeout(Duration::from_secs(2), transfer)
            .await
            .unwrap()
            .is_err()
    );
    drop(held);
    drop(channel);
    f.retire().await;
}

#[tokio::test]
async fn official_api_consumer_requires_complete_exact_file_authority() {
    use httpmock::prelude::*;
    let server = MockServer::start_async().await;
    let http = HttpClient::new(runner_provider::http::HttpClientConfig {
        api_url: server.base_url(),
        vercel_bypass: None,
        client_session_id: "download-test".into(),
        runner_version: env!("CARGO_PKG_VERSION"),
    })
    .unwrap();
    let consumer = ApiGrantConsumer::new(http, "official-download-token".into());
    let run = RunId::new_v4();
    let runner = Uuid::new_v4();
    let ticket = "I".repeat(43);
    let origin = "https://runner.okou.ai:443";
    let proof = serde_json::json!({ "runId":run,"runnerId":runner,"origin":origin,
        "orgId":"org","userId":"user","digest":hex::encode(Sha256::digest(ticket.as_bytes())),"path":["ZmlsZQ"] });
    let mut responses = vec![(200, proof.clone(), true)];
    for (key, value) in [
        ("runId", serde_json::json!(RunId::new_v4())),
        ("runnerId", serde_json::json!(Uuid::new_v4())),
        ("origin", serde_json::json!("https://other.okou.ai:443")),
        ("digest", serde_json::json!("0".repeat(64))),
        ("userId", serde_json::json!("")),
        ("extra", serde_json::json!(true)),
    ] {
        let mut invalid = proof.clone();
        invalid[key] = value;
        responses.push((200, invalid, false));
    }
    responses.push((503, proof.clone(), false));
    responses.push((
        200,
        serde_json::json!({"oversized":"X".repeat(20 * 1024)}),
        false,
    ));
    for (status, body, accepted) in responses {
        let peer = server.mock_async(|when, then| {
            when.method(POST).path("/api/runners/files/downloads/consume")
                .header("authorization", "Bearer official-download-token")
                .json_body(serde_json::json!({"runId":run,"runnerId":runner,"origin":origin,"ticket":ticket}));
            then.status(status).json_body(body);
        }).await;
        let result = consumer.consume(run, runner, origin, &ticket).await;
        if accepted {
            assert_eq!(result.unwrap().unwrap().path, ["ZmlsZQ"]);
        } else {
            assert!(result.is_err());
        }
        peer.delete_async().await;
    }
    let peer = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/api/runners/files/downloads/consume");
            then.status(404);
        })
        .await;
    assert!(
        consumer
            .consume(run, runner, origin, &ticket)
            .await
            .unwrap()
            .is_none()
    );
    peer.assert_async().await;
}
