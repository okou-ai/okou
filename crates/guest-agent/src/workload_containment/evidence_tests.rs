use super::*;
use guest_contracts::oom_evidence::{
    CaptureReason, EVIDENCE_IO_TIMEOUT, MAX_EVIDENCE_BYTES, MAX_INCIDENTS, MAX_KERNEL_EVENTS,
    OomEvidence,
};
use std::future::Future;
use std::pin::Pin;
use std::time::Duration;
use tokio::net::UnixStream as AsyncUnixStream;

fn containment_pair() -> (WorkloadContainment, UnixStream) {
    let (client, peer) = UnixStream::pair().unwrap();
    // Only bootstrap/cgroup setup is synthetic; captures use the production API
    // and real socket framing, ownership, deadlines, and cancellation.
    let containment = WorkloadContainment {
        placement: Arc::new(tempfile::tempfile().unwrap().into()),
        workload_path: Arc::new(PathBuf::from("/unused")),
        tool_placement_endpoint: Arc::from("test-tool-endpoint"),
        evidence_stream: Arc::new(Mutex::new(Some(EvidenceStream::Bootstrap(client)))),
    };
    (containment, peer)
}

fn async_peer(peer: UnixStream) -> AsyncUnixStream {
    peer.set_nonblocking(true).unwrap();
    AsyncUnixStream::from_std(peer).unwrap()
}

fn fixture() -> OomEvidence {
    serde_json::from_str(include_str!(
        "../../../guest-contracts/tests/fixtures/oom-evidence-v1.json"
    ))
    .unwrap()
}

fn frame(bytes: &[u8]) -> Vec<u8> {
    let mut frame = (bytes.len() as u32).to_be_bytes().to_vec();
    frame.extend_from_slice(bytes);
    frame
}

// Blocking work inhibits Tokio's paused-clock auto-advance while the runtime
// waits for real I/O. Use a wall-clock watchdog, not a scheduler-turn budget.
async fn ready_io<F: Future>(future: F) -> F::Output {
    let (release, wait) = std::sync::mpsc::channel::<()>();
    let mut watchdog = tokio::task::spawn_blocking(move || {
        let _ = wait.recv_timeout(Duration::from_secs(5));
    });
    let result = tokio::select! {
        result = future => result,
        _ = &mut watchdog => panic!("expected I/O did not complete within the wall-clock watchdog"),
    };
    // Dropping the sender also releases the blocking task on cancellation or
    // panic. Join it on success before allowing the test to advance time again.
    drop(release);
    watchdog.await.unwrap();
    result
}

async fn expect_request<F: Future>(capture: Pin<&mut F>, peer: &mut AsyncUnixStream, request: u8) {
    ready_io(async {
        tokio::select! {
            _ = capture => panic!("capture finished before the peer could respond"),
            received = peer.read_u8() => assert_eq!(received.unwrap(), request),
        }
    })
    .await;
}

async fn expect_disconnect(peer: &mut AsyncUnixStream) {
    // The paused clock can expire a timeout before Tokio observes the close.
    // Use the same bounded I/O readiness wait as the request and response checks.
    let result = ready_io(peer.read(&mut [0])).await;
    assert!(
        matches!(result, Ok(0))
            || matches!(result, Err(error) if error.kind() == io::ErrorKind::ConnectionReset)
    );
}

#[test]
fn evidence_registers_after_bootstrap_and_keeps_async_progress() {
    let (containment, peer) = containment_pair();
    // Production receives the authenticated bootstrap before runtime creation.
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .start_paused(true)
        .build()
        .unwrap();
    runtime.block_on(async {
        let mut peer = async_peer(peer);
        let evidence = fixture();
        let response = frame(&serde_json::to_vec(&evidence).unwrap());
        for (reason, request) in [(CaptureReason::Sample, 1), (CaptureReason::CliError, 2)] {
            let mut capture = Box::pin(containment.oom_evidence(reason));
            expect_request(capture.as_mut(), &mut peer, request).await;

            // The response stays unavailable until an unrelated async timer runs
            // on the sole worker. No wall-clock performance threshold is involved.
            tokio::select! {
                _ = capture.as_mut() => panic!("evidence completed while the response was held"),
                _ = tokio::time::sleep(Duration::from_millis(20)) => {}
            }
            assert!(
                containment
                    .clone()
                    .oom_evidence(CaptureReason::Sample)
                    .await
                    .is_none()
            );
            assert_eq!(
                peer.try_read(&mut [0]).unwrap_err().kind(),
                io::ErrorKind::WouldBlock
            );

            ready_io(peer.write_all(&response)).await.unwrap();
            assert_eq!(ready_io(capture).await, Some(evidence.clone()));
        }
    });
}

