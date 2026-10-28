use super::*;

fn preference(source: RunId) -> serde_json::Value {
    serde_json::json!({
        "kind": "preference",
        "runnerIdentity": {
            "runnerId": "11111111-1111-4111-8111-111111111111",
            "heartbeatGeneration": 7
        },
        "tier": "finalizingPredecessor",
        "expiresAt": "2999-01-01T00:00:00Z",
        "finalizingSourceRunId": source
    })
}

#[test]
fn finalizing_source_survives_context_and_claim_telemetry_without_native_history() {
    let source = RunId::new_v4();
    let wire = preference(source);
    let context = parse_runner_preference(Some(wire.clone())).unwrap();
    let candidate = JobCandidate::new(RunId::new_v4(), "vm0/default".into())
        .with_parsed_runner_preference_context(context);
    assert_eq!(
        candidate.runner_preference().unwrap().target(),
        RunnerPreferenceTarget::FinalizingPredecessor(source)
    );
    let telemetry = candidate.runner_preference_claim_telemetry().unwrap();
    assert_eq!(
        serde_json::to_value(telemetry.runner_preference).unwrap(),
        wire
    );
}

#[test]
fn exact_source_preserves_producer_without_native_history() {
    let source = RunId::new_v4();
    let mut wire = preference(source);
    wire["tier"] = serde_json::json!("exactSandbox");
    let context = parse_runner_preference(Some(wire.clone())).unwrap();
    let candidate = JobCandidate::new(RunId::new_v4(), "vm0/default".into())
        .with_parsed_runner_preference_context(context);
    assert_eq!(
        candidate
            .runner_preference()
            .unwrap()
            .target()
            .source_run_id(),
        Some(source)
    );
    assert_eq!(
        serde_json::to_value(
            candidate
                .runner_preference_claim_telemetry()
                .unwrap()
                .runner_preference
        )
        .unwrap(),
        wire
    );
}

#[test]
fn source_home_evidence_preserves_source_and_independent_wait_in_claim_telemetry() {
    for home in [
        serde_json::json!({"evidence": "advertised"}),
        serde_json::json!({"evidence": "location"}),
        serde_json::json!({"evidence": "expected", "homeWaitUntil": "2999-01-01T00:00:49Z"}),
    ] {
        let source = RunId::new_v4();
        let wire = serde_json::json!({
            "kind": "preference",
            "runnerIdentity": {"runnerId": "11111111-1111-4111-8111-111111111111", "heartbeatGeneration": 7},
            "tier": "sourceHome",
            "sourceRunId": source,
            "expiresAt": "2999-01-01T00:00:02Z",
            "home": home,
        });
        let candidate = JobCandidate::new(RunId::new_v4(), "vm0/default".into())
            .with_parsed_runner_preference_context(
                parse_runner_preference(Some(wire.clone())).unwrap(),
            );
        let active = candidate.runner_preference().unwrap();
        assert_eq!(active.target().source_run_id(), Some(source));
        if let RunnerPreferenceTarget::SourceHome(_, SourceHomeObservation::Expected { deadline }) =
            active.target()
        {
            assert!(deadline > active.deadline());
            assert!(
                active.tier().rank()
                    < RunnerPreferenceTier::SourceHome(SourceHomeObservation::Advertised).rank()
            );
        }
        assert_eq!(
            serde_json::to_value(
                candidate
                    .runner_preference_claim_telemetry()
                    .unwrap()
                    .runner_preference
            )
            .unwrap(),
            wire
        );
    }
}

#[test]
fn malformed_source_does_not_become_an_active_preference() {
    for invalid in [serde_json::json!("not-a-run-id"), serde_json::Value::Null] {
        let mut wire = preference(RunId::new_v4());
        wire["finalizingSourceRunId"] = invalid;
        assert!(parse_runner_preference(Some(wire)).is_err());
    }
}
