use super::*;

async fn coordinated_park(
    coordinator: &ParkCoordinator,
    is_parked: &mut bool,
    api_sock: &Path,
    handoff: Option<&SandboxFinalExecParkHandoff>,
    state_rx: watch::Receiver<SandboxState>,
) -> sandbox::Result<(TestNormalOperationFence, PhysicalParkOutcome, ())> {
    super::super::park_with_ready_for_park_and_preparation_with_observer(
        "running-handoff-test",
        coordinator,
        None,
        |outcome| matches!(outcome, PhysicalParkOutcome::Handoff(_)),
        || async { Ok((TestNormalOperationFence, ())) },
        || async { Ok(()) },
        |timing, events| async move {
            let (events, result) = park_inner_with_guest_and_handoff(
                is_parked,
                2048,
                api_sock,
                "running-handoff-test",
                PhysicalParkRequest {
                    guest: Arc::new(tokio::sync::Mutex::new(None)),
                    handoff,
                    memory_policy: ParkMemoryPolicy::Reclaim,
                    state_rx,
                },
                events,
            )
            .await;
            (timing, events, result)
        },
    )
    .await
}

#[tokio::test]
async fn running_handoff_waits_for_in_flight_target_write_before_transfer() {
    for gated_amount in [1024, 0] {
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let target = Arc::new(AtomicU32::new(0));
        let handler_entered = Arc::clone(&entered);
        let handler_release = Arc::clone(&release);
        let mut api = MockFirecrackerApi::with_handler(move |request| {
            let entered = Arc::clone(&handler_entered);
            let release = Arc::clone(&handler_release);
            let target = Arc::clone(&target);
            async move {
                if request.method == "PATCH" && request.path == "/balloon" {
                    let amount = mock_request_body_json(&request)["amount_mib"]
                        .as_u64()
                        .unwrap();
                    if amount == gated_amount {
                        entered.notify_one();
                        release.notified().await;
                    }
                    target.store(u32::try_from(amount).unwrap(), Ordering::Relaxed);
                    MockResponse::no_content()
                } else if request.method == "GET" && request.path == "/balloon/statistics" {
                    let target = target.load(Ordering::Relaxed);
                    MockResponse::ok_body(MockBalloonStats::new(target, target).to_json())
                } else {
                    panic!("running handoff must never pause or resume: {request:?}");
                }
            }
        });
        let coordinator = ParkCoordinator::new();
        let (_state_tx, state_rx) = watch::channel(SandboxState::Running);
        let handoff = SandboxFinalExecParkHandoff::new();
        let mut is_parked = false;
        let (_, outcome, ()) = {
            let park = coordinated_park(
                &coordinator,
                &mut is_parked,
                api.socket_path(),
                Some(&handoff),
                state_rx,
            );
            tokio::pin!(park);
            tokio::select! {
                () = entered.notified() => {}
                _ = &mut park => panic!("park completed before target write was acknowledged"),
            }
            assert!(handoff.request());
            assert!(
                std::future::poll_fn(|cx| { std::task::Poll::Ready(park.as_mut().poll(cx)) })
                    .await
                    .is_pending()
            );
            assert!(matches!(
                coordinator.state(),
                CoordinatorState::ReadyForPark { .. }
            ));
            release.notify_one();
            park.await.unwrap()
        };
        assert!(matches!(outcome, PhysicalParkOutcome::Handoff(_)));
        assert_eq!(coordinator.state(), CoordinatorState::RunningHandoff);
        assert!(!is_parked);
        let requests = api.drain_requests();
        let writes = patches(&requests);
        assert_eq!(writes.len(), 2);
        assert_eq!(mock_request_body_json(writes[0])["amount_mib"], 1024);
        assert_eq!(mock_request_body_json(writes[1])["amount_mib"], 0);
    }
}

