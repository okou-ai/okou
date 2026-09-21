use std::future::Future;
use std::path::Path;
use std::sync::Arc;
use std::task::{Context, Poll};
use std::time::Duration;

use futures_util::future::join_all;
use futures_util::task::noop_waker_ref;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, Lines};
use tokio::sync::{mpsc, oneshot};
use tokio::time::timeout;
use tokio_util::sync::CancellationToken;
use tracing::warn;

use crate::ids::RunId;

const DEFAULT_DRAIN_TIMEOUT: Duration = Duration::from_millis(500);
const DRAIN_STATUS_NOT_CONFIGURED: &str = "not_configured";
/// Maximum ready lines handled before yielding and rechecking drain control state.
const READY_LINE_DRAIN_SLICE_SIZE: usize = 64;

macro_rules! warn_drain {
    ($context:expr, $producer:expr, $message:literal) => {{
        let context = &$context;
        let producer = $producer;
        warn!(
            run_id = %context.run_id,
            source_ip = context.source_ip,
            path = %context.path.display(),
            generation = context.generation,
            producer = producer,
            $message
        );
    }};
    ($context:expr, $producer:expr, timeout_ms = $timeout_ms:expr, $message:literal) => {{
        let context = &$context;
        let producer = $producer;
        let timeout_ms = $timeout_ms;
        warn!(
            run_id = %context.run_id,
            source_ip = context.source_ip,
            path = %context.path.display(),
            generation = context.generation,
            producer = producer,
            timeout_ms = timeout_ms,
            $message
        );
    }};
}

#[derive(Clone)]
pub struct NetworkLogDrainCoordinator {
    producers: Arc<Vec<NetworkLogDrainProducer>>,
    timeout: Duration,
}

impl Default for NetworkLogDrainCoordinator {
    fn default() -> Self {
        Self::noop()
    }
}

impl NetworkLogDrainCoordinator {
    pub fn new(producers: Vec<NetworkLogDrainProducer>) -> Self {
        Self {
            producers: Arc::new(producers),
            timeout: DEFAULT_DRAIN_TIMEOUT,
        }
    }

    pub fn noop() -> Self {
        Self::new(Vec::new())
    }

    runner_test_support!(network; #[cfg(test)]
    pub(crate) fn new_with_timeout_for_test(
        producers: Vec<NetworkLogDrainProducer>,
        timeout: Duration,
    ) -> Self {
        Self {
            producers: Arc::new(producers),
            timeout,
        }
    });

