use super::super::super::*;
use super::super::support::{
    SpeculativeIdleSeedSpec, context_with_session, mock_run_config, mock_run_config_with_overrides,
    mock_run_config_with_overrides_and_api_url, seed_idle_pool_with_speculative_timezone, shutdown,
    status_idle_reuse_keys_and_active_runs, test_profiles, test_runner_identity, wait_budget_count,
    wait_cancel_handle, wait_cancel_token_removed, wait_discover_entered, wait_idle_pool_len,
    wait_idle_pool_reuse_keys,
};
use std::sync::Arc;

use guest_contracts::reuse_preparation::{
    REUSE_PREPARATION_EXIT_CLEANUP_FAILED, ReusePreparationRequest,
};
use tracing::Level;
use tracing_subscriber::prelude::*;
use tracing_test_support::CapturedEvents;

use crate::guest_timezone::GuestTimezoneIntent;
use crate::idle_reuse_preparation::add_healthy_reuse_preparation_matcher;
use runner_provider::{ActiveRunnerPreference, JobCandidate, RunnerPreferenceTier};
use runner_types::types::{ExecutionContext, SandboxReuseResult};

fn exact_generation_candidate(
    run_id: RunId,
    reuse_key: &str,
    history_generation_run_id: RunId,
) -> JobCandidate {
    JobCandidate::new(run_id, "vm0/default".into())
        .with_reuse_key(Some(reuse_key.to_owned()))
        .with_history_generation_run_id(Some(history_generation_run_id))
        .with_runner_preference(ActiveRunnerPreference::new(
            test_runner_identity(),
            RunnerPreferenceTier::ExactSandbox,
            std::time::Instant::now() + Duration::from_secs(30),
        ))
}

fn claimed_context(run_id: RunId, reuse_key: &str, timezone: Option<&str>) -> ExecutionContext {
    let mut context = context_with_session(run_id, reuse_key);
    context.user_timezone = timezone.map(str::to_owned);
    context
}

fn guest_restore_timezones(overrides: &sandbox_mock::MockSandboxOverrides) -> Vec<Option<String>> {
    overrides
        .guest_state_restore_calls()
        .into_iter()
        .map(|call| match call.timezone {
            sandbox_mock::GuestStateRestoreTimezoneCall::None => None,
            sandbox_mock::GuestStateRestoreTimezoneCall::BestEffort(timezone)
            | sandbox_mock::GuestStateRestoreTimezoneCall::Required(timezone) => Some(timezone),
        })
        .collect()
}

fn timezone_correction_commands(overrides: &sandbox_mock::MockSandboxOverrides) -> Vec<String> {
    overrides
        .exec_calls()
        .into_iter()
        .filter(|call| {
            call.cmd
                .starts_with("/sbin/guest-state-restore --sync-timezone ")
        })
        .map(|call| call.cmd)
        .collect()
}

fn reuse_preparation_requests(
    overrides: &sandbox_mock::MockSandboxOverrides,
) -> Vec<ReusePreparationRequest> {
    overrides
        .exec_calls()
        .into_iter()
        .filter(|call| call.cmd.contains("guest-agent prepare-for-reuse"))
        .map(|call| {
            serde_json::from_slice(
                call.stdin_bytes
                    .as_deref()
                    .expect("reuse preparation request should use stdin"),
            )
            .expect("reuse preparation request should be valid")
        })
        .collect()
}

#[tokio::test]
async fn exact_reuse_restores_guest_while_claim_is_blocked() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    add_healthy_reuse_preparation_matcher(&overrides);
    let reuse_key = RunId::new_v4().to_string();
    let generation_run_id = RunId::new_v4();
    let sandbox_id = seed_idle_pool_with_speculative_timezone(
        &env.idle_pool,
        &budget,
        &overrides,
        SpeculativeIdleSeedSpec {
            reuse_key: &reuse_key,
            profile_name: "vm0/default",
            vcpu: 2,
            memory_mb: 4096,
            history_generation_run_id: generation_run_id,
            guest_timezone_intent: GuestTimezoneIntent::Configured("Asia/Shanghai".into()),
            timing: None,
        },
    )
    .await;
    env.handle.block_claims();
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider.set_claim_result(
        run_id,
        Some(claimed_context(run_id, &reuse_key, Some("Asia/Shanghai"))),
    );
    env.handle
        .discover_tx
        .send(exact_generation_candidate(
            run_id,
            &reuse_key,
            generation_run_id,
        ))
        .unwrap();

    assert!(
        env.handle
            .wait_claim_in_flight(1, Duration::from_secs(5))
            .await,
        "provider claim did not reach its boundary"
    );
    assert!(
        overrides
            .wait_guest_state_restore_call_count(1, Duration::from_secs(5))
            .await,
        "guest restore did not run while claim was blocked"
    );
    let restore_timezones = guest_restore_timezones(&overrides);
    assert_eq!(restore_timezones, [Some("Asia/Shanghai".into())]);
    assert_eq!(overrides.unpark_call_count(), 1);
    assert!(
        overrides.start_agent_process_calls().is_empty(),
        "agent process must not start before claim succeeds"
    );
    let (idle_reuse_keys, active_runs) =
        status_idle_reuse_keys_and_active_runs(&env._temp_dir.path().join("status.json")).await;
    assert!(idle_reuse_keys.is_empty());
    assert!(
        active_runs.is_empty(),
        "speculative sandbox must not be published as active before claim succeeds"
    );

    env.handle.unblock_claims();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(30))
        .await
        .expect("exact-reuse run should complete after claim release");
    assert_eq!(completion.sandbox_id, Some(sandbox_id));
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::Reused));
    assert_eq!(guest_restore_timezones(&overrides).len(), 1);
    assert!(timezone_correction_commands(&overrides).is_empty());

    shutdown(&env, run_handle).await;
}

