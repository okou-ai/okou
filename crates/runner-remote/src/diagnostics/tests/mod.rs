use super::*;

#[test]
fn bounded_vnc_text_keeps_critical_timing_and_distinguishes_zero_from_unavailable() {
    use crate::vnc::evidence::{Carrier, Snapshot, Stage as V};
    let handle = Handle::new(RunId::new_v4(), true);
    let mut vnc = Snapshot::default();
    for step in &mut vnc.steps {
        step.status = trace::Progress::Passed;
        step.elapsed_ms = Some(123);
        if step.stage == V::Retirement {
            step.elapsed_ms = Some(0);
        }
        if step.stage == V::Capture {
            step.status = trace::Progress::Unknown;
            step.elapsed_ms = None;
        }
    }
    let mut access = trace::Trace::new(true).snapshot().unwrap();
    for step in &mut access.stages {
        step.status = trace::Progress::Passed;
        step.timing.elapsed_ms = u64::MAX;
    }
    let carrier = || {
        Box::new(Carrier {
            configuration_id: Uuid::new_v4(),
            generation: i64::MAX,
            attempt_id: Uuid::new_v4(),
            resource_id: Some(Uuid::new_v4()),
            connection_id: Some(Uuid::new_v4()),
            status: trace::Progress::Passed,
            node_setup: Some(trace::Progress::Reused),
            origin_tls: Some(trace::Progress::Passed),
            access: Some(access.clone()),
        })
    };
    vnc.rfb_carrier = Some(carrier());
    vnc.kdc_carrier = Some(carrier());
    let report = handle
        .record(Record {
            effects: None,
            protocol: Protocol::Vnc,
            connection: Uuid::new_v4(),
            operation: Operation::Capture,
            identity: Identity::default(),
            cause: Some(Cause::Vnc(crate::vnc::Failure::TimedOut)),
            dependency: None,
            native: None,
            ssh: Some(access),
            vnc: Some(vnc),
        })
        .unwrap();
    assert!(
        serde_json::to_vec(&report.evidence().unwrap())
            .unwrap()
            .len()
            <= MAX_REPORT_BYTES
    );
    let full = report.message().unwrap();
    let budget = full.len() - 200;
    let compact = report.message_with_budget(budget).unwrap();
    assert!(compact.len() <= budget && compact.len() <= MAX_REPORT_BYTES);
    assert!(compact.contains("Noncritical VNC stages and timing may be omitted."));
    for stage in [
        "authentication",
        "initialization",
        "kdc transport",
        "kdc exchange",
    ] {
        assert!(
            compact.contains(&format!("VNC {stage}: passed.\n  Elapsed: 123 ms.")),
            "{compact}"
        );
    }
    assert!(compact.contains("VNC retirement: passed.\n  Elapsed: 0 ms."));
    assert!(compact.contains("VNC capture: unknown.\n  Timing unavailable."));
}

fn failure(handle: &Handle, protocol: Protocol, connection: Uuid) {
    let _ = handle.record(Record {
        effects: None,
        protocol,
        connection,
        operation: Operation::Exec,
        identity: Identity::default(),
        cause: Some(match protocol {
            Protocol::Ssh => Cause::Ssh(crate::ssh::FailureReason::HostKeyMismatch),
            Protocol::Vnc => Cause::Vnc(crate::vnc::Failure::AuthenticationFailed),
        }),
        dependency: None,
        native: None,
        ssh: None,
        vnc: None,
    });
}

#[test]
fn pinned_failures_survive_other_protocol_pressure_and_exact_queries_never_substitute() {
    let handle = Handle::new(RunId::new_v4(), true);
    let ssh = Uuid::new_v4();
    failure(&handle, Protocol::Ssh, ssh);
    let original = handle.select(Protocol::Ssh, &Selector::default()).unwrap();
    for _ in 0..100 {
        failure(&handle, Protocol::Vnc, Uuid::new_v4());
    }
    assert_eq!(handle.store.state.lock().unwrap().reports.len(), CAPACITY);
    assert_eq!(
        handle
            .select(Protocol::Ssh, &Selector::default())
            .unwrap()
            .attempt_id,
        original.attempt_id
    );
    assert!(
        handle
            .select(
                Protocol::Ssh,
                &Selector {
                    connection_id: Some(Uuid::new_v4()),
                    ..Selector::default()
                }
            )
            .is_none()
    );
    assert_eq!(
        handle
            .select(
                Protocol::Ssh,
                &Selector {
                    attempt_id: Some(original.attempt_id),
                    ..Selector::default()
                }
            )
            .unwrap()
            .connection_id,
        ssh
    );
    assert!(serde_json::to_vec(&original).unwrap().len() < MAX_REPORT_BYTES);
}

