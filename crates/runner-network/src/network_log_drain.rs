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

use runner_types::ids::RunId;

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

    #[cfg(test)]
    pub(crate) fn new_with_timeout_for_test(
        producers: Vec<NetworkLogDrainProducer>,
        timeout: Duration,
    ) -> Self {
        Self {
            producers: Arc::new(producers),
            timeout,
        }
    }

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
pub enum NetworkLogDrainOutcome {
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
    pub fn status(&self, producer: &str) -> &'static str {
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
    pub(crate) fn channel(name: &'static str) -> (Self, mpsc::Receiver<NetworkLogDrainRequest>) {
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
pub enum DrainableLineReaderExit {
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
    let outcome = loop {
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
            Ok(ReadyLine::Pending) => break DrainReadyLinesOutcome::Continue,
            Ok(ReadyLine::Eof) => {
                break DrainReadyLinesOutcome::Stop(DrainableLineReaderExit::Eof {
                    during_drain: true,
                });
            }
            Err(e) => {
                break DrainReadyLinesOutcome::Stop(DrainableLineReaderExit::ReadError {
                    during_drain: true,
                    error: e,
                });
            }
        }
    };
    request.ack();
    outcome
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

#[cfg(test)]
mod cooperative_tests;

#[cfg(test)]
mod tests;
