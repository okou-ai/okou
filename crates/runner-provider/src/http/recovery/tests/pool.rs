use super::client;
use crate::error::{ApiTransportCause, ProviderError};
use crate::http::HttpClient;
use crate::test_fixtures::raw_http::{join_raw_http_task, read_http_request};
use reqwest::Method;
use tokio::io::AsyncWriteExt;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::oneshot;
use tokio_util::task::AbortOnDropHandle;

async fn respond(socket: &mut TcpStream, body: &str, close: bool) {
    socket
        .write_all(
            format!(
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: {}\r\n\r\n{body}",
                body.len(),
                if close { "close" } else { "keep-alive" },
            )
            .as_bytes(),
        )
        .await
        .unwrap();
}

async fn read(http: &HttpClient, origin: &str, path: &str) -> String {
    http.authenticated_request(Method::GET, format!("{origin}{path}"), "private-token")
        .send("pool read")
        .await
        .unwrap()
        .text()
        .await
        .unwrap()
}

fn assert_reset(error: ProviderError) {
    assert!(matches!(error, ProviderError::ApiTransport(error)
        if error.failure_cause == ApiTransportCause::ConnectionReset));
}

#[tokio::test]
async fn recovery_leaves_the_failed_idle_pool_and_later_sends_reuse_its_replacement() {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let origin = format!("http://{}", listener.local_addr().unwrap());
    let peer = AbortOnDropHandle::new(tokio::spawn(async move {
        // Hold the first response until two connections exist, so recovery
        // cannot pass merely by exhausting a pool that contained one socket.
        let (mut first, _) = listener.accept().await.unwrap();
        read_http_request(&mut first).await.unwrap();
        let (mut second, _) = listener.accept().await.unwrap();
        read_http_request(&mut second).await.unwrap();
        respond(&mut first, "warm", false).await;
        respond(&mut second, "warm", false).await;

        let (failed, mut idle) = tokio::select! {
            request = read_http_request(&mut first) => {
                assert!(request.unwrap().starts_with("GET /reset HTTP/1.1"));
                (first, second)
            }
            request = read_http_request(&mut second) => {
                assert!(request.unwrap().starts_with("GET /reset HTTP/1.1"));
                (second, first)
            }
        };
        failed.set_zero_linger().unwrap();
        drop(failed);

        let (mut replacement, _) = tokio::select! {
            accepted = listener.accept() => accepted.unwrap(),
            request = read_http_request(&mut idle) => {
                // Pool retirement may close an idle socket, but must never send
                // the replay over the other connection from that old pool.
                assert!(request.is_err(), "replay reused the failed pool");
                listener.accept().await.unwrap()
            }
        };
        let replay = read_http_request(&mut replacement).await.unwrap();
        assert!(replay.starts_with("GET /reset HTTP/1.1"));
        respond(&mut replacement, "recovered", false).await;
        for path in ["/prepared", "/again"] {
            let request = tokio::select! {
                request = read_http_request(&mut replacement) => request.unwrap(),
                _ = listener.accept() => panic!("healthy replacement was not reused"),
            };
            assert!(request.starts_with(&format!("GET {path} HTTP/1.1")));
            respond(&mut replacement, path, path == "/again").await;
        }
    }));
    let http = client(&origin);
    let (first, second) = tokio::join!(
        read(&http, &origin, "/warm-first"),
        read(&http, &origin, "/warm-second"),
    );
    assert_eq!((first.as_str(), second.as_str()), ("warm", "warm"));
    let prepared = http
        .authenticated_request(Method::GET, format!("{origin}/prepared"), "private-token")
        .prepare("prepared before reset")
        .unwrap();
    assert_eq!(read(&http, &origin, "/reset").await, "recovered");
    assert_eq!(
        prepared.send().await.unwrap().text().await.unwrap(),
        "/prepared"
    );
    assert_eq!(read(&http, &origin, "/again").await, "/again");
    join_raw_http_task(peer.detach(), "pooled reset peer").await;
}