#[tokio::test]
async fn public_running_handoff_activation_keeps_guest_fenced_until_zero_and_resume_ack() {
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let mut api = MockLifecycleApi::with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([
            MockBalloonStatsReply::GatedOk {
                entered: Arc::clone(&entered),
                release: Arc::clone(&release),
                stats: MockBalloonStats::new(0, 512),
            },
            MockBalloonStatsReply::Ok(MockBalloonStats::new(0, 0)),
        ]),
    );
    let dir = tempfile::tempdir().unwrap();
    let (guest, mut guest_stream) = connected_mock_guest().await;
    let host = guest.lock().await.as_ref().unwrap().clone();
    let mut sandbox = test_sandbox_with_state(SandboxState::Running);
    sandbox.config.resources.memory_mb = 2048;
    sandbox.sock_paths = SockPaths::new(dir.path().to_path_buf());
    std::fs::create_dir(sandbox.sock_paths.vsock_dir()).unwrap();
    std::os::unix::fs::symlink(api.socket_path(), sandbox.sock_paths.api_sock()).unwrap();
    sandbox.guest = guest;
    sandbox.park_fence = Some(host.try_fence_normal_operations().unwrap());
    let coordinator = sandbox.park_coordinator.clone();
    let attempt = coordinator.begin_prepare_park().unwrap();
    coordinator
        .complete_prepare_park(&attempt, PrepareParkEvidence::AgentQuiesced)
        .unwrap();
    coordinator.mark_running_handoff(&attempt).unwrap();
    sandbox.bind_run_control("successor").unwrap();
    let activation = tokio::spawn(async move {
        sandbox.unpark().await.unwrap();
        sandbox
    });
    entered.notified().await;
    assert!(!activation.is_finished());
    assert_eq!(coordinator.state(), CoordinatorState::RunningHandoff);
    assert!(coordinator.ensure_operation_start_allowed().is_err());
    assert!(matches!(
        host.try_fence_normal_operations(),
        Err(NormalOperationFenceRejection::AlreadyFenced)
    ));
    let mut buffer = [0; HEADER_SIZE];
    assert_eq!(
        guest_stream.try_read(&mut buffer).unwrap_err().kind(),
        io::ErrorKind::WouldBlock,
        "Guest resume must wait for exact-zero balloon convergence"
    );
    release.notify_one();

    let resume = read_vsock_message(&mut guest_stream).await;
    assert_eq!(resume.msg_type, guest_control_proto::MSG_RESUME_OPERATIONS);
    assert!(coordinator.ensure_operation_start_allowed().is_err());
    assert!(matches!(
        host.try_fence_normal_operations(),
        Err(NormalOperationFenceRejection::AlreadyFenced)
    ));
    let response =
        guest_control_proto::encode(guest_control_proto::MSG_OPERATIONS_RESUMED, resume.seq, &[])
            .unwrap();
    guest_stream.write_all(&response).await.unwrap();
    let mut sandbox = activation.await.unwrap();
    assert!(!sandbox.is_parked);
    assert!(sandbox.park_fence.is_none());
    assert_eq!(coordinator.state(), CoordinatorState::Open);
    coordinator.ensure_operation_start_allowed().unwrap();
    drop(host.try_fence_normal_operations().unwrap());

    // Repeating the public Open entrypoint performs no new lifecycle I/O.
    sandbox.unpark().await.unwrap();
    let requests = api.drain_requests();
    let writes = patches(&requests);
    assert_eq!(writes.len(), 1);
    assert_eq!(writes[0].path, "/balloon");
    assert_eq!(mock_request_body_json(writes[0])["amount_mib"], 0);
    assert_eq!(
        requests
            .iter()
            .filter(|request| request.method == "GET")
            .count(),
        2
    );
    assert_eq!(
        guest_stream.try_read(&mut buffer).unwrap_err().kind(),
        io::ErrorKind::WouldBlock
    );
}

