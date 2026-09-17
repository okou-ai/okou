use super::*;
use std::net::SocketAddr;
use tokio::net::TcpStream;
use tokio::sync::{mpsc, oneshot};

struct ArchiveRequest {
    connection: usize,
    headers: String,
    reply: oneshot::Sender<(Vec<u8>, bool)>,
}

impl ArchiveRequest {
    fn respond(self, status: &str, body: &[u8], close: bool) {
        let mut response = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: {}\r\n\r\n",
            body.len(),
            if close { "close" } else { "keep-alive" },
        )
        .into_bytes();
        response.extend_from_slice(body);
        self.reply.send((response, close)).unwrap();
    }
}

struct ArchiveServer {
    address: SocketAddr,
    requests: mpsc::Receiver<ArchiveRequest>,
    closed: mpsc::Receiver<usize>,
    cancel: CancellationToken,
    task: Option<JoinHandle<()>>,
}

impl ArchiveServer {
    async fn start() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let (request_tx, requests) = mpsc::channel(32);
        let (closed_tx, closed) = mpsc::channel(32);
        let cancel = CancellationToken::new();
        let stop = cancel.clone();
        let task = tokio::spawn(async move {
            let mut connections = JoinSet::new();
            let mut next_id = 0;
            loop {
                tokio::select! {
                    biased;
                    () = stop.cancelled() => break,
                    accepted = listener.accept() => {
                        let (socket, _) = accepted.unwrap();
                        next_id += 1;
                        let id = next_id;
                        let requests = request_tx.clone();
                        let closed = closed_tx.clone();
                        let stop = stop.clone();
                        connections.spawn(async move {
                            tokio::select! {
                                biased;
                                () = stop.cancelled() => {},
                                () = serve_connection(socket, id, requests) => {
                                    closed.send(id).await.unwrap();
                                }
                            }
                        });
                    }
                    result = connections.join_next(), if !connections.is_empty() => {
                        result.unwrap().unwrap();
                    }
                }
            }
            while let Some(result) = connections.join_next().await {
                result.unwrap();
            }
        });
        Self {
            address,
            requests,
            closed,
            cancel,
            task: Some(task),
        }
    }

    fn url(&self, path: &str) -> String {
        format!("http://{}{path}", self.address)
    }

    async fn request(&mut self) -> ArchiveRequest {
        tokio::time::timeout(Duration::from_secs(5), self.requests.recv())
            .await
            .unwrap()
            .expect("one admitted archive request")
    }

    async fn closed_connection(&mut self) -> usize {
        tokio::time::timeout(Duration::from_secs(5), self.closed.recv())
            .await
            .unwrap()
            .expect("the client closes its unused connection")
    }

    async fn stop(mut self) {
        self.cancel.cancel();
        join_raw_http_task(self.task.take().unwrap(), "pooled archive server shutdown").await;
        assert!(
            self.requests.try_recv().is_err(),
            "no duplicate HTTP request"
        );
    }
}

impl Drop for ArchiveServer {
    fn drop(&mut self) {
        self.cancel.cancel();
        if let Some(task) = &self.task {
            task.abort();
        }
    }
}

async fn serve_connection(
    mut socket: TcpStream,
    id: usize,
    requests: mpsc::Sender<ArchiveRequest>,
) {
    loop {
        let headers = match read_http_request(&mut socket).await {
            Ok(headers) => headers,
            Err(error) if error.kind() == io::ErrorKind::UnexpectedEof => return,
            Err(error) => panic!("read pooled archive request: {error}"),
        };
        let (reply, response) = oneshot::channel();
        requests
            .send(ArchiveRequest {
                connection: id,
                headers,
                reply,
            })
            .await
            .unwrap();
        let (bytes, close) = response.await.unwrap();
        socket.write_all(&bytes).await.unwrap();
        if close {
            return;
        }
    }
}

struct PendingArchive {
    name: String,
    body: Vec<u8>,
    plan: StoragePlan,
    delivery: FreshArchiveDelivery,
    telemetry: JobTelemetry,
}

