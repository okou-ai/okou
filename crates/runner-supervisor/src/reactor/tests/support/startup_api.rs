use std::io;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};

use tokio::io::AsyncWriteExt;
use tokio::net::TcpListener;
use tokio_util::{sync::CancellationToken, task::AbortOnDropHandle};

use crate::test_fixtures::raw_http::{http_response, read_http_request};

/// Keep the nominal peer in the test runtime so paused time cannot outrun a
/// separate HTTP server thread during startup delivery or graceful shutdown.
pub(super) struct StartupApi {
    url: String,
    reports: Arc<AtomicUsize>,
    cancel: CancellationToken,
    task: Mutex<Option<AbortOnDropHandle<io::Result<()>>>>,
}

impl StartupApi {
    pub(super) fn start() -> Self {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        listener.set_nonblocking(true).unwrap();
        let listener = TcpListener::from_std(listener).unwrap();
        let reports = Arc::new(AtomicUsize::new(0));
        let cancel = CancellationToken::new();
        let task_cancel = cancel.clone();
        let task_reports = Arc::clone(&reports);
        let task = AbortOnDropHandle::new(tokio::spawn(async move {
            tokio::select! {
                biased;
                () = task_cancel.cancelled() => Ok(()),
                result = serve(listener, task_reports) => result,
            }
        }));
        Self {
            url,
            reports,
            cancel,
            task: Mutex::new(Some(task)),
        }
    }

    pub(super) fn url(&self) -> &str {
        &self.url
    }

    pub(super) fn assert_report_calls(&self, count: usize) {
        assert_eq!(self.reports.load(Ordering::SeqCst), count);
    }

    pub(super) async fn shutdown(&self) {
        self.cancel.cancel();
        let task = self.task.lock().unwrap().take();
        if let Some(task) = task {
            task.await
                .expect("startup API task should not panic")
                .expect("startup API should serve valid fixture requests");
        }
    }
}

async fn serve(listener: TcpListener, reports: Arc<AtomicUsize>) -> io::Result<()> {
    loop {
        let (mut socket, _) = listener.accept().await?;
        let request = match read_http_request(&mut socket).await {
            Ok(request) => request,
            Err(error) if peer_disconnected(&error) => continue,
            Err(error) => return Err(error),
        };
        let mut fields = request
            .lines()
            .next()
            .expect("complete HTTP request should have a request line")
            .split_ascii_whitespace();
        let startup = match (fields.next(), fields.next(), fields.next(), fields.next()) {
            (Some("PUT"), Some(path), Some("HTTP/1.1"), None) => path
                .strip_prefix("/api/runners/runs/")
                .and_then(|path| path.strip_suffix("/startup"))
                .is_some_and(|run_id| !run_id.is_empty() && !run_id.contains('/')),
            _ => false,
        };
        let status = if startup {
            reports.fetch_add(1, Ordering::SeqCst);
            "204 No Content"
        } else {
            "404 Not Found"
        };
        if let Err(error) = socket.write_all(&http_response(status, b"")).await
            && !peer_disconnected(&error)
        {
            return Err(error);
        }
    }
}

fn peer_disconnected(error: &io::Error) -> bool {
    // A cancelled Run can retire its HTTP request before the peer responds.
    matches!(
        error.kind(),
        io::ErrorKind::UnexpectedEof | io::ErrorKind::ConnectionReset | io::ErrorKind::BrokenPipe
    )
}
