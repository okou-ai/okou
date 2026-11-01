use super::*;

const FIXTURE: &str = include_str!("../../../tests/fixtures/oom-evidence-v1.json");

#[test]
fn serialized_evidence_matches_the_cross_language_fixture() {
    let evidence: OomEvidence = serde_json::from_str(FIXTURE).unwrap();
    assert_eq!(
        serde_json::to_value(evidence).unwrap(),
        serde_json::from_str::<serde_json::Value>(FIXTURE).unwrap()
    );
}

/// A byte copy of `contained-tool-oom.json` as it stood before
/// `runtime_progress_at` was removed, so the retired field below is a real
/// recorded payload rather than a hand-written one.
const LEGACY_RUNTIME_PROGRESS_FIXTURE: &str =
    include_str!("../../../tests/fixtures/oom-evidence-v1-legacy-runtime-progress.json");

#[test]
fn a_retired_runtime_progress_field_decodes_as_an_unknown_key() {
    // Runner and Guest binaries ship together and a draining artifact keeps
    // its own sandbox, so no live producer still emits this field. This
    // pins the decoder's treatment of the retired key, not a rollout
    // window: `OomEvidence` has no `deny_unknown_fields`, so it is ignored.
    assert!(LEGACY_RUNTIME_PROGRESS_FIXTURE.contains(r#""runtime_progress_at": 1789527602000"#));
    let legacy =
        decode_evidence(LEGACY_RUNTIME_PROGRESS_FIXTURE.as_bytes()).expect("legacy payload");
    let current: OomEvidence = serde_json::from_str(include_str!(
        "../../../tests/fixtures/contained-tool-oom.json"
    ))
    .unwrap();

    assert_eq!(legacy, current);
    // The re-encoded payload carries no trace of the retired key.
    assert!(
        !serde_json::to_string(&legacy)
            .unwrap()
            .contains("runtime_progress_at")
    );
}

#[test]
fn evidence_exchange_preserves_identity_and_rejects_oversized_frames() {
    let (client, server) = UnixStream::pair().unwrap();
    let evidence: OomEvidence = serde_json::from_str(FIXTURE).unwrap();
    write_evidence(&server, &evidence).unwrap();
    assert_eq!(read_evidence(&client).unwrap(), evidence);
    (&server)
        .write_all(&((MAX_EVIDENCE_BYTES + 1) as u32).to_be_bytes())
        .unwrap();
    assert!(read_evidence(&client).is_err());
}

#[test]
fn unavailable_evidence_peer_has_a_bounded_deadline() {
    let (client, _server) = UnixStream::pair().unwrap();
    let start = Instant::now();
    assert!(read_evidence(&client).is_err());
    assert!(start.elapsed() < Duration::from_secs(2));
}

#[test]
fn evidence_exchange_rejects_count_overflow_and_bounds_a_stalled_writer() {
    let (client, server) = UnixStream::pair().unwrap();
    let mut evidence: OomEvidence = serde_json::from_str(FIXTURE).unwrap();
    evidence.incidents = vec![evidence.incidents[0].clone(); MAX_INCIDENTS + 1];
    write_evidence(&server, &evidence).unwrap();
    assert!(read_evidence(&client).is_err());
    evidence.incidents.truncate(1);
    evidence.incidents[0].kernel_events =
        vec![evidence.incidents[0].kernel_events[0].clone(); MAX_KERNEL_EVENTS + 1];
    write_evidence(&server, &evidence).unwrap();
    assert!(read_evidence(&client).is_err());
    evidence.operation_id = "x".repeat(MAX_EVIDENCE_BYTES);
    assert!(write_evidence(&server, &evidence).is_err());
    let start = Instant::now();
    assert!(write_all_until(&server, &vec![0; 1024 * 1024], start + EVIDENCE_IO_TIMEOUT).is_err());
    assert!(start.elapsed() < Duration::from_secs(2));
}

fn candidate_evidence() -> OomEvidence {
    let mut evidence: OomEvidence = serde_json::from_str(FIXTURE).unwrap();
    let incident = &mut evidence.incidents[0];
    incident.reason = CaptureReason::CliError;
    incident.kernel_status = EvidenceStatus::Missing;
    incident.kernel_events.clear();
    for group in &mut incident.groups {
        group.delta = MemoryEvents::default();
        group.local_delta = MemoryEvents::default();
    }
    evidence
}

fn evidence_line(evidence: &OomEvidence) -> String {
    format!(
        "{EVIDENCE_PREFIX}{}",
        serde_json::to_string(evidence).unwrap()
    )
}

#[test]
fn split_separates_metadata_from_the_actionable_diagnostic() {
    let evidence: OomEvidence = serde_json::from_str(FIXTURE).unwrap();
    let split = split_diagnostic(&format!(
        "Failed to wait: no child processes\n{}",
        evidence_line(&evidence)
    ));

    assert_eq!(split.residual, "Failed to wait: no child processes\n");
    assert!(split.is_actionable());
    assert_eq!(split.evidence.as_ref(), Some(&evidence));
    assert_eq!(split.malformed_lines, 0);
    assert!(split.has_proof());
}

#[test]
fn metadata_only_diagnostic_is_not_actionable() {
    let evidence: OomEvidence = serde_json::from_str(FIXTURE).unwrap();
    let split = split_diagnostic(&evidence_line(&evidence));

    assert_eq!(split.residual, "");
    assert!(!split.is_actionable());
    assert!(split.has_proof());
}

#[test]
fn capture_candidate_carries_no_proof_of_an_oom_decision() {
    let candidate = candidate_evidence();
    assert!(!evidence_has_proof(&candidate));

    let split = split_diagnostic(&evidence_line(&candidate));
    assert!(!split.is_actionable());
    assert!(!split.has_proof());
    assert_eq!(split.malformed_lines, 0);
    assert!(split.evidence.is_some(), "candidate is still transported");
}

#[test]
fn local_counter_transition_alone_still_proves_an_oom_decision() {
    let mut candidate = candidate_evidence();
    candidate.incidents[0].groups[2].local_delta.oom_kill = Some(1);

    assert!(evidence_has_proof(&candidate));
}

#[test]
fn diagnostic_evidence_enforces_the_48_kib_byte_boundary() {
    let evidence: OomEvidence = serde_json::from_str(FIXTURE).unwrap();
    assert!(evidence.incidents.len() <= MAX_INCIDENTS);
    assert!(
        evidence
            .incidents
            .iter()
            .all(|incident| incident.kernel_events.len() <= MAX_KERNEL_EVENTS)
    );
    let json = serde_json::to_string(&evidence).unwrap();

    // Fixed byte sizes keep the oracle independent of the production limit.
    // JSON spaces preserve the evidence and keep it on one diagnostic line.
    for (bytes, accepted) in [(49_152, true), (49_153, false)] {
        let payload = format!("{json}{}", " ".repeat(bytes - json.len()));
        assert_eq!(payload.len(), bytes);
        assert_eq!(
            serde_json::from_str::<OomEvidence>(&payload).unwrap(),
            evidence
        );

        let split = split_diagnostic(&format!("{EVIDENCE_PREFIX}{payload}"));
        assert_eq!(split.evidence.as_ref(), accepted.then_some(&evidence));
        assert_eq!(split.malformed_lines, u32::from(!accepted));
        assert_eq!(split.residual, "");
        assert!(!split.is_actionable());
        assert_eq!(split.has_proof(), accepted);
    }
}

#[test]
fn malformed_metadata_is_counted_and_never_reported_as_a_diagnostic() {
    let evidence: OomEvidence = serde_json::from_str(FIXTURE).unwrap();
    let mut over_count = evidence.clone();
    over_count.incidents = vec![evidence.incidents[0].clone(); MAX_INCIDENTS + 1];
    let mut over_events = evidence.clone();
    over_events.incidents[0].kernel_events =
        vec![evidence.incidents[0].kernel_events[0].clone(); MAX_KERNEL_EVENTS + 1];

    for line in [
        format!("{EVIDENCE_PREFIX}not json"),
        evidence_line(&over_count),
        evidence_line(&over_events),
    ] {
        let split = split_diagnostic(&line);
        assert_eq!(
            split.malformed_lines,
            1,
            "line={}",
            &line[..40.min(line.len())]
        );
        assert!(split.evidence.is_none());
        assert_eq!(
            split.residual, "",
            "malformed metadata is never a diagnostic"
        );
        assert!(!split.is_actionable());
        assert!(!split.has_proof());
    }
}

#[test]
fn clean_diagnostic_is_preserved_verbatim() {
    for diagnostic in [
        "",
        "Failed to clean process containment: EBUSY",
        "Failed to clean process containment: EBUSY\n",
        "Failed to clean process containment: EBUSY\r\n",
    ] {
        let split = split_diagnostic(diagnostic);
        assert_eq!(split.residual, diagnostic);
        assert_eq!(split.is_actionable(), !diagnostic.is_empty());
        assert!(split.evidence.is_none());
        assert_eq!(split.malformed_lines, 0);
    }
}

#[test]
fn split_preserves_real_diagnostic_bytes_around_metadata() {
    let evidence: OomEvidence = serde_json::from_str(FIXTURE).unwrap();
    let split = split_diagnostic(&format!(
        "Failed to wait: no child processes\r\n{}\r\ncleanup still failed\n",
        evidence_line(&evidence)
    ));

    assert_eq!(
        split.residual,
        "Failed to wait: no child processes\r\ncleanup still failed\n"
    );
    assert_eq!(split.evidence.as_ref(), Some(&evidence));
    assert_eq!(split.malformed_lines, 0);
}

#[test]
fn counter_regression_and_missing_baselines_are_unavailable() {
    let evidence: OomEvidence = serde_json::from_str(FIXTURE).unwrap();
    let current = &evidence.groups[0].events;
    assert_eq!(MemoryEvents::default().delta(current).oom_kill, None);
    assert_eq!(current.delta(&MemoryEvents::default()).oom_kill, None);
    assert!(!current.delta(current).has_oom());
}