#[tokio::test]
async fn failed_target_reversal_cannot_publish_idle_or_running_handoff() {
    for requested_before_park in [false, true] {
        let statuses = if requested_before_park {
            vec![500]
        } else {
            vec![204, 500]
        };
        let mut api = MockLifecycleApi::new(statuses.into(), None);
        let coordinator = ParkCoordinator::new();
        let (_state_tx, state_rx) = watch::channel(SandboxState::Running);
        let handoff = SandboxFinalExecParkHandoff::new();
        if requested_before_park {
            assert!(handoff.request());
        }
        let mut is_parked = false;
        let result = coordinated_park(
            &coordinator,
            &mut is_parked,
            api.socket_path(),
            Some(&handoff),
            state_rx,
        )
        .await;
        assert_idle_transition_message(
            result.map(drop),
            SandboxIdleTransition::Park,
            "balloon deflate before park: HTTP 500: test",
        );
        assert!(!is_parked);
        assert!(matches!(
            coordinator.state(),
            CoordinatorState::Dirty { .. }
        ));
        let requests = api.drain_requests();
        let writes = patches(&requests);
        assert_eq!(writes.len(), if requested_before_park { 1 } else { 2 });
        assert!(writes.iter().all(|request| request.path == "/balloon"));
        assert_eq!(
            mock_request_body_json(writes.last().unwrap())["amount_mib"],
            0
        );
    }
}

#[tokio::test]
async fn ordinary_park_waits_for_deflation_before_pausing() {
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let mut api = MockLifecycleApi::with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([
            MockBalloonStatsReply::Ok(MockBalloonStats::new(1024, 1024)),
            MockBalloonStatsReply::GatedOk {
                entered: Arc::clone(&entered),
                release: Arc::clone(&release),
                stats: MockBalloonStats::new(0, 0),
            },
        ]),
    );
    let socket_path = api.socket_path().to_path_buf();
    let coordinator = ParkCoordinator::new();
    let park_coordinator = coordinator.clone();
    let (_state_tx, state_rx) = watch::channel(SandboxState::Running);
    let park = tokio::spawn(async move {
        let mut is_parked = false;
        let result = coordinated_park(
            &park_coordinator,
            &mut is_parked,
            &socket_path,
            None,
            state_rx,
        )
        .await;
        (result, is_parked)
    });
    entered.notified().await;
    assert!(!park.is_finished());
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::ReadyForPark { .. }
    ));
    let mut requests = api.drain_requests();
    assert_eq!(patches(&requests).len(), 2);
    assert!(requests.iter().all(|request| request.path != "/vm"));
    release.notify_one();
    let (result, is_parked) = park.await.unwrap();
    assert!(matches!(
        result.unwrap().1,
        PhysicalParkOutcome::Idle(SandboxParkOutcome::Reusable)
    ));
    assert!(is_parked);
    assert_eq!(coordinator.state(), CoordinatorState::Parked);
    requests.extend(api.drain_requests());
    let writes = patches(&requests);
    assert_eq!(writes.len(), 3);
    assert_eq!(writes[2].path, "/vm");
    assert_eq!(mock_request_body_json(writes[2])["state"], "Paused");
}

#[tokio::test]
async fn failed_deflation_statistics_prevent_idle_admission_after_successful_reclaim() {
    let mut api = MockLifecycleApi::with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([
            MockBalloonStatsReply::Ok(MockBalloonStats::new(1024, 1024)),
            MockBalloonStatsReply::Status(500),
        ]),
    );
    let coordinator = ParkCoordinator::new();
    let (_state_tx, state_rx) = watch::channel(SandboxState::Running);
    let mut is_parked = false;
    let result = coordinated_park(
        &coordinator,
        &mut is_parked,
        api.socket_path(),
        None,
        state_rx,
    )
    .await;
    assert_idle_transition_message(
        result.map(drop),
        SandboxIdleTransition::Park,
        "balloon deflation statistics: HTTP 500: test",
    );
    assert!(!is_parked);
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
    let requests = api.drain_requests();
    assert_eq!(patches(&requests).len(), 2);
    assert!(requests.iter().all(|request| request.path != "/vm"));
}