#[test]
fn exact_attempts_distinguish_failures_sharing_a_connection_and_session_without_substitution() {
    for protocol in [Protocol::Ssh, Protocol::Vnc] {
        let handle = Handle::new(RunId::new_v4(), true);
        let connection = Uuid::new_v4();
        let session = Uuid::new_v4();
        let record = || {
            handle
                .record(Record {
                    effects: None,
                    protocol,
                    connection,
                    operation: match protocol {
                        Protocol::Ssh => Operation::Session,
                        Protocol::Vnc => Operation::Input,
                    },
                    identity: Identity {
                        session: Some(session),
                        ..Identity::default()
                    },
                    cause: Some(match protocol {
                        Protocol::Ssh => Cause::Ssh(crate::ssh::FailureReason::HostKeyMismatch),
                        Protocol::Vnc => Cause::Vnc(crate::vnc::Failure::AuthenticationFailed),
                    }),
                    dependency: None,
                    native: None,
                    ssh: None,
                    vnc: None,
                })
                .unwrap()
        };
        let first = record();
        let second = record();
        assert_ne!(first.attempt_id, second.attempt_id);
        let latest = || Selector {
            connection_id: Some(connection),
            session_id: Some(session),
            ..Selector::default()
        };
        for broad in [
            latest(),
            Selector {
                connection_id: Some(connection),
                ..Selector::default()
            },
            Selector {
                session_id: Some(session),
                ..Selector::default()
            },
        ] {
            assert_eq!(
                handle.select(protocol, &broad).unwrap().attempt_id,
                second.attempt_id
            );
        }
        for original in [&first, &second] {
            let exact = || Selector {
                attempt_id: Some(original.attempt_id),
                ..latest()
            };
            let selected = handle.select(protocol, &exact()).unwrap();
            assert_eq!(selected.attempt_id, original.attempt_id);
            assert_eq!(selected.connection_id, connection);
            assert_eq!(selected.session_id, Some(session));
            for conflicting in [
                Selector {
                    connection_id: Some(Uuid::new_v4()),
                    ..exact()
                },
                Selector {
                    session_id: Some(Uuid::new_v4()),
                    ..exact()
                },
            ] {
                assert!(handle.select(protocol, &conflicting).is_none());
            }
        }
        for _ in 0..CAPACITY {
            record();
        }
        assert!(handle.select(protocol, &latest()).is_some());
        assert!(
            handle
                .select(
                    protocol,
                    &Selector {
                        attempt_id: Some(first.attempt_id),
                        ..latest()
                    },
                )
                .is_none()
        );
    }
}

#[test]
fn replacement_preserves_history_but_fences_stale_producers_and_other_runs() {
    let old = Handle::new(RunId::new_v4(), true);
    let connection = Uuid::new_v4();
    failure(&old, Protocol::Ssh, connection);
    let check = old.check_scope();
    let current = old.replacement(true);
    assert!(!check.current());
    failure(&check, Protocol::Vnc, connection);
    assert!(check.select(Protocol::Vnc, &Selector::default()).is_none());
    assert_eq!(
        old.finish_check(None, trace::Progress::Unknown)["status"],
        "blocked"
    );
    failure(&old, Protocol::Vnc, connection);
    assert!(
        current
            .select(Protocol::Vnc, &Selector::default())
            .is_none()
    );
    assert_eq!(
        current
            .select(Protocol::Ssh, &Selector::default())
            .unwrap()
            .connection_id,
        connection
    );
    assert!(
        Handle::new(RunId::new_v4(), true)
            .select(Protocol::Ssh, &Selector::default())
            .is_none()
    );
    assert!(old.select(Protocol::Ssh, &Selector::default()).is_none());
}

#[tokio::test]
async fn stale_native_owner_shutdown_cannot_remove_winning_assignments_history() {
    let runtime = crate::native::Runtime::new();
    let run = RunId::new_v4();
    let old =
        runtime.register_with_diagnostics(run, &tokio_util::sync::CancellationToken::new(), true);
    let connection = Uuid::new_v4();
    failure(&old.diagnostics, Protocol::Ssh, connection);
    let winner =
        runtime.register_with_diagnostics(run, &tokio_util::sync::CancellationToken::new(), true);
    failure(&old.diagnostics, Protocol::Vnc, connection);
    old.shutdown().await.unwrap();
    assert!(winner.diagnostics.current());
    assert!(!winner.is_cancelled());
    assert_eq!(
        winner
            .diagnostics
            .select(Protocol::Ssh, &Selector::default())
            .unwrap()
            .connection_id,
        connection
    );
    assert!(
        winner
            .diagnostics
            .select(Protocol::Vnc, &Selector::default())
            .is_none()
    );
    winner.shutdown().await.unwrap();
}

