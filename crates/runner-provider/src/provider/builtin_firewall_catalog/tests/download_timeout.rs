use std::io;
use std::task::Poll;

use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

use super::*;
use crate::test_fixtures::raw_http::{join_raw_http_task, read_http_request};

const PEER_TIMEOUT: Duration = Duration::from_secs(5);

struct CatalogBodyPeer {
    url: String,
    prefix_sent: oneshot::Receiver<()>,
    release_tail: Option<oneshot::Sender<bool>>,
    task: Option<JoinHandle<io::Result<()>>>,
}

impl CatalogBodyPeer {
    async fn start(body: Vec<u8>, initial: Option<Vec<u8>>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let (prefix_sent, prefix_received) = oneshot::channel();
        let (release_tail, tail_released) = oneshot::channel();
        let task = tokio::spawn(async move {
            if let Some(initial) = initial {
                let (mut socket, _) = listener.accept().await?;
                read_http_request(&mut socket).await?;
                socket.write_all(&initial).await?;
            }

            let (mut socket, _) = listener.accept().await?;
            let request = read_http_request(&mut socket).await?;
            assert!(request.starts_with("POST /api/runners/builtin-firewalls/resolve "));
            let headers = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            );
            socket.write_all(headers.as_bytes()).await?;
            // A multi-megabyte prefix also exercises real socket backpressure:
            // its completed write requires the production body reader to run.
            let prefix_len = body.len() / 2;
            socket.write_all(&body[..prefix_len]).await?;
            prefix_sent.send(()).unwrap();
            if tail_released.await.unwrap() {
                socket.write_all(&body[prefix_len..]).await?;
            } else {
                let mut byte = [0];
                assert_eq!(socket.read(&mut byte).await?, 0);
            }
            Ok(())
        });
        Self {
            url,
            prefix_sent: prefix_received,
            release_tail: Some(release_tail),
            task: Some(task),
        }
    }

    fn api(&self) -> ApiClient {
        ApiClient::new(
            HttpClient::new(HttpClientConfig {
                api_url: self.url.clone(),
                vercel_bypass: None,
                client_session_id: "catalog-download-timeout-test".to_string(),
                runner_version: env!("CARGO_PKG_VERSION"),
            })
            .unwrap(),
            "private-runner-token".to_string(),
        )
    }

    async fn wait_for_prefix<F>(&mut self, mut refresh: Pin<&mut F>)
    where
        F: Future<Output = ProviderResult<()>>,
    {
        tokio::time::timeout(PEER_TIMEOUT, async {
            tokio::select! {
                result = refresh.as_mut() => panic!("refresh finished before the body prefix: {result:?}"),
                result = &mut self.prefix_sent => result.unwrap(),
            }
        })
        .await
        .expect("peer prefix must finish on running time");
        std::future::poll_fn(|cx| {
            assert!(refresh.as_mut().poll(cx).is_pending());
            Poll::Ready(())
        })
        .await;
    }

    fn release(&mut self, finish_body: bool) {
        self.release_tail.take().unwrap().send(finish_body).unwrap();
    }

    async fn finish(mut self) {
        join_raw_http_task(self.task.take().unwrap(), "catalog body peer")
            .await
            .unwrap();
    }
}

impl Drop for CatalogBodyPeer {
    fn drop(&mut self) {
        if let Some(task) = self.task.take() {
            task.abort();
        }
    }
}

fn large_catalog() -> (BuiltinFirewallCatalog, Vec<u8>) {
    let mut expected = catalog("template");
    let mut firewall = expected.firewalls.remove("template").unwrap();
    firewall.apis[0].permissions.as_mut().unwrap()[0].rules = (0..32)
        .map(|rule| format!("GET /resources/{rule}/records/{}", "a".repeat(64)))
        .collect();
    expected.firewalls = (0..4_000)
        .map(|index| {
            let mut entry = firewall.clone();
            entry.name = format!("connector-{index:04}");
            (entry.name.clone(), entry)
        })
        .collect();
    let body = serde_json::to_vec(&expected).unwrap();
    assert!(body.len() > 10 * 1024 * 1024);
    assert!(u64::try_from(body.len()).unwrap() < BUILTIN_FIREWALL_CATALOG_MAX_BYTES);
    (expected, body)
}