impl PendingArchive {
    async fn start(
        url: String,
        home: &HomePaths,
        admission: &FreshArchiveDeliveryAdmission,
        name: &str,
        cancel: &CancellationToken,
    ) -> Self {
        let body = tarball_with_contents(format!("archive contents for {name}\n").as_bytes());
        let mut plan = fresh_storage_plan_with_archive_size(url, name, "v1", body.len() as u64);
        let mut telemetry = new_telemetry();
        let delivery = prepare_fresh_archive_delivery(
            &mut plan,
            home,
            admission,
            cancel,
            &mut telemetry,
            None,
        )
        .await
        .unwrap();
        Self {
            name: name.into(),
            body,
            plan,
            delivery,
            telemetry,
        }
    }

    async fn complete(mut self, home: &HomePaths) {
        let sandbox = MockSandbox::new("pooled-archive");
        assert!(
            populate_cache_with_fresh_delivery(
                &mut self.plan,
                &sandbox,
                home,
                &mut self.telemetry,
                Some(&mut self.delivery),
                None,
            )
            .await
            .unwrap()
            .is_none()
        );
        assert_eq!(
            storage_archive_url(&self.plan, 0),
            Some(format!("file://{}", guest_archive_path(&self.name, "v1")).as_str())
        );
        assert!(
            sandbox
                .write_files_calls()
                .iter()
                .flat_map(|call| &call.files)
                .any(|file| file.path == guest_archive_path(&self.name, "v1")
                    && file.content == self.body)
        );
        self.delivery.cancel_and_drain(&mut self.telemetry).await;
    }
}

async fn download(
    server: &mut ArchiveServer,
    home: &HomePaths,
    admission: &FreshArchiveDeliveryAdmission,
    name: &str,
    close: bool,
) -> usize {
    let path = format!("/{name}.tar.gz?signature={name}");
    let pending = PendingArchive::start(
        server.url(&path),
        home,
        admission,
        name,
        &CancellationToken::new(),
    )
    .await;
    let request = server.request().await;
    assert!(
        request
            .headers
            .starts_with(&format!("GET {path} HTTP/1.1\r\n"))
    );
    let connection = request.connection;
    request.respond("200 OK", &pending.body, close);
    pending.complete(home).await;
    assert_eq!(
        admission.permits.available_permits(),
        FRESH_DELIVERY_RUNNER_LIMIT
    );
    connection
}

#[tokio::test]
async fn fresh_delivery_reuses_connections_across_runs_and_reconnects_after_server_close() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let admission = FreshArchiveDeliveryAdmission::new();
    let mut server = ArchiveServer::start().await;
    let first = download(&mut server, &home, &admission, "first", false).await;
    let second = download(&mut server, &home, &admission.clone(), "second", true).await;
    assert_eq!(
        first, second,
        "a second run on the same origin reuses the idle connection"
    );
    assert_eq!(server.closed_connection().await, first);
    let third = download(&mut server, &home, &admission, "third", false).await;
    assert_ne!(third, first, "server-closed connections are replaced");
    drop(admission);
    assert_eq!(server.closed_connection().await, third);
    server.stop().await;
}

#[tokio::test]
async fn fresh_delivery_replaces_the_idle_origin_without_accumulating_connections() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let admission = FreshArchiveDeliveryAdmission::new();
    let mut first = ArchiveServer::start().await;
    let mut second = ArchiveServer::start().await;
    let first_connection = download(&mut first, &home, &admission, "one", false).await;
    download(&mut second, &home, &admission, "two", false).await;
    assert_eq!(first.closed_connection().await, first_connection);
    let returned = download(&mut first, &home, &admission, "three", false).await;
    assert_ne!(returned, first_connection);
    assert_eq!(second.closed_connection().await, 1);
    drop(admission);
    assert_eq!(first.closed_connection().await, returned);
    first.stop().await;
    second.stop().await;
}

