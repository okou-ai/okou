use runner_provider::{RunnerPreference, RunnerPreferenceTier, parse_runner_preference};
use serde_json::json;

#[test]
fn canonical_closed_reader_accepts_home() {
    let body = json!({
        "kind": "preference",
        "runnerIdentity": {
            "runnerId": "550e8400-e29b-41d4-a716-446655440000",
            "heartbeatGeneration": 7
        },
        "tier": "homeCache",
        "expiresAt": "2099-01-01T00:00:00Z"
    });
    let parsed: RunnerPreference = serde_json::from_value(body.clone()).unwrap();
    assert!(matches!(
        parsed,
        RunnerPreference::Preference {
            tier: RunnerPreferenceTier::HomeCache,
            ..
        }
    ));
    assert!(parse_runner_preference(Some(body)).unwrap().is_some());
    assert_eq!(RunnerPreferenceTier::HomeCache.rank(), 1);
    assert!(RunnerPreferenceTier::HomeCache.rank() < RunnerPreferenceTier::ReusableSandbox.rank());
}

#[test]
fn unrelated_unknown_tier_remains_rejected_by_closed_reader() {
    let body = json!({
        "kind": "preference",
        "runnerIdentity": {
            "runnerId": "550e8400-e29b-41d4-a716-446655440000",
            "heartbeatGeneration": 7
        },
        "tier": "futureUnreviewedCache",
        "expiresAt": "2099-01-01T00:00:00Z"
    });
    assert!(parse_runner_preference(Some(body)).is_err());
}