#[tokio::test]
async fn cancellation_during_park_deflation_marks_dirty_without_pausing() {
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let mut api = MockLifecycleApi::with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([
            MockBalloonStatsReply::Ok(MockBalloonStats::new(1024, 1024)),
            MockBalloonStatsReply::GatedOk {
                entered: Arc::clone(&entered),
                release: Arc::clone(&release),
                stats: MockBalloonStats::new(0, 512),
            },
        ]),
    );
    let coordinator = ParkCoordinator::new();
    let (_state_tx, state_rx) = watch::channel(SandboxState::Running);
    let mut is_parked = false;
    {
        let park = coordinated_park(
            &coordinator,
            &mut is_parked,
            api.socket_path(),
            None,
            state_rx,
        );
        tokio::pin!(park);
        tokio::select! {
            () = entered.notified() => {}
            _ = &mut park => panic!("park completed before cancellation"),
        }
    }
    release.notify_one();
    assert!(!is_parked);
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
    let requests = api.drain_requests();
    assert_eq!(patches(&requests).len(), 2);
    assert!(requests.iter().all(|request| request.path != "/vm"));
}

#[tokio::test]
async fn park_deflation_deadline_rejects_stalled_statistics_without_pausing() {
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let mut api = MockLifecycleApi::with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([
            MockBalloonStatsReply::Ok(MockBalloonStats::new(1024, 1024)),
            MockBalloonStatsReply::GatedOk {
                entered: Arc::clone(&entered),
                release: Arc::clone(&release),
                stats: MockBalloonStats::new(0, 512),
            },
            MockBalloonStatsReply::GatedOk {
                entered: Arc::clone(&entered),
                release: Arc::clone(&release),
                stats: MockBalloonStats::new(0, 512),
            },
        ]),
    );
    let coordinator = ParkCoordinator::new();
    let (_state_tx, state_rx) = watch::channel(SandboxState::Running);
    let mut is_parked = false;
    let result = {
        let park = coordinated_park(
            &coordinator,
            &mut is_parked,
            api.socket_path(),
            None,
            state_rx,
        );
        tokio::pin!(park);
        tokio::select! {
            () = entered.notified() => {}
            _ = &mut park => panic!("park completed before deflation deadline"),
        }
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(5)).await;
        assert!(
            std::future::poll_fn(|cx| std::task::Poll::Ready(park.as_mut().poll(cx)))
                .await
                .is_pending(),
            "background park must outlive the foreground deflation deadline"
        );
        // Allow one nonzero sample, then stall the next GET. The overall park
        // deadline must expire before that later request's own 30-second limit.
        tokio::time::resume();
        release.notify_one();
        tokio::select! {
            () = entered.notified() => {}
            _ = &mut park => panic!("park completed while balloon pages were still held"),
        }
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(25)).await;
        let result = park.await;
        tokio::time::resume();
        result
    };
    release.notify_one();
    assert_idle_transition_message(
        result.map(drop),
        SandboxIdleTransition::Park,
        "balloon deflation did not complete within 30 seconds",
    );
    assert!(!is_parked);
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
    assert!(
        api.drain_requests()
            .iter()
            .all(|request| request.path != "/vm")
    );
}