// The real request/body future stays owned and unpolled while only its armed
// timer is advanced. Socket setup, prefix I/O, completion and cleanup run with
// the clock resumed, so kernel I/O cannot lose a race to automatic advancement.
async fn advance_download_time(elapsed: Duration) {
    tokio::time::pause();
    tokio::time::advance(elapsed).await;
    tokio::time::resume();
}

#[tokio::test]
async fn initial_refresh_publishes_large_body_after_old_download_deadline() {
    let (expected, body) = large_catalog();
    let mut peer = CatalogBodyPeer::start(body, None).await;
    let api = peer.api();
    let dir = tempfile::tempdir().unwrap();
    let cache_path = dir.path().join("catalog.json");
    let lock_path = dir.path().join("catalog.lock");
    let cancel = CancellationToken::new();
    let refresh = run_initial_refresh(&api, &cache_path, &lock_path, &cancel);
    tokio::pin!(refresh);

    peer.wait_for_prefix(refresh.as_mut()).await;
    assert!(!cache_path.exists(), "partial policy must not publish");
    advance_download_time(Duration::from_secs(15)).await;
    peer.release(true);
    tokio::time::timeout(PEER_TIMEOUT, refresh)
        .await
        .expect("complete large catalog must publish")
        .unwrap();

    let cache = read_catalog_cache(&cache_path).await.unwrap().unwrap();
    assert_eq!(cache.catalog_digest, expected.catalog_digest);
    assert_eq!(cache.catalog_version, expected.catalog_version);
    assert_eq!(cache.firewalls, expected.firewalls);
    peer.finish().await;
}

#[tokio::test]
async fn incomplete_large_body_still_times_out_and_preserves_last_good_cache() {
    let (_, body) = large_catalog();
    let body_len = u64::try_from(body.len()).unwrap();
    let mut peer = CatalogBodyPeer::start(body, Some(catalog_response())).await;
    let api = peer.api();
    let dir = tempfile::tempdir().unwrap();
    let cache_path = dir.path().join("catalog.json");
    let lock_path = dir.path().join("catalog.lock");
    let cancel = CancellationToken::new();
    run_initial_refresh(&api, &cache_path, &lock_path, &cancel)
        .await
        .unwrap();
    let original = tokio::fs::read(&cache_path).await.unwrap();
    let refresh = refresh_once(&api, &cache_path, &lock_path, cancel.clone());
    tokio::pin!(refresh);

    peer.wait_for_prefix(refresh.as_mut()).await;
    advance_download_time(Duration::from_secs(61)).await;
    let error = tokio::time::timeout(PEER_TIMEOUT, refresh)
        .await
        .expect("incomplete catalog must retain a finite total deadline")
        .unwrap_err();
    let ProviderError::ApiBodyRead(error) = error else {
        panic!("expected response-body timeout, got {error}");
    };
    assert_eq!(error.failure_cause, ApiTransportCause::Timeout);
    assert_eq!(error.status.as_u16(), 200);
    assert_eq!(error.content_length, Some(body_len));
    assert!(error.received_bytes > 0 && error.received_bytes < body_len);
    assert_eq!(tokio::fs::read(&cache_path).await.unwrap(), original);
    peer.release(false);
    peer.finish().await;
}

#[tokio::test]
async fn cancellation_interrupts_large_body_before_download_deadline() {
    let (_, body) = large_catalog();
    let mut peer = CatalogBodyPeer::start(body, None).await;
    let api = peer.api();
    let dir = tempfile::tempdir().unwrap();
    let cache_path = dir.path().join("catalog.json");
    let lock_path = dir.path().join("catalog.lock");
    let cancel = CancellationToken::new();
    let refresh = run_initial_refresh(&api, &cache_path, &lock_path, &cancel);
    tokio::pin!(refresh);

    peer.wait_for_prefix(refresh.as_mut()).await;
    cancel.cancel();
    assert!(
        tokio::time::timeout(PEER_TIMEOUT, refresh)
            .await
            .expect("cancellation must interrupt the incomplete response")
            .is_err()
    );
    assert!(
        !cache_path.exists(),
        "cancelled partial policy must not publish"
    );
    peer.release(false);
    peer.finish().await;
}