#[tokio::test(start_paused = true)]
async fn evidence_silent_peer_times_out_and_permanently_closes() {
    let (containment, peer) = containment_pair();
    let mut peer = async_peer(peer);
    let mut capture = Box::pin(containment.oom_evidence(CaptureReason::Sample));
    expect_request(capture.as_mut(), &mut peer, 1).await;
    let started = tokio::time::Instant::now();
    assert!(capture.await.is_none());
    assert_eq!(started.elapsed(), EVIDENCE_IO_TIMEOUT);
    expect_disconnect(&mut peer).await;
    assert!(
        containment
            .oom_evidence(CaptureReason::CliError)
            .await
            .is_none()
    );
}

#[tokio::test(start_paused = true)]
async fn evidence_request_write_has_a_bounded_deadline() {
    let (containment, peer) = containment_pair();
    {
        let mut owner = containment.evidence_stream.try_lock().unwrap();
        let Some(EvidenceStream::Bootstrap(stream)) = owner.as_mut() else {
            panic!("fixture must hold an unregistered bootstrap stream");
        };
        stream.set_nonblocking(true).unwrap();
        // Fill the real socket before capture so even its one-byte request waits.
        loop {
            match std::io::Write::write(stream, b"x") {
                Ok(1) => {}
                Err(error) if error.kind() == io::ErrorKind::WouldBlock => break,
                result => panic!("unexpected socket fill result: {result:?}"),
            }
        }
        stream.set_nonblocking(false).unwrap();
    }
    let started = tokio::time::Instant::now();
    assert!(
        containment
            .oom_evidence(CaptureReason::Sample)
            .await
            .is_none()
    );
    assert_eq!(started.elapsed(), EVIDENCE_IO_TIMEOUT);
    assert!(
        containment
            .oom_evidence(CaptureReason::CliError)
            .await
            .is_none()
    );
    let mut peer = async_peer(peer);
    let mut received = Vec::new();
    peer.read_to_end(&mut received).await.unwrap();
    assert!(!received.is_empty());
    assert!(received.iter().all(|byte| *byte == b'x'));
}

#[tokio::test(start_paused = true)]
async fn evidence_header_and_body_share_one_deadline() {
    let (containment, peer) = containment_pair();
    let mut peer = async_peer(peer);
    let mut capture = Box::pin(containment.oom_evidence(CaptureReason::Sample));
    expect_request(capture.as_mut(), &mut peer, 1).await;
    let started = tokio::time::Instant::now();
    tokio::select! {
        _ = capture.as_mut() => panic!("capture ended before its deadline"),
        _ = tokio::time::sleep(EVIDENCE_IO_TIMEOUT / 2) => {}
    }
    ready_io(peer.write_all(&10u32.to_be_bytes()))
        .await
        .unwrap();
    ready_io(peer.write_all(b"{")).await.unwrap();
    assert!(capture.await.is_none());
    assert_eq!(started.elapsed(), EVIDENCE_IO_TIMEOUT);
    expect_disconnect(&mut peer).await;
}

#[tokio::test(start_paused = true)]
async fn evidence_cancellation_closes_silent_and_partial_responses() {
    for partial in [Vec::new(), vec![0], vec![0, 0, 0, 10, b'{']] {
        let (containment, peer) = containment_pair();
        let mut peer = async_peer(peer);
        let mut capture = Box::pin(containment.oom_evidence(CaptureReason::CliError));
        expect_request(capture.as_mut(), &mut peer, 2).await;
        ready_io(peer.write_all(&partial)).await.unwrap();
        tokio::select! {
            _ = capture.as_mut() => panic!("partial response unexpectedly completed"),
            _ = tokio::time::sleep(Duration::from_millis(1)) => {}
        }
        drop(capture);
        expect_disconnect(&mut peer).await;
        assert!(
            containment
                .oom_evidence(CaptureReason::Sample)
                .await
                .is_none()
        );
    }
}

#[tokio::test(start_paused = true)]
async fn evidence_rejects_invalid_frames_and_closes_the_connection() {
    let mut too_many_incidents = fixture();
    too_many_incidents.incidents = vec![too_many_incidents.incidents[0].clone(); MAX_INCIDENTS + 1];
    let mut too_many_events = fixture();
    too_many_events.incidents[0].kernel_events =
        vec![too_many_events.incidents[0].kernel_events[0].clone(); MAX_KERNEL_EVENTS + 1];
    for response in [
        ((MAX_EVIDENCE_BYTES + 1) as u32).to_be_bytes().to_vec(),
        frame(b"invalid json"),
        frame(&serde_json::to_vec(&too_many_incidents).unwrap()),
        frame(&serde_json::to_vec(&too_many_events).unwrap()),
    ] {
        let (containment, peer) = containment_pair();
        let mut peer = async_peer(peer);
        let mut capture = Box::pin(containment.oom_evidence(CaptureReason::Sample));
        expect_request(capture.as_mut(), &mut peer, 1).await;
        ready_io(peer.write_all(&response)).await.unwrap();
        assert!(ready_io(capture).await.is_none());
        expect_disconnect(&mut peer).await;
        assert!(
            containment
                .oom_evidence(CaptureReason::Sample)
                .await
                .is_none()
        );
    }
}