#[tokio::test]
async fn fresh_delivery_keeps_an_evicted_clients_active_request_owned_until_completion() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let admission = FreshArchiveDeliveryAdmission::new();
    let cancel = CancellationToken::new();
    let mut first = ArchiveServer::start().await;
    let mut second = ArchiveServer::start().await;
    let first_archive = PendingArchive::start(
        first.url("/first"),
        &home,
        &admission,
        "active-first",
        &cancel,
    )
    .await;
    let first_request = first.request().await;
    let second_archive = PendingArchive::start(
        second.url("/second"),
        &home,
        &admission,
        "active-second",
        &cancel,
    )
    .await;
    let second_request = second.request().await;

    // A different origin is now cached, but the first request still owns its
    // socket, writer and permit until its complete bytes have been staged.
    first_request.respond("200 OK", &first_archive.body, false);
    first_archive.complete(&home).await;
    assert_eq!(first.closed_connection().await, 1);
    assert_eq!(
        admission.permits.available_permits(),
        FRESH_DELIVERY_RUNNER_LIMIT - 1
    );
    second_request.respond("200 OK", &second_archive.body, false);
    second_archive.complete(&home).await;
    let reused = download(&mut second, &home, &admission, "second-again", false).await;
    assert_eq!(reused, 1);
    drop(admission);
    assert_eq!(second.closed_connection().await, 1);
    first.stop().await;
    second.stop().await;
}

#[tokio::test]
async fn fresh_delivery_cancellation_does_not_cancel_another_origins_request() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let admission = FreshArchiveDeliveryAdmission::new();
    let cancelled = CancellationToken::new();
    let mut first = RawHttpTestServer::spawn(vec![RawHttpAction::WaitForDisconnect]).await;
    let mut first_archive = PendingArchive::start(
        first.url(),
        &home,
        &admission,
        "cancelled-origin",
        &cancelled,
    )
    .await;
    assert!(
        first
            .next_request("cancelled-origin GET")
            .await
            .starts_with("GET / HTTP/1.1\r\n")
    );
    let mut second = ArchiveServer::start().await;
    let second_archive = PendingArchive::start(
        second.url("/survivor"),
        &home,
        &admission,
        "surviving-origin",
        &CancellationToken::new(),
    )
    .await;
    let second_request = second.request().await;

    cancelled.cancel();
    first_archive
        .delivery
        .cancel_and_drain(&mut first_archive.telemetry)
        .await;
    first.assert_finished().await;
    assert!(!home.storage_cache_dir("cancelled-origin", "v1").exists());
    assert_eq!(
        admission.permits.available_permits(),
        FRESH_DELIVERY_RUNNER_LIMIT - 1
    );
    second_request.respond("200 OK", &second_archive.body, false);
    second_archive.complete(&home).await;
    assert_eq!(
        download(&mut second, &home, &admission, "survivor-again", false).await,
        1
    );
    drop(first_archive);
    drop(admission);
    assert_eq!(second.closed_connection().await, 1);
    second.stop().await;
}

#[tokio::test]
async fn fresh_delivery_failed_requests_stay_terminal_without_poisoning_later_runs() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let admission = FreshArchiveDeliveryAdmission::new();
    let mut server = ArchiveServer::start().await;
    for reason in ["status", "size"] {
        let mut pending = PendingArchive::start(
            server.url(&format!("/{reason}")),
            &home,
            &admission,
            reason,
            &CancellationToken::new(),
        )
        .await;
        let request = server.request().await;
        assert!(
            request
                .headers
                .starts_with(&format!("GET /{reason} HTTP/1.1\r\n"))
        );
        if reason == "status" {
            request.respond("503 Service Unavailable", &[], false);
        } else {
            request.respond("200 OK", &pending.body[..pending.body.len() - 1], false);
        }
        let sandbox = MockSandbox::new("failed-pooled-archive");
        assert!(
            populate_cache_with_fresh_delivery(
                &mut pending.plan,
                &sandbox,
                &home,
                &mut pending.telemetry,
                Some(&mut pending.delivery),
                None,
            )
            .await
            .is_err()
        );
        pending
            .delivery
            .cancel_and_drain(&mut pending.telemetry)
            .await;
        assert!(sandbox.write_files_calls().is_empty());
        assert!(!home.storage_cache_dir(reason, "v1").exists());
        assert_eq!(
            admission.permits.available_permits(),
            FRESH_DELIVERY_RUNNER_LIMIT
        );
        download(
            &mut server,
            &home,
            &admission,
            &format!("after-{reason}"),
            false,
        )
        .await;
    }
    drop(admission);
    server.stop().await;
}

