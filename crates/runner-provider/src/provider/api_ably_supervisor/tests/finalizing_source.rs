use super::*;

#[tokio::test]
async fn ably_duplicate_keeps_first_source_and_expiry_without_native_history() {
    let tokens = RunCancellationRegistry::new();
    let wakeups = PollWakeups::new(true);
    let inbox = direct_candidate_inbox();
    let profiles = default_profiles();
    let run_id = runner_types::ids::RunId::new_v4();
    let source = runner_types::ids::RunId::new_v4();
    let first_expiry = (chrono::Utc::now() + chrono::Duration::seconds(30))
        .to_rfc3339_opts(chrono::SecondsFormat::AutoSi, true);
    let first_preference = serde_json::json!({
        "kind": "preference",
        "runnerIdentity": {
            "runnerId": "11111111-1111-4111-8111-111111111111",
            "heartbeatGeneration": 7
        },
        "tier": "finalizingPredecessor",
        "expiresAt": first_expiry,
        "finalizingSourceRunId": source
    });
    let first = make_message(
        Some("job"),
        serde_json::json!({
            "runId": run_id,
            "profile": "vm0/default",
            "reuseKey": "thread:source-dedup",
            "runnerPreference": first_preference
        }),
    );
    handle_ably_message(&first, &profiles, &wakeups, &inbox, &tokens).await;
    let mut duplicate = first.clone();
    duplicate.data["runnerPreference"]["finalizingSourceRunId"] =
        serde_json::to_value(runner_types::ids::RunId::new_v4()).unwrap();
    duplicate.data["runnerPreference"]["expiresAt"] = serde_json::json!("2999-01-01T00:00:00.000Z");
    handle_ably_message(&duplicate, &profiles, &wakeups, &inbox, &tokens).await;

    let candidate = pop_direct_candidate(&inbox).await.into_job_candidate();
    assert_eq!(candidate.history_generation_run_id(), None);
    let preference = candidate.runner_preference().unwrap();
    assert_eq!(preference.finalizing_source_run_id(), Some(source));
    assert!(preference.remaining() <= Duration::from_secs(30));
    assert_eq!(
        serde_json::to_value(
            candidate
                .runner_preference_claim_telemetry()
                .unwrap()
                .runner_preference
        )
        .unwrap(),
        first_preference
    );
    assert_no_direct_candidate(&inbox).await;
}
