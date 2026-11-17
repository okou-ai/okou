use super::*;
use std::sync::atomic::AtomicBool;
#[tokio::test]
async fn local_drain_failed_target_reversal_retains_dirty_cleanup_ownership() {
    let gate = LocalAdmission::open();
    gate.close();
    let coordinator = ParkCoordinator::new();
    let mut api = MockLifecycleApi::new([500].into(), None);
    let mut is_parked = false;
    let result = coordinated_local_park(
        &coordinator,
        &mut is_parked,
        api.socket_path(),
        Some(&gate),
        None,
    )
    .await;
    assert!(result.is_err());
    assert!(!is_parked);
    assert!(matches!(
        coordinator.state(),
        CoordinatorState::Dirty { .. }
    ));
    assert!(coordinator.ensure_operation_start_allowed().is_err());
    assert_eq!(api.drain_requests().len(), 1);
}

pub(super) struct LocalAdmission(AtomicBool);

impl LocalAdmission {
    pub(super) fn open() -> Self {
        Self(AtomicBool::new(true))
    }

    pub(super) fn close(&self) {
        self.0.store(false, Ordering::SeqCst);
    }
}

impl sandbox::SandboxIdleAdmission for LocalAdmission {
    fn is_open(&self) -> bool {
        self.0.load(Ordering::SeqCst)
    }
}

async fn coordinated_local_park(
    coordinator: &ParkCoordinator,
    is_parked: &mut bool,
    api_sock: &Path,
    admission: Option<&LocalAdmission>,
    handoff: Option<&SandboxFinalExecParkHandoff>,
) -> sandbox::Result<PhysicalParkOutcome> {
    let (_state_tx, state_rx) = watch::channel(SandboxState::Running);
    let (_, outcome, ()) = park_with_ready_for_park_and_preparation_with_observer(
        "local-drain-test",
        coordinator.into(),
        None,
        PhysicalParkOutcome::completion,
        || async { Ok((TestNormalOperationFence, ())) },
        || async { Ok(()) },
        |timing, events| async move {
            let (events, result) = park_inner_with_guest_and_handoff(
                is_parked,
                2048,
                api_sock,
                "local-drain-test",
                PhysicalParkRequest {
                    guest: Arc::new(tokio::sync::Mutex::new(None)),
                    handoff,
                    admission: admission.map(|gate| gate as &dyn SandboxIdleAdmission),
                    pause_custody: None,
                    memory_policy: ParkMemoryPolicy::Reclaim,
                    state_rx,
                },
                events,
            )
            .await;
            (timing, events, result)
        },
    )
    .await?;
    Ok(outcome)
}

#[tokio::test]
async fn local_drain_before_balloon_retains_terminal_owner_unless_handoff_is_accepted() {
    for successor_requested in [false, true] {
        let gate = LocalAdmission::open();
        gate.close();
        let handoff = SandboxFinalExecParkHandoff::new();
        if successor_requested {
            assert!(handoff.request());
        }
        let coordinator = ParkCoordinator::new();
        let mut api = MockLifecycleApi::new(Default::default(), None);
        let mut is_parked = false;
        let outcome = coordinated_local_park(
            &coordinator,
            &mut is_parked,
            api.socket_path(),
            Some(&gate),
            Some(&handoff),
        )
        .await
        .unwrap();
        assert_eq!(handoff.is_accepted(), successor_requested);
        if successor_requested {
            assert!(matches!(outcome, PhysicalParkOutcome::Handoff(_)));
        } else {
            assert!(matches!(outcome, PhysicalParkOutcome::Terminal));
        }
        assert!(!is_parked);
        assert_eq!(
            coordinator.state(),
            CoordinatorState::FencedRunning {
                memory_ready: !successor_requested
            }
        );
        assert!(coordinator.ensure_operation_start_allowed().is_err());
        let requests = api.drain_requests();
        assert_eq!(requests.len(), if successor_requested { 1 } else { 2 });
        assert_eq!(requests[0].path, "/balloon");
        assert_eq!(mock_request_body_json(&requests[0])["amount_mib"], 0);
    }
}