#[tokio::test]
async fn fresh_delivery_cancellation_closes_its_request_while_the_shared_client_remains_live() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let admission = FreshArchiveDeliveryAdmission::new();
    let cancelled = CancellationToken::new();
    let survivor_body = tarball_with_contents(b"archive contents for same-origin-survivor\n");
    let mut server = RawHttpTestServer::spawn(vec![
        RawHttpAction::WaitForDisconnect,
        RawHttpAction::Respond(http_response("200 OK", &survivor_body)),
    ])
    .await;
    let mut first = PendingArchive::start(
        format!("{}/cancelled", server.url()),
        &home,
        &admission,
        "same-origin-cancelled",
        &cancelled,
    )
    .await;
    assert!(
        server
            .next_request("first same-origin GET")
            .await
            .starts_with("GET /cancelled HTTP/1.1\r\n")
    );
    let survivor = PendingArchive::start(
        format!("{}/survivor", server.url()),
        &home,
        &admission,
        "same-origin-survivor",
        &CancellationToken::new(),
    )
    .await;
    // The fixture accepts the second connection only after observing the first
    // request close. The shared client and second admitted request stay alive.
    cancelled.cancel();
    first.delivery.cancel_and_drain(&mut first.telemetry).await;
    assert!(
        server
            .next_request("surviving same-origin GET")
            .await
            .starts_with("GET /survivor HTTP/1.1\r\n")
    );
    survivor.complete(&home).await;
    assert!(
        !home
            .storage_cache_dir("same-origin-cancelled", "v1")
            .exists()
    );
    assert_eq!(
        admission.permits.available_permits(),
        FRESH_DELIVERY_RUNNER_LIMIT
    );
    assert!(
        server.assert_finished_with_requests().await.is_empty(),
        "no duplicate GET after the two observed requests"
    );
}

#[tokio::test]
async fn fresh_delivery_reaps_the_full_shared_connection_allowance_on_owner_drop() {
    let temp = tempfile::tempdir().unwrap();
    let home = home_at(&temp);
    let admission = FreshArchiveDeliveryAdmission::new();
    let mut server = ArchiveServer::start().await;
    let mut archives = Vec::new();
    let mut requests = Vec::new();
    let mut connections = HashSet::new();
    for index in 0..FRESH_DELIVERY_RUNNER_LIMIT {
        let name = format!("concurrent-{index}");
        archives.push(
            PendingArchive::start(
                server.url(&format!("/{name}")),
                &home,
                &admission,
                &name,
                &CancellationToken::new(),
            )
            .await,
        );
        let request = server.request().await;
        assert!(connections.insert(request.connection));
        requests.push(request);
    }
    assert_eq!(admission.permits.available_permits(), 0);
    for (request, archive) in requests.into_iter().zip(&archives) {
        request.respond("200 OK", &archive.body, false);
    }
    for archive in archives {
        archive.complete(&home).await;
    }
    assert!(
        connections.contains(&download(&mut server, &home, &admission, "after-wave", false).await)
    );
    drop(admission);
    for _ in 0..FRESH_DELIVERY_RUNNER_LIMIT {
        assert!(connections.remove(&server.closed_connection().await));
    }
    assert!(connections.is_empty());
    server.stop().await;
}