#[tokio::test(start_paused = true)]
async fn evidence_accepts_a_response_after_peer_scheduling_delay() {
    let (containment, peer) = containment_pair();
    let mut peer = async_peer(peer);
    let evidence = fixture();
    let response = frame(&serde_json::to_vec(&evidence).unwrap());
    let started = tokio::time::Instant::now();
    let (captured, ()) = ready_io(async {
        tokio::join!(containment.oom_evidence(CaptureReason::Sample), async {
            assert_eq!(peer.read_u8().await.unwrap(), 1);
            // A peer can have runnable work before its response is available.
            // Scheduler turns are not elapsed protocol time or an I/O deadline.
            for _ in 0..2_000 {
                tokio::task::yield_now().await;
            }
            peer.write_all(&response).await.unwrap();
        })
    })
    .await;
    assert_eq!(captured, Some(evidence));
    assert_eq!(started.elapsed(), Duration::ZERO);
}

#[tokio::test(start_paused = true)]
async fn evidence_accepts_a_fragmented_response_within_the_deadline() {
    let (containment, peer) = containment_pair();
    let mut peer = async_peer(peer);
    let evidence = fixture();
    let mut capture = Box::pin(containment.oom_evidence(CaptureReason::Sample));
    expect_request(capture.as_mut(), &mut peer, 1).await;
    let response = frame(&serde_json::to_vec(&evidence).unwrap());
    let mut chunks = response.chunks(512).peekable();
    while let Some(chunk) = chunks.next() {
        ready_io(peer.write_all(chunk)).await.unwrap();
        if chunks.peek().is_some() {
            tokio::select! {
                _ = capture.as_mut() => panic!("fragmented response completed before its last chunk"),
                _ = tokio::time::sleep(Duration::from_millis(1)) => {}
            }
        }
    }
    assert_eq!(ready_io(capture).await, Some(evidence));
}

#[tokio::test(start_paused = true)]
async fn metrics_records_evidence_and_cancels_an_outstanding_capture() {
    let (containment, peer) = containment_pair();
    let mut peer = async_peer(peer);
    let temp = tempfile::tempdir().unwrap();
    let paths = crate::paths::GuestPaths::from_runtime_dir(temp.path().join("runtime"));
    let telemetry = crate::telemetry::Telemetry::spawn_for_paths(
        "evidence-metrics".into(),
        &paths,
        Arc::new(crate::masker::SecretMasker::from_raw("")),
        crate::http::HttpClient::new().unwrap(),
    );
    let sources = crate::metrics::MetricsSources::new(PathBuf::from("/proc/stat"), None)
        .with_evidence(containment.clone(), telemetry.incident_reporter());
    let shutdown = tokio_util::sync::CancellationToken::new();
    let mut metrics = Box::pin(crate::metrics::metrics_loop_for_path(
        shutdown.clone(),
        paths.metrics_log_file().into(),
        sources,
    ));
    expect_request(metrics.as_mut(), &mut peer, 1).await;
    let evidence = fixture();
    ready_io(peer.write_all(&frame(&serde_json::to_vec(&evidence).unwrap())))
        .await
        .unwrap();
    // Observe the completed JSONL append before advancing to the next tick.
    ready_io(async {
        tokio::select! {
            _ = metrics.as_mut() => panic!("metrics stopped before shutdown"),
            _ = async {
                while !Path::new(paths.metrics_log_file()).exists() {
                    tokio::task::yield_now().await;
                }
            } => {}
        }
    })
    .await;
    tokio::time::advance(Duration::from_secs(5)).await;
    expect_request(metrics.as_mut(), &mut peer, 1).await;
    let contents = fs::read_to_string(paths.metrics_log_file()).unwrap();
    let entries: Vec<serde_json::Value> = contents
        .lines()
        .map(|line| serde_json::from_str(line).unwrap())
        .collect();
    assert_eq!(entries.len(), 1);
    let mut snapshot = evidence.clone();
    snapshot.incidents.clear();
    assert_eq!(
        entries[0]["memory"],
        serde_json::to_value(snapshot).unwrap()
    );

    let cancelled_at = tokio::time::Instant::now();
    shutdown.cancel();
    metrics.await;
    assert_eq!(cancelled_at.elapsed(), Duration::ZERO);
    expect_disconnect(&mut peer).await;
    assert!(
        containment
            .oom_evidence(CaptureReason::CliError)
            .await
            .is_none()
    );
    telemetry.shutdown().await;
    let retained =
        fs::read_to_string(format!("{}.oom-evidence.json", paths.metrics_log_file())).unwrap();
    assert_eq!(
        serde_json::from_str::<OomEvidence>(&retained).unwrap(),
        evidence
    );
    assert_eq!(
        fs::read_to_string(paths.metrics_log_file()).unwrap(),
        contents
    );
}