async fn assert_timezone_transition_with(
    previous: GuestTimezoneIntent,
    claimed: Option<&str>,
    expected_restore_zone: &str,
    expected_correction_zone: Option<&str>,
    configure: impl FnOnce(&sandbox_mock::MockSandboxOverrides),
) {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    configure(&overrides);
    add_healthy_reuse_preparation_matcher(&overrides);
    let reuse_key = RunId::new_v4().to_string();
    let generation_run_id = RunId::new_v4();
    seed_idle_pool_with_speculative_timezone(
        &env.idle_pool,
        &budget,
        &overrides,
        SpeculativeIdleSeedSpec {
            reuse_key: &reuse_key,
            profile_name: "vm0/default",
            vcpu: 2,
            memory_mb: 4096,
            history_generation_run_id: generation_run_id,
            guest_timezone_intent: previous,
            timing: None,
        },
    )
    .await;
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(claimed_context(run_id, &reuse_key, claimed)));
    env.handle
        .discover_tx
        .send(exact_generation_candidate(
            run_id,
            &reuse_key,
            generation_run_id,
        ))
        .unwrap();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(30))
        .await
        .expect("timezone transition run should complete");
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::Reused));

    let restores = guest_restore_timezones(&overrides);
    assert_eq!(restores, [Some(expected_restore_zone.to_owned())]);
    let corrections = timezone_correction_commands(&overrides);
    match expected_correction_zone {
        Some(zone) => {
            assert_eq!(corrections.len(), 1);
            assert_eq!(
                corrections[0],
                format!("/sbin/guest-state-restore --sync-timezone {zone}")
            );
        }
        None => assert!(corrections.is_empty()),
    }
    assert_eq!(overrides.destroy_call_count(), 0);

    shutdown(&env, run_handle).await;
}

async fn assert_timezone_transition(
    previous: GuestTimezoneIntent,
    claimed: Option<&str>,
    expected_restore_zone: &str,
    expected_correction_zone: Option<&str>,
) {
    assert_timezone_transition_with(
        previous,
        claimed,
        expected_restore_zone,
        expected_correction_zone,
        |_| {},
    )
    .await;
}

#[tokio::test]
async fn exact_reuse_verifies_configured_and_default_timezone_transitions() {
    assert_timezone_transition(
        GuestTimezoneIntent::Configured("Asia/Shanghai".into()),
        Some("Europe/London"),
        "Asia/Shanghai",
        Some("Europe/London"),
    )
    .await;
    assert_timezone_transition(
        GuestTimezoneIntent::Configured("Asia/Shanghai".into()),
        None,
        "Asia/Shanghai",
        Some("UTC"),
    )
    .await;
    assert_timezone_transition(
        GuestTimezoneIntent::Default,
        Some("Asia/Shanghai"),
        "UTC",
        Some("Asia/Shanghai"),
    )
    .await;
    assert_timezone_transition(GuestTimezoneIntent::Default, None, "UTC", None).await;
}

