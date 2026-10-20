//! Invocation-owned controls for one actual Firecracker resume/pause request.
//!
//! Capture occurs **before backend connection/dispatch**. It does not prove that
//! Firecracker accepted work. A drained HTTP response is transport evidence, not
//! safe reuse, required saving, Guest readiness or backing-process exit.
//!
//! Keep the producer and the complete native resource owner outside observation
//! timeouts. Explicitly join the producer or retain it with unresolved owners.
//! Dropping it never aborts accepted work, but detaching or runtime shutdown is
//! not a positive join. This fixture never adopts or replaces a live socket.

mod framing;
mod response;
mod routing;

pub use response::{BackendResponse, ResponseControl, ResponseDisposition};
pub use routing::RequestRoute;
pub(crate) use routing::request_socket;

use std::io;
use std::path::PathBuf;

use tokio::io::AsyncWriteExt;
use tokio::net::{UnixListener, UnixStream};
use tokio::sync::oneshot;
use tokio::task::JoinHandle;

/// The single production API transition allowed through a gate.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Transition {
    /// PATCH /vm with state Resumed.
    Resume,
    /// PATCH /vm with state Paused.
    Pause,
}

/// A validated complete request, captured before backend dispatch.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CapturedRequest {
    /// The expected transition actually present in the request.
    pub transition: Transition,
    /// Original HTTP bytes, forwarded without reserialization.
    pub raw: Vec<u8>,
}

/// Disposable test controls, independent of the forwarding/drain producer.
pub struct RequestControl {
    /// Arrival notification; losing this receiver does not cancel the producer.
    pub arrived: oneshot::Receiver<CapturedRequest>,
    /// Explicit dispatch permission; dropping it before release never dispatches.
    pub release: oneshot::Sender<()>,
}

/// The boundary at which a request producer failed.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum FailureStage {
    /// No valid complete expected request was captured.
    Capture,
    /// Backend connection failed before writing the request.
    Connect,
    /// Backend write failed; partial acceptance remains uncertain.
    BackendWrite,
    /// No complete valid terminal HTTP response was drained.
    BackendResponse,
    /// The producer task failed or was already joined.
    Producer,
}

/// An explicit failure, never evidence that native work or cleanup completed.
#[derive(Debug, thiserror::Error)]
#[error("request gate failed at {stage:?}: {error}")]
pub struct RequestFailure {
    /// Actual failed boundary; later stages may involve accepted native work.
    pub stage: FailureStage,
    /// Original validated request, when capture succeeded.
    pub request: Option<CapturedRequest>,
    /// Original transport, framing or task error.
    #[source]
    pub error: io::Error,
}

impl RequestFailure {
    /// Distinguish an actual joined task unwind from transport or reuse errors.
    pub fn producer_panicked(&self) -> bool {
        self.stage == FailureStage::Producer
            && self
                .error
                .get_ref()
                .and_then(|error| error.downcast_ref::<tokio::task::JoinError>())
                .is_some_and(tokio::task::JoinError::is_panic)
    }
}

/// A joined transport result; neither variant grants lifecycle authority.
#[derive(Debug)]
pub enum RequestOutcome {
    /// Release control disappeared before dispatch; no backend was connected.
    /// A request is present only if complete validated capture preceded loss.
    NotForwarded(Option<CapturedRequest>),
    /// A complete terminal backend HTTP response was drained.
    ResponseDrained {
        /// Exact original request.
        request: CapturedRequest,
        /// Actual backend status, including non-success responses.
        status: u16,
        /// Complete original response bytes.
        response: Vec<u8>,
        /// Local client write/shutdown outcome, independent of backend drain.
        /// Success is not an acknowledgement from the client application.
        delivery: io::Result<()>,
    },
}

/// The independently owned accepted request task.
#[must_use = "join the producer or retain it with the unresolved native owner"]
pub struct RequestProducer {
    task: Option<JoinHandle<Result<RequestOutcome, RequestFailure>>>,
}

impl RequestProducer {
    /// Join without consuming ownership while Pending.
    ///
    /// Cancelling this wait leaves the handle here for a later join. There is no
    /// post-dispatch timeout or abort: a bounded observation must retain this
    /// producer and the native capsule when the outcome remains unresolved.
    pub async fn join(&mut self) -> Result<RequestOutcome, RequestFailure> {
        let task = self.task.as_mut().ok_or_else(|| RequestFailure {
            stage: FailureStage::Producer,
            request: None,
            error: io::Error::other("request producer already joined"),
        })?;
        let result = task.await;
        self.task = None;
        result.map_err(|error| RequestFailure {
            stage: FailureStage::Producer,
            request: None,
            error: io::Error::other(error),
        })?
    }
}