    pub async fn drain(&self, context: NetworkLogDrainContext<'_>) -> NetworkLogDrainReport {
        let outcomes = join_all(
            self.producers
                .iter()
                .map(|producer| producer.drain(context, self.timeout)),
        )
        .await;
        NetworkLogDrainReport {
            producers: self
                .producers
                .iter()
                .zip(outcomes)
                .map(|(producer, outcome)| (producer.name, outcome))
                .collect(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum NetworkLogDrainOutcome {
    Acknowledged,
    ProducerUnavailable,
    RequestTimeout,
    AckDropped,
    AckTimeout,
}

impl NetworkLogDrainOutcome {
    fn as_str(self) -> &'static str {
        match self {
            Self::Acknowledged => "acknowledged",
            Self::ProducerUnavailable => "producer_unavailable",
            Self::RequestTimeout => "request_timeout",
            Self::AckDropped => "ack_dropped",
            Self::AckTimeout => "ack_timeout",
        }
    }
}

#[derive(Default)]
pub struct NetworkLogDrainReport {
    producers: Vec<(&'static str, NetworkLogDrainOutcome)>,
}

impl NetworkLogDrainReport {
    pub(crate) fn status(&self, producer: &str) -> &'static str {
        self.producers
            .iter()
            .find_map(|(name, outcome)| (*name == producer).then_some(outcome.as_str()))
            .unwrap_or(DRAIN_STATUS_NOT_CONFIGURED)
    }
}

#[derive(Clone)]
pub struct NetworkLogDrainProducer {
    name: &'static str,
    tx: mpsc::Sender<NetworkLogDrainRequest>,
}

impl NetworkLogDrainProducer {
    pub fn channel(name: &'static str) -> (Self, mpsc::Receiver<NetworkLogDrainRequest>) {
        let (tx, rx) = mpsc::channel(64);
        (Self { name, tx }, rx)
    }

    pub(crate) async fn drain(
        &self,
        context: NetworkLogDrainContext<'_>,
        wait: Duration,
    ) -> NetworkLogDrainOutcome {
        let (ack_tx, ack_rx) = oneshot::channel();
        match timeout(wait, self.tx.send(NetworkLogDrainRequest { ack: ack_tx })).await {
            Ok(Ok(())) => {}
            Ok(Err(_)) => {
                warn_drain!(context, self.name, "network log drain producer unavailable");
                return NetworkLogDrainOutcome::ProducerUnavailable;
            }
            Err(_) => {
                warn_drain!(
                    context,
                    self.name,
                    timeout_ms = wait.as_millis(),
                    "network log drain request timed out"
                );
                return NetworkLogDrainOutcome::RequestTimeout;
            }
        }

        match timeout(wait, ack_rx).await {
            Ok(Ok(())) => NetworkLogDrainOutcome::Acknowledged,
            Ok(Err(_)) => {
                warn_drain!(context, self.name, "network log drain producer dropped ack");
                NetworkLogDrainOutcome::AckDropped
            }
            Err(_) => {
                warn_drain!(
                    context,
                    self.name,
                    timeout_ms = wait.as_millis(),
                    "network log drain producer timed out"
                );
                NetworkLogDrainOutcome::AckTimeout
            }
        }
    }
}

pub(crate) struct NetworkLogDrainRequest {
    ack: oneshot::Sender<()>,
}

impl NetworkLogDrainRequest {
    pub(crate) fn ack(self) {
        let _ = self.ack.send(());
    }

    fn is_abandoned(&self) -> bool {
        self.ack.is_closed()
    }
}

#[derive(Clone, Copy)]
pub struct NetworkLogDrainContext<'a> {
    pub run_id: RunId,
    pub source_ip: &'a str,
    pub path: &'a Path,
    pub generation: u64,
}

pub(crate) enum ReadyLine {
    Line(String),
    Eof,
    Pending,
}

#[derive(Debug)]
pub(crate) enum DrainableLineReaderExit {
    Cancelled,
    DrainChannelClosed,
    Eof {
        during_drain: bool,
    },
    ReadError {
        during_drain: bool,
        error: std::io::Error,
    },
}

#[derive(Debug)]
enum DrainReadyLinesOutcome {
    Continue,
    Stop(DrainableLineReaderExit),
}

pub(crate) async fn run_drainable_line_reader<R, F, Fut>(
    reader: R,
    cancel: CancellationToken,
    mut drain_rx: mpsc::Receiver<NetworkLogDrainRequest>,
    mut on_line: F,
) -> DrainableLineReaderExit
where
    R: AsyncBufRead + Unpin,
    F: FnMut(String) -> Fut,
    Fut: Future<Output = ()>,
{
    let mut lines = reader.lines();
    loop {
        tokio::select! {
            _ = cancel.cancelled() => return DrainableLineReaderExit::Cancelled,
            request = drain_rx.recv() => {
                let Some(request) = request else {
                    return DrainableLineReaderExit::DrainChannelClosed;
                };
                let outcome =
                    process_drain_request(&mut lines, &cancel, &mut on_line, request).await;
                if let DrainReadyLinesOutcome::Stop(exit) = outcome {
                    return exit;
                }
            }
            result = lines.next_line() => {
                let line = match result {
                    Ok(Some(line)) => line,
                    Ok(None) => return DrainableLineReaderExit::Eof {
                        during_drain: false,
                    },
                    Err(e) => {
                        return DrainableLineReaderExit::ReadError {
                            during_drain: false,
                            error: e,
                        };
                    }
                };
                on_line(line).await;
            }
        }
    }
}

async fn process_drain_request<R, F, Fut>(
    lines: &mut Lines<R>,
    cancel: &CancellationToken,
    on_line: &mut F,
    request: NetworkLogDrainRequest,
) -> DrainReadyLinesOutcome
where
    R: AsyncBufRead + Unpin,
    F: FnMut(String) -> Fut,
    Fut: Future<Output = ()>,
{
    if cancel.is_cancelled() {
        return DrainReadyLinesOutcome::Stop(DrainableLineReaderExit::Cancelled);
    }
    if request.is_abandoned() {
        return DrainReadyLinesOutcome::Continue;
    }

    let mut ready_lines_in_slice = 0;
    loop {
        match poll_next_line_ready(lines) {
            Ok(ReadyLine::Line(line)) => {
                on_line(line).await;
                ready_lines_in_slice += 1;
                if ready_lines_in_slice == READY_LINE_DRAIN_SLICE_SIZE {
                    // An always-ready stream must not keep this task inside one drain forever.
                    tokio::task::yield_now().await;
                    if cancel.is_cancelled() {
                        return DrainReadyLinesOutcome::Stop(DrainableLineReaderExit::Cancelled);
                    }
                    if request.is_abandoned() {
                        return DrainReadyLinesOutcome::Continue;
                    }
                    ready_lines_in_slice = 0;
                }
            }
            Ok(ReadyLine::Pending) => {
                request.ack();
                return DrainReadyLinesOutcome::Continue;
            }
            Ok(ReadyLine::Eof) => {
                request.ack();
                return DrainReadyLinesOutcome::Stop(DrainableLineReaderExit::Eof {
                    during_drain: true,
                });
            }
            Err(e) => {
                request.ack();
                return DrainReadyLinesOutcome::Stop(DrainableLineReaderExit::ReadError {
                    during_drain: true,
                    error: e,
                });
            }
        }
    }
}

/// Poll `Lines::next_line` once without waiting for future readiness.
///
/// `Lines::next_line` is cancellation-safe; when the poll returns `Pending`,
/// dropping the future preserves the reader state for the normal loop. This is
/// the producer-owned barrier used to drain complete lines that are immediately
/// observable to the runner reader task without sleeping.
///
/// Exclude Tokio's cooperative budget only from this probe: a scheduler yield
/// must not masquerade as an empty input boundary. The drain loop still awaits
/// callbacks normally and yields after each bounded slice of ready lines.
pub(crate) fn poll_next_line_ready<R>(lines: &mut Lines<R>) -> std::io::Result<ReadyLine>
where
    R: AsyncBufRead + Unpin,
{
    let mut next = std::pin::pin!(tokio::task::unconstrained(lines.next_line()));
    let mut cx = Context::from_waker(noop_waker_ref());
    match Future::poll(next.as_mut(), &mut cx) {
        Poll::Ready(Ok(Some(line))) => Ok(ReadyLine::Line(line)),
        Poll::Ready(Ok(None)) => Ok(ReadyLine::Eof),
        Poll::Ready(Err(e)) => Err(e),
        Poll::Pending => Ok(ReadyLine::Pending),
    }
}

runner_test_group!(network; #[cfg(test)]
mod cooperative_tests;);

runner_test_group!(network; #[cfg(test)]
mod tests {
    use std::io;
    use std::path::Path;
    use std::pin::Pin;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::{Arc, Mutex};
    use std::task::{Context, Poll};
    use std::time::Duration;

    use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncRead, AsyncWriteExt, BufReader, ReadBuf};
    use tokio::sync::oneshot;

    use super::*;
    use crate::ids::RunId;

    fn drain_context(path: &Path) -> NetworkLogDrainContext<'_> {
        NetworkLogDrainContext {
            run_id: RunId::nil(),
            source_ip: "10.0.0.1",
            path,
            generation: 1,
        }
    }

    #[tokio::test]
    async fn drain_reports_acknowledged_producers_and_unconfigured_names() {
        let path = Path::new("network.jsonl");
        let (dns, mut dns_rx) = NetworkLogDrainProducer::channel("dns");
        let (kmsg, mut kmsg_rx) = NetworkLogDrainProducer::channel("kmsg");
        let acknowledge = tokio::spawn(async move {
            dns_rx.recv().await.unwrap().ack();
            kmsg_rx.recv().await.unwrap().ack();
        });

        let report = NetworkLogDrainCoordinator::new(vec![dns, kmsg])
            .drain(drain_context(path))
            .await;
        acknowledge.await.unwrap();

        assert_eq!(report.status("dns"), "acknowledged");
        assert_eq!(report.status("kmsg"), "acknowledged");
        assert_eq!(report.status("other"), "not_configured");
        assert_eq!(
            NetworkLogDrainCoordinator::noop()
                .drain(drain_context(path))
                .await
                .status("dns"),
            "not_configured"
        );
    }

    #[tokio::test]
    async fn producer_drain_reports_unavailable() {
        let path = Path::new("network.jsonl");
        let (producer, drain_rx) = NetworkLogDrainProducer::channel("dns");
        drop(drain_rx);

        let outcome = producer
            .drain(drain_context(path), Duration::from_secs(1))
            .await;

        assert_eq!(outcome, NetworkLogDrainOutcome::ProducerUnavailable);
    }

    #[tokio::test]
    async fn producer_drain_reports_request_timeout() {
        let path = Path::new("network.jsonl");
        let (producer, _drain_rx) = NetworkLogDrainProducer::channel("dns");
        let mut acknowledgements = Vec::new();
        for _ in 0..64 {
            let (ack, ack_rx) = oneshot::channel();
            producer
                .tx
                .try_send(NetworkLogDrainRequest { ack })
                .unwrap();
            acknowledgements.push(ack_rx);
        }

        let outcome = producer
            .drain(drain_context(path), Duration::from_millis(1))
            .await;

        assert_eq!(outcome, NetworkLogDrainOutcome::RequestTimeout);
        drop(acknowledgements);
    }

    #[tokio::test]
    async fn producer_drain_reports_dropped_ack() {
        let path = Path::new("network.jsonl");
        let (producer, mut drain_rx) = NetworkLogDrainProducer::channel("dns");
        let drop_ack = tokio::spawn(async move {
            drop(drain_rx.recv().await.unwrap());
        });

        let outcome = producer
            .drain(drain_context(path), Duration::from_secs(1))
            .await;
        drop_ack.await.unwrap();

        assert_eq!(outcome, NetworkLogDrainOutcome::AckDropped);
    }

    #[tokio::test]
    async fn producer_drain_reports_ack_timeout() {
        let path = Path::new("network.jsonl");
        let (producer, _drain_rx) = NetworkLogDrainProducer::channel("dns");

        let outcome = producer
            .drain(drain_context(path), Duration::from_millis(1))
            .await;

        assert_eq!(outcome, NetworkLogDrainOutcome::AckTimeout);
    }

    #[tokio::test]
    async fn drainable_line_reader_processes_ready_line_before_ack() {
        let path = Path::new("network.jsonl");
        let cancel = CancellationToken::new();
        let (producer, drain_rx) = NetworkLogDrainProducer::channel("reader-test");
        let (mut writer, reader) = tokio::io::duplex(1024);
        let handled = Arc::new(Mutex::new(Vec::new()));
        let handled_for_task = handled.clone();
        let task = tokio::spawn(run_drainable_line_reader(
            BufReader::new(reader),
            cancel.clone(),
            drain_rx,
            move |line| {
                let handled = handled_for_task.clone();
                async move {
                    handled.lock().unwrap().push(line);
                }
            },
        ));

        writer.write_all(b"first\n").await.unwrap();

        let outcome = producer
            .drain(drain_context(path), Duration::from_secs(1))
            .await;

        assert_eq!(outcome, NetworkLogDrainOutcome::Acknowledged);
        assert_eq!(handled.lock().unwrap().as_slice(), ["first"]);

        cancel.cancel();
        drop(writer);
        assert!(matches!(
            task.await.unwrap(),
            DrainableLineReaderExit::Cancelled | DrainableLineReaderExit::Eof { .. }
        ));
    }

    #[tokio::test]
    async fn drainable_line_reader_returns_eof_on_normal_eof() {
        let cancel = CancellationToken::new();
        let (_producer, drain_rx) = NetworkLogDrainProducer::channel("reader-test");

        let exit = run_drainable_line_reader(
            BufReader::new(tokio::io::empty()),
            cancel,
            drain_rx,
            |_| async {},
        )
        .await;

        assert!(matches!(
            exit,
            DrainableLineReaderExit::Eof {
                during_drain: false
            }
        ));
    }

    #[tokio::test]
    async fn drainable_line_reader_acknowledges_eof_after_ready_lines() {
        let cancel = CancellationToken::new();
        let handled = Arc::new(Mutex::new(Vec::new()));
        let ack_seen_in_handler = Arc::new(Mutex::new(None));
        let mut lines = TestReader::from_bytes(b"first\n").lines();
        let (ack, ack_rx) = oneshot::channel();
        let ack_rx = Arc::new(Mutex::new(ack_rx));
        let request = NetworkLogDrainRequest { ack };

        let outcome = process_drain_request(
            &mut lines,
            &cancel,
            &mut |line| {
                let handled = handled.clone();
                let ack_seen_in_handler = ack_seen_in_handler.clone();
                let ack_rx = ack_rx.clone();
                async move {
                    let ack_result = ack_rx.lock().unwrap().try_recv();
                    *ack_seen_in_handler.lock().unwrap() = Some(ack_result.is_ok());
                    handled.lock().unwrap().push(line);
                }
            },
            request,
        )
        .await;

        assert_eq!(*ack_seen_in_handler.lock().unwrap(), Some(false));
        ack_rx.lock().unwrap().try_recv().unwrap();
        assert_eq!(handled.lock().unwrap().as_slice(), ["first"]);
        assert!(matches!(
            outcome,
            DrainReadyLinesOutcome::Stop(DrainableLineReaderExit::Eof { during_drain: true })
        ));
    }

    #[tokio::test]
    async fn drainable_line_reader_acknowledges_drain_read_error() {
        let cancel = CancellationToken::new();
        let mut lines = TestReader::with_error(io::ErrorKind::Other).lines();
        let (ack, ack_rx) = oneshot::channel();
        let request = NetworkLogDrainRequest { ack };

        let outcome = process_drain_request(&mut lines, &cancel, &mut |_| async {}, request).await;

        ack_rx.await.unwrap();
        match outcome {
            DrainReadyLinesOutcome::Stop(DrainableLineReaderExit::ReadError {
                during_drain,
                error,
            }) => {
                assert!(during_drain);
                assert_eq!(error.kind(), io::ErrorKind::Other);
            }
            other => panic!("expected read error, got {other:?}"),
        }
    }

    #[tokio::test]
    async fn drainable_line_reader_acknowledges_after_multiple_ready_line_slices() {
        let cancel = CancellationToken::new();
        let input = b"line\n".repeat(READY_LINE_DRAIN_SLICE_SIZE + 1);
        let mut lines = TestReader::from_bytes(&input).lines();
        let handled = Arc::new(AtomicUsize::new(0));
        let (ack, mut ack_rx) = oneshot::channel();
        let request = NetworkLogDrainRequest { ack };
        let mut on_line = |_| {
            let handled = handled.clone();
            async move {
                handled.fetch_add(1, Ordering::Relaxed);
            }
        };
        let mut drain = std::pin::pin!(process_drain_request(
            &mut lines,
            &cancel,
            &mut on_line,
            request,
        ));

        let mut cx = Context::from_waker(futures_util::task::noop_waker_ref());
        assert!(matches!(drain.as_mut().poll(&mut cx), Poll::Pending));
        assert_eq!(handled.load(Ordering::Relaxed), READY_LINE_DRAIN_SLICE_SIZE);
        assert!(matches!(
            ack_rx.try_recv(),
            Err(oneshot::error::TryRecvError::Empty)
        ));

        let outcome = drain.await;

        ack_rx.await.unwrap();
        assert_eq!(
            handled.load(Ordering::Relaxed),
            READY_LINE_DRAIN_SLICE_SIZE + 1
        );
        assert!(matches!(
            outcome,
            DrainReadyLinesOutcome::Stop(DrainableLineReaderExit::Eof { during_drain: true })
        ));
    }

    #[tokio::test]
    async fn drainable_line_reader_abandons_always_ready_drain() {
        let cancel = CancellationToken::new();
        let mut lines = AlwaysReadyReader::new().lines();
        let handled = Arc::new(AtomicUsize::new(0));
        let (ack, ack_rx) = oneshot::channel();
        let ack_rx = Arc::new(Mutex::new(Some(ack_rx)));
        let request = NetworkLogDrainRequest { ack };

        let outcome = process_drain_request(
            &mut lines,
            &cancel,
            &mut |_| {
                let handled = handled.clone();
                let ack_rx = ack_rx.clone();
                async move {
                    if handled.fetch_add(1, Ordering::Relaxed) == 0 {
                        drop(ack_rx.lock().unwrap().take());
                    }
                }
            },
            request,
        )
        .await;

        assert_eq!(handled.load(Ordering::Relaxed), READY_LINE_DRAIN_SLICE_SIZE);
        assert!(matches!(outcome, DrainReadyLinesOutcome::Continue));
    }

    #[tokio::test]
    async fn drainable_line_reader_cancels_always_ready_drain() {
        let cancel = CancellationToken::new();
        let mut lines = AlwaysReadyReader::new().lines();
        let handled = Arc::new(AtomicUsize::new(0));
        let (ack, ack_rx) = oneshot::channel();
        let request = NetworkLogDrainRequest { ack };

        let outcome = process_drain_request(
            &mut lines,
            &cancel,
            &mut |_| {
                let cancel = cancel.clone();
                let handled = handled.clone();
                async move {
                    if handled.fetch_add(1, Ordering::Relaxed) == 0 {
                        cancel.cancel();
                    }
                }
            },
            request,
        )
        .await;

        assert_eq!(handled.load(Ordering::Relaxed), READY_LINE_DRAIN_SLICE_SIZE);
        assert!(ack_rx.await.is_err());
        assert!(matches!(
            outcome,
            DrainReadyLinesOutcome::Stop(DrainableLineReaderExit::Cancelled)
        ));
    }

    #[tokio::test]
    async fn drainable_line_reader_returns_cancelled() {
        let cancel = CancellationToken::new();
        cancel.cancel();
        let (_producer, drain_rx) = NetworkLogDrainProducer::channel("reader-test");

        let exit = timeout(
            Duration::from_secs(1),
            run_drainable_line_reader(PendingReader, cancel, drain_rx, |_| async {}),
        )
        .await
        .expect("timed out waiting for drainable line reader cancellation");

        assert!(matches!(exit, DrainableLineReaderExit::Cancelled));
    }

    #[tokio::test]
    async fn drainable_line_reader_returns_drain_channel_closed() {
        let cancel = CancellationToken::new();
        let (producer, drain_rx) = NetworkLogDrainProducer::channel("reader-test");
        drop(producer);

        let exit = run_drainable_line_reader(PendingReader, cancel, drain_rx, |_| async {}).await;

        assert!(matches!(exit, DrainableLineReaderExit::DrainChannelClosed));
    }

    #[tokio::test]
    async fn drainable_line_reader_returns_normal_read_error() {
        let cancel = CancellationToken::new();
        let (_producer, drain_rx) = NetworkLogDrainProducer::channel("reader-test");

        let exit = run_drainable_line_reader(
            TestReader::with_error(io::ErrorKind::InvalidData),
            cancel,
            drain_rx,
            |_| async {},
        )
        .await;

        match exit {
            DrainableLineReaderExit::ReadError {
                during_drain,
                error,
            } => {
                assert!(!during_drain);
                assert_eq!(error.kind(), io::ErrorKind::InvalidData);
            }
            other => panic!("expected normal read error, got {other:?}"),
        }
    }

    struct TestReader {
        data: Vec<u8>,
        position: usize,
        error: Option<io::ErrorKind>,
    }

    impl TestReader {
        fn from_bytes(data: &[u8]) -> Self {
            Self {
                data: data.to_vec(),
                position: 0,
                error: None,
            }
        }

        fn with_error(kind: io::ErrorKind) -> Self {
            Self {
                data: Vec::new(),
                position: 0,
                error: Some(kind),
            }
        }
    }

    impl AsyncRead for TestReader {
        fn poll_read(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            match self.as_mut().poll_fill_buf(cx) {
                Poll::Ready(Ok(available)) => {
                    let len = available.len().min(buf.remaining());
                    buf.put_slice(&available[..len]);
                    self.consume(len);
                    Poll::Ready(Ok(()))
                }
                Poll::Ready(Err(e)) => Poll::Ready(Err(e)),
                Poll::Pending => Poll::Pending,
            }
        }
    }

    impl AsyncBufRead for TestReader {
        fn poll_fill_buf(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<&[u8]>> {
            let this = self.get_mut();
            if let Some(kind) = this.error.take() {
                return Poll::Ready(Err(io::Error::new(kind, "test read error")));
            }

            Poll::Ready(Ok(&this.data[this.position..]))
        }

        fn consume(mut self: Pin<&mut Self>, amt: usize) {
            self.position = self.position.saturating_add(amt).min(self.data.len());
        }
    }

    struct AlwaysReadyReader {
        fill_buf_polls: usize,
    }

    impl AlwaysReadyReader {
        fn new() -> Self {
            Self { fill_buf_polls: 0 }
        }
    }

    impl AsyncRead for AlwaysReadyReader {
        fn poll_read(
            mut self: Pin<&mut Self>,
            cx: &mut Context<'_>,
            buf: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            match self.as_mut().poll_fill_buf(cx) {
                Poll::Ready(Ok(available)) => {
                    let len = available.len().min(buf.remaining());
                    buf.put_slice(&available[..len]);
                    self.consume(len);
                    Poll::Ready(Ok(()))
                }
                Poll::Ready(Err(e)) => Poll::Ready(Err(e)),
                Poll::Pending => Poll::Pending,
            }
        }
    }

    impl AsyncBufRead for AlwaysReadyReader {
        fn poll_fill_buf(
            mut self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
        ) -> Poll<io::Result<&[u8]>> {
            self.fill_buf_polls += 1;
            assert!(
                self.fill_buf_polls <= READY_LINE_DRAIN_SLICE_SIZE * 2,
                "always-ready drain exceeded its cooperative work bound"
            );
            Poll::Ready(Ok(b"line\n"))
        }

        fn consume(self: Pin<&mut Self>, _amt: usize) {}
    }

    struct PendingReader;

    impl AsyncRead for PendingReader {
        fn poll_read(
            self: Pin<&mut Self>,
            _cx: &mut Context<'_>,
            _buf: &mut ReadBuf<'_>,
        ) -> Poll<io::Result<()>> {
            Poll::Pending
        }
    }

    impl AsyncBufRead for PendingReader {
        fn poll_fill_buf(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<io::Result<&[u8]>> {
            Poll::Pending
        }

        fn consume(self: Pin<&mut Self>, _amt: usize) {}
    }
});