async fn assert_timezone_correction_failure_remains_best_effort(
    exit_code: i32,
    stderr: &[u8],
    expected_stderr: &str,
    expected_exit_code: Option<&str>,
) {
    use httpmock::prelude::*;

    let server = MockServer::start_async().await;
    let telemetry_mock = server
        .mock_async(|when, then| {
            when.method(POST)
                .path("/api/webhooks/agent/telemetry")
                .body_matches(
                    r#""action_type":"runner_exact_reuse_timezone_correction","duration_ms":[0-9]+,"success":false,"error":"speculative_timezone_correction_failed""#,
                );
            then.status(200)
                .header("content-type", "application/json")
                .body(r#"{"success":true,"id":"ok"}"#);
        })
        .await;
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
        pattern: "/sbin/guest-state-restore --sync-timezone Europe/London".into(),
        exit_code,
        stdout: b"timezone stdout".to_vec(),
        stderr: stderr.to_vec(),
    });
    let (config, env) = mock_run_config_with_overrides_and_api_url(
        test_profiles(),
        2,
        4096,
        1,
        Arc::clone(&overrides),
        &server.base_url(),
    );
    let budget = Arc::clone(&config.capacity.budget);
    let reuse_key = RunId::new_v4().to_string();
    let generation_run_id = RunId::new_v4();
    let sandbox_id = seed_idle_pool_with_speculative_timezone(
        &env.idle_pool,
        &budget,
        &overrides,
        SpeculativeIdleSeedSpec {
            reuse_key: &reuse_key,
            profile_name: "vm0/default",
            vcpu: 2,
            memory_mb: 4096,
            history_generation_run_id: generation_run_id,
            guest_timezone_intent: GuestTimezoneIntent::Configured("Asia/Shanghai".into()),
            timing: None,
        },
    )
    .await;
    let captured = CapturedEvents::default();
    let subscriber = tracing_subscriber::registry().with(captured.clone());
    let _guard = tracing::subscriber::set_default(subscriber);
    tracing::callsite::rebuild_interest_cache();
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider.set_claim_result(
        run_id,
        Some(claimed_context(run_id, &reuse_key, Some("Europe/London"))),
    );
    env.handle
        .discover_tx
        .send(exact_generation_candidate(
            run_id,
            &reuse_key,
            generation_run_id,
        ))
        .unwrap();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(30))
        .await
        .expect("timezone correction failure should remain best effort");
    assert_eq!(completion.sandbox_id, Some(sandbox_id));
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::Reused));
    assert_eq!(overrides.destroy_call_count(), 0);

    shutdown(&env, run_handle).await;
    telemetry_mock.assert_calls_async(1).await;

    let run_id = run_id.to_string();
    let events = captured.entries();
    let event = events
        .iter()
        .find(|event| {
            event.level == Level::WARN
                && event.fields.get("message").map(String::as_str)
                    == Some("failed to set guest timezone")
                && event.fields.get("run_id").map(String::as_str) == Some(run_id.as_str())
        })
        .unwrap_or_else(|| panic!("missing timezone warning; events={events:#?}"));
    assert_eq!(
        event.fields.get("tz").map(String::as_str),
        Some("Europe/London")
    );
    assert_eq!(
        event.fields.get("termination").map(String::as_str),
        Some("exited")
    );
    assert_eq!(
        event.fields.get("exit_code").map(String::as_str),
        expected_exit_code
    );
    assert!(
        event
            .fields
            .get("stderr_excerpt")
            .is_some_and(|value| value.contains(expected_stderr)),
        "event={event:#?}"
    );
    assert!(
        event
            .fields
            .get("stdout_excerpt")
            .is_some_and(|value| value.contains("timezone stdout")),
        "event={event:#?}"
    );
}

#[tokio::test]
async fn unavailable_timezone_correction_remains_best_effort_and_reports_failure() {
    assert_timezone_correction_failure_remains_best_effort(
        0,
        b"guest timezone unavailable",
        "guest timezone unavailable",
        None,
    )
    .await;
}

#[tokio::test]
async fn nonzero_timezone_correction_remains_best_effort_and_reports_failure() {
    assert_timezone_correction_failure_remains_best_effort(
        2,
        b"simulated timezone setup failure",
        "simulated timezone setup failure",
        Some("2"),
    )
    .await;
}