/// Own one already-bound front listener and forward at most one transition.
///
/// Both paths/resources must belong to the invocation. The caller supplies a
/// listener rather than authorizing the fixture to rename/remove an existing
/// socket. No backend connection occurs until a complete expected request and
/// explicit release have both arrived. The caller also owns cancellation of a
/// client that receives `NotForwarded` or a framing/transport failure.
pub fn gate_request(
    listener: UnixListener,
    backend: PathBuf,
    transition: Transition,
) -> (RequestControl, RequestProducer) {
    start_gate(listener, backend, transition, None)
}

/// Hold an actual complete backend response before original client delivery.
///
/// Backend success is acceptance evidence for the API-wait boundary, not proof
/// that a VMM command is internally unfinished or that saving/reuse is safe.
pub fn gate_request_with_response_control(
    listener: UnixListener,
    backend: PathBuf,
    transition: Transition,
) -> (RequestControl, ResponseControl, RequestProducer) {
    let (arrived_tx, arrived) = oneshot::channel();
    let (release, release_rx) = oneshot::channel();
    let (request, producer) = start_gate(
        listener,
        backend,
        transition,
        Some(response::PendingResponse {
            arrived: arrived_tx,
            release: release_rx,
        }),
    );
    (request, ResponseControl { arrived, release }, producer)
}

fn start_gate(
    listener: UnixListener,
    backend: PathBuf,
    transition: Transition,
    response: Option<response::PendingResponse>,
) -> (RequestControl, RequestProducer) {
    let (arrival_tx, arrived) = oneshot::channel();
    let (release, release_rx) = oneshot::channel();
    let task = tokio::spawn(run_gate(
        listener, backend, transition, arrival_tx, release_rx, response,
    ));
    (
        RequestControl { arrived, release },
        RequestProducer { task: Some(task) },
    )
}

async fn run_gate(
    listener: UnixListener,
    backend: PathBuf,
    transition: Transition,
    arrival: oneshot::Sender<CapturedRequest>,
    mut release: oneshot::Receiver<()>,
    response_control: Option<response::PendingResponse>,
) -> Result<RequestOutcome, RequestFailure> {
    let capture = async {
        let (mut client, _) = listener.accept().await.map_err(capture_failure)?;
        let raw = framing::read_frame(&mut client, false)
            .await
            .map_err(capture_failure)?;
        framing::validate_request(&raw, transition).map_err(capture_failure)?;
        Ok::<_, RequestFailure>((client, CapturedRequest { transition, raw }))
    };
    tokio::pin!(capture);
    let (mut client, request, already_released) = tokio::select! {
        result = &mut capture => {
            let (client, request) = result?;
            (client, request, false)
        }
        result = &mut release => {
            if result.is_err() {
                return Ok(RequestOutcome::NotForwarded(None));
            }
            let (client, request) = capture.await?;
            (client, request, true)
        }
    };
    // Arrival observation owns no part of the accepted producer.
    let _ = arrival.send(request.clone());
    if !already_released && (&mut release).await.is_err() {
        return Ok(RequestOutcome::NotForwarded(Some(request)));
    }
    let failure = |stage, error| RequestFailure {
        stage,
        request: Some(request.clone()),
        error,
    };
    let mut upstream = UnixStream::connect(backend)
        .await
        .map_err(|error| failure(FailureStage::Connect, error))?;
    upstream
        .write_all(&request.raw)
        .await
        .map_err(|error| failure(FailureStage::BackendWrite, error))?;
    // Client/controller loss cannot interrupt the accepted backend drain.
    let response = framing::read_frame(&mut upstream, true)
        .await
        .map_err(|error| failure(FailureStage::BackendResponse, error))?;
    let status = framing::response_status(&response)
        .map_err(|error| failure(FailureStage::BackendResponse, error))?;
    let disposition = match response_control {
        Some(control) => {
            control
                .hold(BackendResponse {
                    request: request.clone(),
                    status,
                    raw: response.clone(),
                })
                .await
        }
        None => ResponseDisposition::Deliver,
    };
    let delivery = async {
        client.write_all(&response).await?;
        client.shutdown().await
    }
    .await;
    if disposition == ResponseDisposition::UnwindAfterDelivery && delivery.is_ok() {
        std::panic::resume_unwind(Box::new(
            "owned request producer unwound after real delivery",
        ));
    }
    Ok(RequestOutcome::ResponseDrained {
        request,
        status,
        response,
        delivery,
    })
}

fn capture_failure(error: io::Error) -> RequestFailure {
    RequestFailure {
        stage: FailureStage::Capture,
        request: None,
        error,
    }
}