#[tokio::test]
async fn exact_handoff_interrupts_deflation_after_foreground_deadline_without_pausing() {
    let (_state_tx, state_rx) = watch::channel(SandboxState::Running);
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let mut api = MockLifecycleApi::with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([
            MockBalloonStatsReply::Ok(MockBalloonStats::new(1024, 1024)),
            MockBalloonStatsReply::GatedOk {
                entered: Arc::clone(&entered),
                release: Arc::clone(&release),
                stats: MockBalloonStats::new(0, 512),
            },
        ]),
    );
    let handoff = SandboxFinalExecParkHandoff::new();
    let mut is_parked = false;
    let mut observer = RecordingFinalExecParkObserver::default();
    let outcome = {
        let park = park_inner_with_guest_and_handoff(
            &mut is_parked,
            2048,
            api.socket_path(),
            "handoff-during-deflation",
            PhysicalParkRequest {
                guest: Arc::new(tokio::sync::Mutex::new(None)),
                handoff: Some(&handoff),
                memory_policy: ParkMemoryPolicy::Reclaim,
                state_rx,
            },
            SandboxFinalExecParkSubstageEvents::new(Some(&mut observer)),
        );
        tokio::pin!(park);
        tokio::select! {
            () = entered.notified() => {}
            _ = &mut park => panic!("park completed before deflation was interrupted"),
        }
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(6)).await;
        assert!(
            std::future::poll_fn(|cx| std::task::Poll::Ready(park.as_mut().poll(cx)))
                .await
                .is_pending(),
            "slow background deflation must remain available for takeover"
        );
        assert!(handoff.request());
        let (_, result) = tokio::time::timeout(Duration::from_secs(1), park)
            .await
            .expect("running handoff must interrupt the pending statistics GET");
        tokio::time::resume();
        result.unwrap()
    };
    release.notify_one();
    assert!(matches!(
        outcome,
        PhysicalParkOutcome::Handoff(SandboxFinalExecParkHandoffPoint::DuringDeflation)
    ));
    assert!(!is_parked);
    assert!(observer.substage_records.contains(&(
        SandboxFinalExecParkSubstage::BalloonDeflate,
        true,
        Some(SandboxFinalExecParkSubstageOutcome::HandoffRequested),
    )));
    let requests = api.drain_requests();
    let writes = patches(&requests);
    assert_eq!(writes.len(), 2);
    assert_eq!(mock_request_body_json(writes[0])["amount_mib"], 1024);
    assert_eq!(mock_request_body_json(writes[1])["amount_mib"], 0);
    assert!(writes.iter().all(|request| request.path == "/balloon"));
}

#[tokio::test]
async fn park_can_finish_deflation_after_foreground_deadline() {
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let mut api = MockLifecycleApi::with_stats(
        std::collections::VecDeque::new(),
        std::collections::VecDeque::from([
            MockBalloonStatsReply::Ok(MockBalloonStats::new(1024, 1024)),
            MockBalloonStatsReply::GatedOk {
                entered: Arc::clone(&entered),
                release: Arc::clone(&release),
                stats: MockBalloonStats::new(0, 0),
            },
        ]),
    );
    let coordinator = ParkCoordinator::new();
    let (_state_tx, state_rx) = watch::channel(SandboxState::Running);
    let mut is_parked = false;
    let (_, outcome, ()) = {
        let park = coordinated_park(
            &coordinator,
            &mut is_parked,
            api.socket_path(),
            None,
            state_rx,
        );
        tokio::pin!(park);
        tokio::select! {
            () = entered.notified() => {}
            _ = &mut park => panic!("park completed before the deflation response"),
        }
        tokio::time::pause();
        tokio::time::advance(Duration::from_secs(6)).await;
        assert!(
            std::future::poll_fn(|cx| std::task::Poll::Ready(park.as_mut().poll(cx)))
                .await
                .is_pending()
        );
        tokio::time::resume();
        release.notify_one();
        park.await.unwrap()
    };
    assert!(matches!(
        outcome,
        PhysicalParkOutcome::Idle(SandboxParkOutcome::Reusable)
    ));
    assert!(is_parked);
    assert_eq!(coordinator.state(), CoordinatorState::Parked);
    let requests = api.drain_requests();
    let pause = requests.last().unwrap();
    assert_eq!(pause.method, "PATCH");
    assert_eq!(pause.path, "/vm");
    assert_eq!(mock_request_body_json(pause)["state"], "Paused");
}