#[tokio::test]
async fn local_drain_joins_in_flight_balloon_writes_before_terminal_transfer() {
    let target_mib = 2048 - balloon::MIN_GUEST_MIB;
    for gated_amount in [target_mib, 0] {
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let target = Arc::new(AtomicU32::new(0));
        let handler_entered = entered.clone();
        let handler_release = release.clone();
        let mut api = MockFirecrackerApi::with_handler(move |request| {
            let entered = handler_entered.clone();
            let release = handler_release.clone();
            let target = target.clone();
            async move {
                if request.method == "PATCH" && request.path == "/balloon" {
                    let amount = mock_request_body_json(&request)["amount_mib"]
                        .as_u64()
                        .unwrap();
                    if amount == u64::from(gated_amount) {
                        entered.notify_one();
                        release.notified().await;
                    }
                    target.store(u32::try_from(amount).unwrap(), Ordering::Relaxed);
                    MockResponse::no_content()
                } else if request.method == "GET" && request.path == "/balloon/statistics" {
                    let target = target.load(Ordering::Relaxed);
                    MockResponse::ok_body(MockBalloonStats::new(target, target).to_json())
                } else {
                    panic!("local drain must not pause or resume: {request:?}");
                }
            }
        });
        let gate = LocalAdmission::open();
        let coordinator = ParkCoordinator::new();
        let mut is_parked = false;
        let outcome = {
            let park = coordinated_local_park(
                &coordinator,
                &mut is_parked,
                api.socket_path(),
                Some(&gate),
                None,
            );
            tokio::pin!(park);
            tokio::select! {
                () = entered.notified() => {}
                _ = &mut park => panic!("park completed before write acknowledgement"),
            }
            gate.close();
            assert!(
                std::future::poll_fn(|cx| std::task::Poll::Ready(park.as_mut().poll(cx)))
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
        assert!(matches!(outcome, PhysicalParkOutcome::Terminal));
        assert!(!is_parked);
        assert_eq!(
            coordinator.state(),
            CoordinatorState::FencedRunning { memory_ready: true }
        );
        let requests = api.drain_requests();
        let writes = patches(&requests);
        assert_eq!(writes.len(), 2);
        assert_eq!(mock_request_body_json(writes[0])["amount_mib"], target_mib);
        assert_eq!(mock_request_body_json(writes[1])["amount_mib"], 0);
    }
}

#[tokio::test]
async fn local_drain_during_settle_or_deflation_avoids_pause_after_owned_read() {
    let target = 2048 - balloon::MIN_GUEST_MIB;
    for during_deflation in [false, true] {
        let entered = Arc::new(Notify::new());
        let release = Arc::new(Notify::new());
        let mut replies = std::collections::VecDeque::new();
        if during_deflation {
            replies.push_back(MockBalloonStatsReply::Ok(MockBalloonStats::new(
                target, target,
            )));
        }
        replies.push_back(MockBalloonStatsReply::GatedOk {
            entered: entered.clone(),
            release: release.clone(),
            stats: if during_deflation {
                MockBalloonStats::new(0, 0)
            } else {
                MockBalloonStats::new(target, 0)
            },
        });
        if !during_deflation {
            replies.push_back(MockBalloonStatsReply::Ok(MockBalloonStats::new(0, 0)));
        }
        let mut api = MockLifecycleApi::with_stats(Default::default(), replies);
        let gate = LocalAdmission::open();
        let coordinator = ParkCoordinator::new();
        let mut is_parked = false;
        let outcome = {
            let park = coordinated_local_park(
                &coordinator,
                &mut is_parked,
                api.socket_path(),
                Some(&gate),
                None,
            );
            tokio::pin!(park);
            tokio::select! {
                () = entered.notified() => {}
                _ = &mut park => panic!("park completed before statistics reply"),
            }
            gate.close();
            if during_deflation {
                tokio::time::pause();
                tokio::time::advance(Duration::from_secs(6)).await;
            }
            assert!(
                std::future::poll_fn(|cx| std::task::Poll::Ready(park.as_mut().poll(cx)))
                    .await
                    .is_pending()
            );
            if during_deflation {
                tokio::time::resume();
            }
            release.notify_one();
            park.await.unwrap()
        };
        assert!(matches!(outcome, PhysicalParkOutcome::Terminal));
        assert!(!is_parked);
        assert_eq!(
            coordinator.state(),
            CoordinatorState::FencedRunning { memory_ready: true }
        );
        let requests = api.drain_requests();
        assert!(requests.iter().all(|request| request.path != "/vm"));
        assert_eq!(patches(&requests).len(), 2);
        assert_eq!(
            requests
                .iter()
                .filter(|request| request.method == "GET")
                .count(),
            2
        );
    }
}

#[tokio::test]
async fn local_drain_after_pause_submission_finishes_parked_fallback() {
    let entered = Arc::new(Notify::new());
    let release = Arc::new(Notify::new());
    let handler_entered = entered.clone();
    let handler_release = release.clone();
    let target = Arc::new(AtomicU32::new(0));
    let api = MockFirecrackerApi::with_handler(move |request| {
        let entered = handler_entered.clone();
        let release = handler_release.clone();
        let target = target.clone();
        async move {
            if request.path == "/vm" {
                assert_eq!(mock_request_body_json(&request)["state"], "Paused");
                entered.notify_one();
                release.notified().await;
                MockResponse::no_content()
            } else if request.method == "GET" {
                let target = target.load(Ordering::Relaxed);
                MockResponse::ok_body(MockBalloonStats::new(target, target).to_json())
            } else {
                let amount = mock_request_body_json(&request)["amount_mib"]
                    .as_u64()
                    .unwrap();
                target.store(u32::try_from(amount).unwrap(), Ordering::Relaxed);
                MockResponse::no_content()
            }
        }
    });
    let gate = LocalAdmission::open();
    let coordinator = ParkCoordinator::new();
    let mut is_parked = false;
    let outcome = {
        let park = coordinated_local_park(
            &coordinator,
            &mut is_parked,
            api.socket_path(),
            Some(&gate),
            None,
        );
        tokio::pin!(park);
        tokio::select! {
            () = entered.notified() => {}
            _ = &mut park => panic!("pause acknowledgement was not joined"),
        }
        gate.close();
        assert!(
            std::future::poll_fn(|cx| std::task::Poll::Ready(park.as_mut().poll(cx)))
                .await
                .is_pending()
        );
        release.notify_one();
        park.await.unwrap()
    };
    assert!(matches!(
        outcome,
        PhysicalParkOutcome::Idle(SandboxParkOutcome::Reusable)
    ));
    assert!(is_parked);
    assert_eq!(coordinator.state(), CoordinatorState::Parked);
}

#[tokio::test]
async fn open_local_admission_preserves_normal_park_request_sequence() {
    let mut sequences = Vec::new();
    for observe_admission in [false, true] {
        let gate = LocalAdmission::open();
        let handoff = SandboxFinalExecParkHandoff::new();
        let coordinator = ParkCoordinator::new();
        let target = 2048 - balloon::MIN_GUEST_MIB;
        let mut api = MockLifecycleApi::with_stats(
            Default::default(),
            [
                MockBalloonStatsReply::Ok(MockBalloonStats::new(target, 0)),
                MockBalloonStatsReply::Ok(MockBalloonStats::new(target, target)),
                MockBalloonStatsReply::Ok(MockBalloonStats::new(0, 1)),
                MockBalloonStatsReply::Ok(MockBalloonStats::new(0, 0)),
            ]
            .into(),
        );
        let mut is_parked = false;
        let result = coordinated_local_park(
            &coordinator,
            &mut is_parked,
            api.socket_path(),
            observe_admission.then_some(&gate),
            Some(&handoff),
        )
        .await
        .unwrap();
        assert!(matches!(
            result,
            PhysicalParkOutcome::Idle(SandboxParkOutcome::Reusable)
        ));
        assert!(is_parked);
        assert!(!handoff.is_accepted());
        sequences.push(
            api.drain_requests()
                .iter()
                .map(|request| {
                    (
                        request.method.clone(),
                        request.path.clone(),
                        request.body.clone(),
                    )
                })
                .collect::<Vec<_>>(),
        );
    }
    assert_eq!(sequences[0], sequences[1]);
    assert_eq!(sequences[0].len(), 7);
}