#[tokio::test]
async fn unknown_previous_timezone_keeps_restore_after_claim() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    add_healthy_reuse_preparation_matcher(&overrides);
    let reuse_key = RunId::new_v4().to_string();
    let generation_run_id = RunId::new_v4();
    seed_idle_pool_with_speculative_timezone(
        &env.idle_pool,
        &budget,
        &overrides,
        SpeculativeIdleSeedSpec {
            reuse_key: &reuse_key,
            profile_name: "vm0/default",
            vcpu: 2,
            memory_mb: 4096,
            history_generation_run_id: generation_run_id,
            guest_timezone_intent: GuestTimezoneIntent::Unknown,
            timing: None,
        },
    )
    .await;
    env.handle.block_claims();
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider.set_claim_result(
        run_id,
        Some(claimed_context(run_id, &reuse_key, Some("Asia/Shanghai"))),
    );
    env.handle
        .discover_tx
        .send(exact_generation_candidate(
            run_id,
            &reuse_key,
            generation_run_id,
        ))
        .unwrap();
    assert!(
        env.handle
            .wait_claim_in_flight(1, Duration::from_secs(5))
            .await
    );
    assert_eq!(overrides.unpark_call_count(), 0);
    assert!(overrides.exec_calls().is_empty());

    env.handle.unblock_claims();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(30))
        .await
        .expect("unknown prediction should retain ordinary exact reuse");
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::Reused));
    assert_eq!(guest_restore_timezones(&overrides).len(), 1);

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn unknown_claimed_timezone_repeats_authoritative_guest_restore() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    add_healthy_reuse_preparation_matcher(&overrides);
    let reuse_key = RunId::new_v4().to_string();
    let generation_run_id = RunId::new_v4();
    seed_idle_pool_with_speculative_timezone(
        &env.idle_pool,
        &budget,
        &overrides,
        SpeculativeIdleSeedSpec {
            reuse_key: &reuse_key,
            profile_name: "vm0/default",
            vcpu: 2,
            memory_mb: 4096,
            history_generation_run_id: generation_run_id,
            guest_timezone_intent: GuestTimezoneIntent::Configured("Asia/Shanghai".into()),
            timing: None,
        },
    )
    .await;
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider.set_claim_result(
        run_id,
        Some(claimed_context(
            run_id,
            &reuse_key,
            Some("invalid timezone"),
        )),
    );
    env.handle
        .discover_tx
        .send(exact_generation_candidate(
            run_id,
            &reuse_key,
            generation_run_id,
        ))
        .unwrap();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(30))
        .await
        .expect("unknown claimed timezone should complete through full restore fallback");
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::Reused));
    let restores = guest_restore_timezones(&overrides);
    assert_eq!(restores, [Some("Asia/Shanghai".into()), None]);

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn unavailable_claim_reparks_speculative_sandbox() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    add_healthy_reuse_preparation_matcher(&overrides);
    let reuse_key = RunId::new_v4().to_string();
    let generation_run_id = RunId::new_v4();
    let sandbox_id = seed_idle_pool_with_speculative_timezone(
        &env.idle_pool,
        &budget,
        &overrides,
        SpeculativeIdleSeedSpec {
            reuse_key: &reuse_key,
            profile_name: "vm0/default",
            vcpu: 2,
            memory_mb: 4096,
            history_generation_run_id: generation_run_id,
            guest_timezone_intent: GuestTimezoneIntent::Default,
            timing: None,
        },
    )
    .await;
    env.handle.block_claims();
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider.set_claim_result(run_id, None);
    env.handle
        .discover_tx
        .send(exact_generation_candidate(
            run_id,
            &reuse_key,
            generation_run_id,
        ))
        .unwrap();
    assert!(
        env.handle
            .wait_claim_in_flight(1, Duration::from_secs(5))
            .await
    );
    assert!(
        overrides
            .wait_guest_state_restore_call_count(1, Duration::from_secs(5))
            .await
    );
    env.handle.unblock_claims();

    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_idle_pool_reuse_keys(&env.idle_pool, &[&reuse_key], Duration::from_secs(5)).await;
    assert_eq!(budget.allocated(), (2, 4096, 1));
    assert_eq!(overrides.unpark_call_count(), 1);
    assert_eq!(overrides.park_call_count(), 1);
    assert_eq!(overrides.destroy_call_count(), 0);
    assert!(overrides.start_agent_process_calls().is_empty());
    assert!(!env.start_observer.active_run_status_was_published(run_id));
    let requests = reuse_preparation_requests(&overrides);
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0].current_runtime_dir,
        format!("/home/user/.vm0/guest-agent/runs/{generation_run_id}")
    );
    assert_ne!(
        requests[0].current_runtime_dir,
        format!("/home/user/.vm0/guest-agent/runs/{run_id}")
    );

    let followup_run_id = RunId::new_v4();
    env.provider.set_claim_result(
        followup_run_id,
        Some(claimed_context(followup_run_id, &reuse_key, None)),
    );
    env.handle
        .discover_tx
        .send(exact_generation_candidate(
            followup_run_id,
            &reuse_key,
            generation_run_id,
        ))
        .unwrap();
    let completion = env
        .handle
        .wait_completion(followup_run_id, Duration::from_secs(30))
        .await
        .expect("restored speculative sandbox should serve the next exact claim");
    assert_eq!(completion.sandbox_id, Some(sandbox_id));
    assert_eq!(completion.reuse_result, Some(SandboxReuseResult::Reused));

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn cleanup_failure_destroys_lost_speculative_sandbox() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.add_exec_matcher(sandbox_mock::ExecMatcher {
        pattern: "prepare-for-reuse".into(),
        exit_code: REUSE_PREPARATION_EXIT_CLEANUP_FAILED,
        stdout: Vec::new(),
        stderr: b"runtime cleanup failed: protected generation disappeared".to_vec(),
    });
    let reuse_key = RunId::new_v4().to_string();
    let generation_run_id = RunId::new_v4();
    seed_idle_pool_with_speculative_timezone(
        &env.idle_pool,
        &budget,
        &overrides,
        SpeculativeIdleSeedSpec {
            reuse_key: &reuse_key,
            profile_name: "vm0/default",
            vcpu: 2,
            memory_mb: 4096,
            history_generation_run_id: generation_run_id,
            guest_timezone_intent: GuestTimezoneIntent::Default,
            timing: None,
        },
    )
    .await;
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider.set_claim_result(run_id, None);
    env.handle
        .discover_tx
        .send(exact_generation_candidate(
            run_id,
            &reuse_key,
            generation_run_id,
        ))
        .unwrap();

    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_idle_pool_len(&env.idle_pool, 0, Duration::from_secs(5)).await;
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
    assert_eq!(overrides.unpark_call_count(), 1);
    assert_eq!(overrides.park_call_count(), 1);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert!(overrides.start_agent_process_calls().is_empty());
    assert!(!env.start_observer.active_run_status_was_published(run_id));

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn mismatched_claim_run_id_reparks_speculative_sandbox() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    add_healthy_reuse_preparation_matcher(&overrides);
    let reuse_key = RunId::new_v4().to_string();
    let generation_run_id = RunId::new_v4();
    seed_idle_pool_with_speculative_timezone(
        &env.idle_pool,
        &budget,
        &overrides,
        SpeculativeIdleSeedSpec {
            reuse_key: &reuse_key,
            profile_name: "vm0/default",
            vcpu: 2,
            memory_mb: 4096,
            history_generation_run_id: generation_run_id,
            guest_timezone_intent: GuestTimezoneIntent::Default,
            timing: None,
        },
    )
    .await;
    env.handle.block_claims();
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let candidate_run_id = RunId::new_v4();
    let claimed_run_id = RunId::new_v4();
    env.provider.set_claim_result(
        candidate_run_id,
        Some(claimed_context(claimed_run_id, &reuse_key, None)),
    );
    env.handle
        .discover_tx
        .send(exact_generation_candidate(
            candidate_run_id,
            &reuse_key,
            generation_run_id,
        ))
        .unwrap();
    assert!(
        env.handle
            .wait_claim_in_flight(1, Duration::from_secs(5))
            .await
    );
    assert!(
        overrides
            .wait_guest_state_restore_call_count(1, Duration::from_secs(5))
            .await
    );
    env.handle.unblock_claims();

    wait_cancel_token_removed(&env.cancel_tokens, candidate_run_id, Duration::from_secs(5)).await;
    wait_idle_pool_reuse_keys(&env.idle_pool, &[&reuse_key], Duration::from_secs(5)).await;
    assert_eq!(overrides.unpark_call_count(), 1);
    assert_eq!(overrides.park_call_count(), 1);
    assert_eq!(overrides.destroy_call_count(), 0);
    assert!(overrides.start_agent_process_calls().is_empty());
    {
        let completions = env.handle.completions.lock().unwrap();
        assert!(
            !completions.iter().any(|completion| {
                completion.run_id == candidate_run_id || completion.run_id == claimed_run_id
            }),
            "mismatched claim must not complete either run"
        );
    }

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn cancellation_during_claim_completes_without_starting_agent_and_reparks() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    add_healthy_reuse_preparation_matcher(&overrides);
    let reuse_key = RunId::new_v4().to_string();
    let generation_run_id = RunId::new_v4();
    seed_idle_pool_with_speculative_timezone(
        &env.idle_pool,
        &budget,
        &overrides,
        SpeculativeIdleSeedSpec {
            reuse_key: &reuse_key,
            profile_name: "vm0/default",
            vcpu: 2,
            memory_mb: 4096,
            history_generation_run_id: generation_run_id,
            guest_timezone_intent: GuestTimezoneIntent::Default,
            timing: None,
        },
    )
    .await;
    env.handle.block_claims();
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(claimed_context(run_id, &reuse_key, None)));
    env.handle
        .discover_tx
        .send(exact_generation_candidate(
            run_id,
            &reuse_key,
            generation_run_id,
        ))
        .unwrap();
    assert!(
        env.handle
            .wait_claim_in_flight(1, Duration::from_secs(5))
            .await
    );
    assert!(
        overrides
            .wait_guest_state_restore_call_count(1, Duration::from_secs(5))
            .await
    );
    let cancellation = wait_cancel_handle(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    assert!(cancellation.request_cooperative_user_cancellation().await);
    env.handle.unblock_claims();

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("claimed cancellation should be completed");
    assert_eq!(completion.error.as_deref(), Some("cancelled by user"));
    assert_eq!(completion.sandbox_id, None);
    wait_idle_pool_reuse_keys(&env.idle_pool, &[&reuse_key], Duration::from_secs(5)).await;
    assert!(!env.start_observer.active_run_status_was_published(run_id));
    assert!(overrides.start_agent_process_calls().is_empty());
    assert_eq!(overrides.park_call_count(), 1);

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn cancellation_during_timezone_correction_does_not_publish_active_or_start_agent() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let exec_gate = sandbox_mock::MockLifecycleGate::new();
    overrides.set_exec_lifecycle_gate(exec_gate.clone());
    add_healthy_reuse_preparation_matcher(&overrides);
    let reuse_key = RunId::new_v4().to_string();
    let generation_run_id = RunId::new_v4();
    seed_idle_pool_with_speculative_timezone(
        &env.idle_pool,
        &budget,
        &overrides,
        SpeculativeIdleSeedSpec {
            reuse_key: &reuse_key,
            profile_name: "vm0/default",
            vcpu: 2,
            memory_mb: 4096,
            history_generation_run_id: generation_run_id,
            guest_timezone_intent: GuestTimezoneIntent::Configured("Asia/Shanghai".into()),
            timing: None,
        },
    )
    .await;
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider.set_claim_result(
        run_id,
        Some(claimed_context(run_id, &reuse_key, Some("Europe/London"))),
    );
    env.handle
        .discover_tx
        .send(exact_generation_candidate(
            run_id,
            &reuse_key,
            generation_run_id,
        ))
        .unwrap();

    exec_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .unwrap();
    let cancellation = wait_cancel_handle(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    assert!(cancellation.request_cooperative_user_cancellation().await);

    let (_, active_runs) =
        status_idle_reuse_keys_and_active_runs(&env._temp_dir.path().join("status.json")).await;
    assert!(active_runs.is_empty());
    assert!(!env.start_observer.active_run_status_was_published(run_id));
    assert!(overrides.start_agent_process_calls().is_empty());

    exec_gate.release_one();
    exec_gate
        .wait_entered(2, Duration::from_secs(5))
        .await
        .unwrap();
    exec_gate.release_one();

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("claimed cancellation should be completed");
    assert_eq!(completion.error.as_deref(), Some("cancelled by user"));
    assert_eq!(completion.sandbox_id, None);
    wait_idle_pool_reuse_keys(&env.idle_pool, &[&reuse_key], Duration::from_secs(5)).await;
    let (_, active_runs) =
        status_idle_reuse_keys_and_active_runs(&env._temp_dir.path().join("status.json")).await;
    assert!(active_runs.is_empty());
    assert!(!env.start_observer.active_run_status_was_published(run_id));
    assert!(overrides.start_agent_process_calls().is_empty());
    assert_eq!(overrides.park_call_count(), 1);
    assert_eq!(overrides.destroy_call_count(), 0);

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn cancellation_during_speculative_cleanup_does_not_start_fresh_agent() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let destroy_gate = sandbox_mock::MockLifecycleGate::new();
    overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
    overrides.push_unpark_result(Err(sandbox::SandboxError::IdleTransition {
        transition: sandbox::SandboxIdleTransition::Unpark,
        message: "simulated speculative unpark failure".into(),
    }));
    let reuse_key = RunId::new_v4().to_string();
    let generation_run_id = RunId::new_v4();
    seed_idle_pool_with_speculative_timezone(
        &env.idle_pool,
        &budget,
        &overrides,
        SpeculativeIdleSeedSpec {
            reuse_key: &reuse_key,
            profile_name: "vm0/default",
            vcpu: 2,
            memory_mb: 4096,
            history_generation_run_id: generation_run_id,
            guest_timezone_intent: GuestTimezoneIntent::Default,
            timing: None,
        },
    )
    .await;
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(claimed_context(run_id, &reuse_key, None)));
    env.handle
        .discover_tx
        .send(exact_generation_candidate(
            run_id,
            &reuse_key,
            generation_run_id,
        ))
        .unwrap();

    destroy_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .unwrap();
    let cancellation = wait_cancel_handle(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    assert!(cancellation.request_cooperative_user_cancellation().await);
    let (_, active_runs) =
        status_idle_reuse_keys_and_active_runs(&env._temp_dir.path().join("status.json")).await;
    assert!(active_runs.is_empty());
    assert!(overrides.start_agent_process_calls().is_empty());

    destroy_gate.release_one();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("claimed cancellation should be completed after speculative cleanup");
    assert_eq!(completion.error.as_deref(), Some("cancelled by user"));
    assert_eq!(completion.sandbox_id, None);
    assert_eq!(
        completion.reuse_result,
        Some(SandboxReuseResult::UnparkFailed)
    );
    wait_idle_pool_len(&env.idle_pool, 0, Duration::from_secs(5)).await;
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
    assert!(!env.start_observer.active_run_status_was_published(run_id));
    assert!(overrides.start_agent_process_calls().is_empty());
    assert_eq!(overrides.destroy_call_count(), 1);

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn cancellation_wins_when_speculative_cleanup_is_uncertain() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let destroy_gate = sandbox_mock::MockLifecycleGate::new();
    overrides.set_destroy_lifecycle_gate(destroy_gate.clone());
    overrides.push_unpark_result(Err(sandbox::SandboxError::IdleTransition {
        transition: sandbox::SandboxIdleTransition::Unpark,
        message: "simulated speculative unpark failure".into(),
    }));
    overrides.push_destroy_panic("simulated speculative destroy panic");
    let reuse_key = RunId::new_v4().to_string();
    let generation_run_id = RunId::new_v4();
    let sandbox_id = seed_idle_pool_with_speculative_timezone(
        &env.idle_pool,
        &budget,
        &overrides,
        SpeculativeIdleSeedSpec {
            reuse_key: &reuse_key,
            profile_name: "vm0/default",
            vcpu: 2,
            memory_mb: 4096,
            history_generation_run_id: generation_run_id,
            guest_timezone_intent: GuestTimezoneIntent::Default,
            timing: None,
        },
    )
    .await;
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(claimed_context(run_id, &reuse_key, None)));
    env.handle
        .discover_tx
        .send(exact_generation_candidate(
            run_id,
            &reuse_key,
            generation_run_id,
        ))
        .unwrap();

    destroy_gate
        .wait_entered(1, Duration::from_secs(5))
        .await
        .unwrap();
    let cancellation = wait_cancel_handle(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    assert!(cancellation.request_cooperative_user_cancellation().await);
    destroy_gate.release_one();

    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect("claimed cancellation should win after uncertain speculative cleanup");
    assert_eq!(completion.error.as_deref(), Some("cancelled by user"));
    assert_eq!(completion.sandbox_id, None);
    assert_eq!(
        completion.reuse_result,
        Some(SandboxReuseResult::UnparkFailed)
    );
    wait_idle_pool_len(&env.idle_pool, 0, Duration::from_secs(5)).await;
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
    let status_path = env._temp_dir.path().join("status.json");
    let (_, active_runs) = status_idle_reuse_keys_and_active_runs(&status_path).await;
    assert_eq!(active_runs, vec![run_id.to_string()]);
    let status: serde_json::Value =
        serde_json::from_str(&tokio::fs::read_to_string(status_path).await.unwrap()).unwrap();
    assert_eq!(
        status["active_runs"][0]["sandbox_id"],
        sandbox_id.to_string()
    );
    assert!(!env.start_observer.active_run_status_was_published(run_id));
    assert!(overrides.start_agent_process_calls().is_empty());
    assert_eq!(overrides.destroy_call_count(), 1);

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn closed_parking_gate_destroys_lost_speculation_after_repark() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    add_healthy_reuse_preparation_matcher(&overrides);
    let reuse_key = RunId::new_v4().to_string();
    let generation_run_id = RunId::new_v4();
    seed_idle_pool_with_speculative_timezone(
        &env.idle_pool,
        &budget,
        &overrides,
        SpeculativeIdleSeedSpec {
            reuse_key: &reuse_key,
            profile_name: "vm0/default",
            vcpu: 2,
            memory_mb: 4096,
            history_generation_run_id: generation_run_id,
            guest_timezone_intent: GuestTimezoneIntent::Default,
            timing: None,
        },
    )
    .await;
    env.handle.block_claims();
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider.set_claim_result(run_id, None);
    env.handle
        .discover_tx
        .send(exact_generation_candidate(
            run_id,
            &reuse_key,
            generation_run_id,
        ))
        .unwrap();
    assert!(
        env.handle
            .wait_claim_in_flight(1, Duration::from_secs(5))
            .await
    );
    assert!(
        overrides
            .wait_guest_state_restore_call_count(1, Duration::from_secs(5))
            .await
    );
    assert!(env.parking_gate.soft_drain());
    env.handle.unblock_claims();

    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_idle_pool_len(&env.idle_pool, 0, Duration::from_secs(5)).await;
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
    assert_eq!(overrides.park_call_count(), 1);
    assert_eq!(overrides.destroy_call_count(), 1);
    assert!(overrides.start_agent_process_calls().is_empty());

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn duplicate_repark_keeps_newer_idle_sandbox_and_destroys_speculation() {
    let (config, env) = mock_run_config(test_profiles(), 5, 8192, 2);
    let budget = Arc::clone(&config.capacity.budget);
    let original_overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    add_healthy_reuse_preparation_matcher(&original_overrides);
    let reuse_key = RunId::new_v4().to_string();
    let generation_run_id = RunId::new_v4();
    seed_idle_pool_with_speculative_timezone(
        &env.idle_pool,
        &budget,
        &original_overrides,
        SpeculativeIdleSeedSpec {
            reuse_key: &reuse_key,
            profile_name: "vm0/default",
            vcpu: 2,
            memory_mb: 4096,
            history_generation_run_id: generation_run_id,
            guest_timezone_intent: GuestTimezoneIntent::Default,
            timing: None,
        },
    )
    .await;
    env.handle.block_claims();
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider.set_claim_result(run_id, None);
    env.handle
        .discover_tx
        .send(exact_generation_candidate(
            run_id,
            &reuse_key,
            generation_run_id,
        ))
        .unwrap();
    assert!(
        env.handle
            .wait_claim_in_flight(1, Duration::from_secs(5))
            .await
    );
    assert!(
        original_overrides
            .wait_guest_state_restore_call_count(1, Duration::from_secs(5))
            .await
    );

    let replacement_overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    let replacement_id = seed_idle_pool_with_speculative_timezone(
        &env.idle_pool,
        &budget,
        &replacement_overrides,
        SpeculativeIdleSeedSpec {
            reuse_key: &reuse_key,
            profile_name: "vm0/default",
            vcpu: 2,
            memory_mb: 4096,
            history_generation_run_id: RunId::new_v4(),
            guest_timezone_intent: GuestTimezoneIntent::Default,
            timing: None,
        },
    )
    .await;
    env.handle.unblock_claims();

    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_idle_pool_reuse_keys(&env.idle_pool, &[&reuse_key], Duration::from_secs(5)).await;
    wait_budget_count(&budget, 1, Duration::from_secs(5)).await;
    assert_eq!(
        env.idle_pool.lock().await.status_snapshot().idle_sandboxes[0].sandbox_id,
        replacement_id
    );
    assert_eq!(original_overrides.park_call_count(), 1);
    assert_eq!(original_overrides.destroy_call_count(), 1);
    assert_eq!(replacement_overrides.destroy_call_count(), 0);

    shutdown(&env, run_handle).await;
}

#[tokio::test]
async fn repark_failure_destroys_unclaimed_speculation() {
    let (config, env) = mock_run_config(test_profiles(), 2, 4096, 1);
    let budget = Arc::clone(&config.capacity.budget);
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    overrides.push_park_result(Err(sandbox::SandboxError::IdleTransition {
        transition: sandbox::SandboxIdleTransition::Park,
        message: "simulated speculative repark failure".into(),
    }));
    add_healthy_reuse_preparation_matcher(&overrides);
    let reuse_key = RunId::new_v4().to_string();
    let generation_run_id = RunId::new_v4();
    seed_idle_pool_with_speculative_timezone(
        &env.idle_pool,
        &budget,
        &overrides,
        SpeculativeIdleSeedSpec {
            reuse_key: &reuse_key,
            profile_name: "vm0/default",
            vcpu: 2,
            memory_mb: 4096,
            history_generation_run_id: generation_run_id,
            guest_timezone_intent: GuestTimezoneIntent::Default,
            timing: None,
        },
    )
    .await;
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider.set_claim_result(run_id, None);
    env.handle
        .discover_tx
        .send(exact_generation_candidate(
            run_id,
            &reuse_key,
            generation_run_id,
        ))
        .unwrap();

    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_idle_pool_len(&env.idle_pool, 0, Duration::from_secs(5)).await;
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
    assert_eq!(overrides.park_call_count(), 1);
    assert_eq!(overrides.destroy_call_count(), 1);

    shutdown(&env, run_handle).await;
}

async fn assert_speculation_failure_falls_back_to_fresh(
    previous: GuestTimezoneIntent,
    claimed: Option<&str>,
    configure_failure: impl FnOnce(&sandbox_mock::MockSandboxOverrides),
) {
    let overrides = Arc::new(sandbox_mock::MockSandboxOverrides::new());
    configure_failure(&overrides);
    let (config, env) =
        mock_run_config_with_overrides(test_profiles(), 4, 8192, 2, Arc::clone(&overrides));
    let budget = Arc::clone(&config.capacity.budget);
    let reuse_key = RunId::new_v4().to_string();
    let generation_run_id = RunId::new_v4();
    let idle_sandbox_id = seed_idle_pool_with_speculative_timezone(
        &env.idle_pool,
        &budget,
        &overrides,
        SpeculativeIdleSeedSpec {
            reuse_key: &reuse_key,
            profile_name: "vm0/default",
            vcpu: 2,
            memory_mb: 4096,
            history_generation_run_id: generation_run_id,
            guest_timezone_intent: previous,
            timing: None,
        },
    )
    .await;
    let run_handle = tokio::spawn(run(config));
    wait_discover_entered(&env, Duration::from_secs(2)).await;

    let run_id = RunId::new_v4();
    env.provider
        .set_claim_result(run_id, Some(claimed_context(run_id, &reuse_key, claimed)));
    env.handle
        .discover_tx
        .send(exact_generation_candidate(
            run_id,
            &reuse_key,
            generation_run_id,
        ))
        .unwrap();
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(30))
        .await
        .expect("valid claim should use fresh fallback after speculation failure");
    assert_eq!(completion.exit_code, 0);
    assert!(completion.error.is_none());
    let fresh_sandbox_id = completion
        .sandbox_id
        .expect("fresh fallback should complete with a sandbox");
    assert_ne!(fresh_sandbox_id, idle_sandbox_id);
    assert_eq!(
        completion.reuse_result,
        Some(SandboxReuseResult::UnparkFailed)
    );
    wait_cancel_token_removed(&env.cancel_tokens, run_id, Duration::from_secs(5)).await;
    wait_budget_count(&budget, 1, Duration::from_secs(5)).await;
    wait_idle_pool_len(&env.idle_pool, 1, Duration::from_secs(5)).await;
    assert_eq!(
        env.idle_pool.lock().await.status_snapshot().idle_sandboxes[0].sandbox_id,
        fresh_sandbox_id
    );
    assert_eq!(overrides.start_agent_process_calls().len(), 1);
    assert_eq!(overrides.destroy_call_count(), 1);

    shutdown(&env, run_handle).await;
    wait_idle_pool_len(&env.idle_pool, 0, Duration::from_secs(5)).await;
    wait_budget_count(&budget, 0, Duration::from_secs(5)).await;
    assert_eq!(overrides.destroy_call_count(), 2);
}

#[tokio::test]
async fn speculative_unpark_failure_destroys_before_fresh_fallback() {
    assert_speculation_failure_falls_back_to_fresh(
        GuestTimezoneIntent::Default,
        None,
        |overrides| {
            overrides.push_unpark_result(Err(sandbox::SandboxError::IdleTransition {
                transition: sandbox::SandboxIdleTransition::Unpark,
                message: "simulated speculative unpark failure".into(),
            }));
        },
    )
    .await;
}

#[tokio::test]
async fn speculative_unpark_panic_destroys_before_fresh_fallback() {
    assert_speculation_failure_falls_back_to_fresh(
        GuestTimezoneIntent::Default,
        None,
        |overrides| {
            overrides.push_unpark_panic("simulated speculative unpark panic");
        },
    )
    .await;
}

#[tokio::test]
async fn speculative_guest_restore_failure_destroys_before_fresh_fallback() {
    assert_speculation_failure_falls_back_to_fresh(
        GuestTimezoneIntent::Default,
        None,
        |overrides| {
            overrides.push_guest_state_restore_result(Ok(sandbox::ExecResult::new(
                1,
                Vec::new(),
                b"guest-state-restore failed".to_vec(),
            )));
        },
    )
    .await;
}

#[tokio::test]
async fn speculative_guest_restore_transport_failure_destroys_before_fresh_fallback() {
    assert_speculation_failure_falls_back_to_fresh(
        GuestTimezoneIntent::Default,
        None,
        |overrides| {
            overrides.push_guest_state_restore_result(Err(sandbox::SandboxError::Operation {
                operation: sandbox::SandboxOperation::Exec,
                reason: sandbox::SandboxOperationReason::Guest,
                message: "simulated guest restore transport failure".into(),
            }));
        },
    )
    .await;
}

#[tokio::test]
async fn speculative_guest_restore_panic_destroys_before_fresh_fallback() {
    assert_speculation_failure_falls_back_to_fresh(
        GuestTimezoneIntent::Default,
        None,
        |overrides| {
            overrides.push_guest_state_restore_panic("simulated guest restore panic");
        },
    )
    .await;
}

#[tokio::test]
async fn timezone_correction_panic_destroys_before_fresh_fallback() {
    assert_speculation_failure_falls_back_to_fresh(
        GuestTimezoneIntent::Configured("Asia/Shanghai".into()),
        Some("Europe/London"),
        |overrides| {
            overrides.add_exec_panic_matcher(
                "/sbin/guest-state-restore --sync-timezone Europe/London",
                "simulated timezone correction panic",
            );
        },
    )
    .await;
}