#[tokio::test]
async fn replacement_preserves_active_headers_and_bodies_and_ignores_late_old_resets() {
    for body_started in [false, true] {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let (healthy_entered, healthy_received) = oneshot::channel();
        let (late_entered, late_received) = oneshot::channel();
        let (release_late, late_release) = oneshot::channel();
        let (release_healthy, healthy_release) = oneshot::channel();
        let peer = AbortOnDropHandle::new(tokio::spawn(async move {
            let (mut healthy, _) = listener.accept().await.unwrap();
            assert!(
                read_http_request(&mut healthy)
                    .await
                    .unwrap()
                    .starts_with("GET /healthy HTTP/1.1")
            );
            if body_started {
                healthy
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 6\r\n\r\nabc")
                    .await
                    .unwrap();
            }
            healthy_entered.send(()).unwrap();

            let (mut late, _) = listener.accept().await.unwrap();
            assert!(
                read_http_request(&mut late)
                    .await
                    .unwrap()
                    .starts_with("POST /late HTTP/1.1")
            );
            late_entered.send(()).unwrap();

            let (mut trigger, _) = listener.accept().await.unwrap();
            assert!(
                read_http_request(&mut trigger)
                    .await
                    .unwrap()
                    .starts_with("POST /trigger HTTP/1.1")
            );
            trigger.set_zero_linger().unwrap();
            drop(trigger);

            let (mut replacement, _) = listener.accept().await.unwrap();
            assert!(
                read_http_request(&mut replacement)
                    .await
                    .unwrap()
                    .starts_with("GET /ready HTTP/1.1")
            );
            respond(&mut replacement, "ready", false).await;

            late_release.await.unwrap();
            late.set_zero_linger().unwrap();
            drop(late);
            healthy_release.await.unwrap();
            if body_started {
                healthy.write_all(b"def").await.unwrap();
            } else {
                respond(&mut healthy, "abcdef", true).await;
            }

            let request = tokio::select! {
                request = read_http_request(&mut replacement) => request.unwrap(),
                _ = listener.accept() => panic!("late old reset retired the healthy pool"),
            };
            assert!(request.starts_with("GET /after HTTP/1.1"));
            respond(&mut replacement, "after", true).await;
        }));
        let http = client(&origin);
        let healthy_http = http.clone();
        let healthy_origin = origin.clone();
        let (body_read, body_read_started) = oneshot::channel();
        let healthy = AbortOnDropHandle::new(tokio::spawn(async move {
            let mut response = healthy_http
                .authenticated_request(
                    Method::GET,
                    format!("{healthy_origin}/healthy"),
                    "private-token",
                )
                .send("healthy")
                .await
                .unwrap();
            // Drop the last facade reference owned by this request too: in the
            // body case the old pool must not need a live caller-side client.
            drop(healthy_http);
            if body_started {
                let mut prefix = Vec::new();
                while prefix.len() < 3 {
                    prefix.extend_from_slice(&response.chunk().await.unwrap().unwrap());
                }
                assert_eq!(prefix, b"abc");
                body_read.send(()).unwrap();
                format!("abc{}", response.text().await.unwrap())
            } else {
                response.text().await.unwrap()
            }
        }));
        healthy_received.await.unwrap();
        if body_started {
            body_read_started.await.unwrap();
        }
        let late_request = http
            .authenticated_request(Method::POST, format!("{origin}/late"), "private-token")
            .prepare("late old request")
            .unwrap();
        let late = AbortOnDropHandle::new(tokio::spawn(late_request.send()));
        late_received.await.unwrap();
        let ready = http
            .authenticated_request(Method::GET, format!("{origin}/ready"), "private-token")
            .prepare("prepared before replacement")
            .unwrap();
        let error = http
            .authenticated_request(Method::POST, format!("{origin}/trigger"), "private-token")
            .send("unsafe reset")
            .await
            .unwrap_err();
        assert_reset(error);
        assert_eq!(ready.send().await.unwrap().text().await.unwrap(), "ready");
        release_late.send(()).unwrap();
        assert_reset(
            join_raw_http_task(late.detach(), "late old request")
                .await
                .unwrap_err(),
        );
        release_healthy.send(()).unwrap();
        assert_eq!(
            join_raw_http_task(healthy.detach(), "healthy request").await,
            "abcdef"
        );
        assert_eq!(read(&http, &origin, "/after").await, "after");
        join_raw_http_task(peer.detach(), "active response peer").await;
    }
}
