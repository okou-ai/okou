use super::*;

fn preference() -> serde_json::Value {
    serde_json::json!({
        "kind": "preference",
        "runnerIdentity": {
            "runnerId": "11111111-1111-4111-8111-111111111111",
            "heartbeatGeneration": 7
        },
        "tier": "finalizingPredecessor",
        "expiresAt": "2999-01-01T00:00:00Z"
    })
}

#[test]
fn finalizing_source_survives_context_and_claim_telemetry_without_native_history() {
    let source = RunId::new_v4();
    let mut wire = preference();
    wire["finalizingSourceRunId"] = serde_json::to_value(source).unwrap();
    let context = parse_runner_preference(Some(wire.clone())).unwrap();
    let candidate = JobCandidate::new(RunId::new_v4(), "vm0/default".into())
        .with_parsed_runner_preference_context(context);
    assert_eq!(candidate.history_generation_run_id(), None);
    assert_eq!(
        candidate
            .runner_preference()
            .unwrap()
            .finalizing_source_run_id(),
        Some(source)
    );
    let telemetry = candidate.runner_preference_claim_telemetry().unwrap();
    assert_eq!(
        serde_json::to_value(telemetry.runner_preference).unwrap(),
        wire
    );
}

#[test]
fn old_preference_round_trips_without_an_added_null_source() {
    let wire = preference();
    let context = parse_runner_preference(Some(wire.clone()))
        .unwrap()
        .unwrap();
    assert_eq!(
        context.preference().unwrap().finalizing_source_run_id(),
        None
    );
    assert_eq!(
        serde_json::to_value(context.runner_preference).unwrap(),
        wire
    );
    let active = ActiveRunnerPreference::new(
        RunnerProcessIdentity::new(uuid::Uuid::new_v4(), 7).unwrap(),
        RunnerPreferenceTier::FinalizingPredecessor,
        Instant::now() + Duration::from_secs(1),
    );
    let telemetry = JobCandidate::new(RunId::new_v4(), "vm0/default".into())
        .with_runner_preference(active)
        .runner_preference_claim_telemetry()
        .unwrap();
    assert!(
        serde_json::to_value(telemetry.runner_preference)
            .unwrap()
            .get("finalizingSourceRunId")
            .is_none()
    );
}

#[test]
fn malformed_source_does_not_become_an_active_preference() {
    for invalid in [serde_json::json!("not-a-run-id"), serde_json::Value::Null] {
        let mut wire = preference();
        wire["finalizingSourceRunId"] = invalid;
        assert!(parse_runner_preference(Some(wire)).is_err());
    }
}