#[test]
fn concurrent_subjects_keep_their_exact_identity_and_bounded_native_summary() {
    let handle = Handle::new(RunId::new_v4(), true);
    let mut subjects = Vec::new();
    let mut tasks = Vec::new();
    for _ in 0..8 {
        let connection = Uuid::new_v4();
        subjects.push(connection);
        let handle = handle.clone();
        tasks.push(std::thread::spawn(move || {
            failure(&handle, Protocol::Ssh, connection)
        }));
    }
    for task in tasks {
        task.join().unwrap();
    }
    for connection in subjects {
        let selected = handle
            .select(
                Protocol::Ssh,
                &Selector {
                    connection_id: Some(connection),
                    ..Selector::default()
                },
            )
            .unwrap();
        assert_eq!(selected.connection_id, connection);
    }
}

#[test]
fn shared_native_cause_is_pinned_for_both_consumers_and_cleanup_cannot_replace_it() {
    let handle = Handle::new(RunId::new_v4(), true);
    let ssh = Uuid::new_v4();
    let vnc = Uuid::new_v4();
    let evidence = Arc::new(NativeEvidence::new());
    let configuration = Uuid::new_v4();
    let source = NativeSource {
        configuration_id: configuration,
        generation: 1,
        resource_id: evidence.resource_id,
        evidence: Arc::clone(&evidence),
        connection: None,
    };
    let active = Arc::new(AtomicBool::new(true));
    evidence.observe(
        handle
            .watch(ssh, Identity::default(), configuration, 1, &active)
            .unwrap(),
    );
    evidence.observe(
        handle
            .watch_vnc(
                vnc,
                Identity::default(),
                &source,
                Some(Dependency {
                    protocol: Protocol::Ssh,
                    connection_id: ssh,
                    cause: None,
                    configuration_created_at: None,
                    configuration_generation: None,
                }),
                &active,
            )
            .unwrap(),
    );
    evidence.ready();
    evidence.terminate(crate::tailscale::Failure::DomainFailed);
    evidence.terminate(crate::tailscale::Failure::Cancelled);
    evidence.cleanup(Err(crate::tailscale::Failure::CleanupTimedOut));
    let vnc_report =
        serde_json::to_value(handle.select(Protocol::Vnc, &Selector::default()).unwrap()).unwrap();
    assert_eq!(
        vnc_report["dependencies"][0]["connection_id"],
        ssh.to_string()
    );
    assert_eq!(
        vnc_report["cause"],
        serde_json::json!({"source":"native","code":"domain_failed"})
    );
    for _ in 0..100 {
        failure(&handle, Protocol::Vnc, Uuid::new_v4());
    }
    drop(source);
    drop(evidence);
    let pinned =
        serde_json::to_value(handle.select(Protocol::Ssh, &Selector::default()).unwrap()).unwrap();
    assert_eq!(
        pinned["native"]["resource_id"],
        vnc_report["native"]["resource_id"]
    );
    assert_eq!(pinned["native"]["evidence"]["terminal"], "domain_failed");
    assert_eq!(
        pinned["native"]["evidence"]["cleanup_failure"],
        "cleanup_timed_out"
    );
    assert!(pinned.to_string().len() < MAX_REPORT_BYTES);
}

#[test]
fn intentional_session_retirement_cannot_receive_or_overwrite_a_later_native_failure() {
    let handle = Handle::new(RunId::new_v4(), true);
    let ssh = Uuid::new_v4();
    let vnc = Uuid::new_v4();
    let old_session = Uuid::new_v4();
    let live_session = Uuid::new_v4();
    let evidence = Arc::new(NativeEvidence::new());
    let source = NativeSource {
        configuration_id: Uuid::new_v4(),
        generation: 1,
        resource_id: evidence.resource_id,
        evidence: Arc::clone(&evidence),
        connection: None,
    };
    let retired = Arc::new(AtomicBool::new(true));
    let live = Arc::new(AtomicBool::new(true));
    let dependency = Dependency {
        protocol: Protocol::Ssh,
        connection_id: ssh,
        cause: None,
        configuration_created_at: None,
        configuration_generation: None,
    };
    for (session, active) in [(old_session, &retired), (live_session, &live)] {
        evidence.observe(
            handle
                .watch_vnc(
                    vnc,
                    Identity {
                        session: Some(session),
                        ..Identity::default()
                    },
                    &source,
                    Some(dependency.clone()),
                    active,
                )
                .unwrap(),
        );
    }
    retired.store(false, Ordering::Release);
    evidence.terminate(crate::tailscale::Failure::DomainFailed);
    assert!(
        handle
            .select(
                Protocol::Vnc,
                &Selector {
                    session_id: Some(old_session),
                    ..Selector::default()
                }
            )
            .is_none()
    );
    assert_eq!(
        handle
            .select(Protocol::Vnc, &Selector::default())
            .unwrap()
            .session_id,
        Some(live_session)
    );
}
