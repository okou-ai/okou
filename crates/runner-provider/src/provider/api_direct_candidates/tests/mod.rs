use std::time::Duration;

use super::super::{RunnerNoPreferenceReason, RunnerPreference, RunnerPreferenceTarget};
use super::*;
use runner_host::runner_process_identity::RunnerProcessIdentity;

fn run_id(value: u128) -> RunId {
    RunId::from(uuid::Uuid::from_u128(value))
}

fn direct_candidate_inbox(capacity: usize) -> Arc<DirectCandidateInbox> {
    DirectCandidateInbox::new(capacity, DIRECT_CANDIDATE_STALE_AFTER)
}

fn direct_candidate_inbox_with_stale_after(
    capacity: usize,
    stale_after: Duration,
) -> Arc<DirectCandidateInbox> {
    DirectCandidateInbox::new(capacity, stale_after)
}

fn ranked_preference_context(
    runner_id: u128,
    tier: RunnerPreferenceTarget,
    deadline: StdInstant,
) -> RunnerPreferenceContext {
    RunnerPreferenceContext::from_active_preference(ActiveRunnerPreference::new(
        RunnerProcessIdentity::new(uuid::Uuid::from_u128(runner_id), 7).unwrap(),
        tier,
        deadline,
    ))
}

fn candidate_with_enqueued_at(run_id: RunId, enqueued_at: StdInstant) -> DirectJobCandidate {
    let mut candidate =
        DirectJobCandidate::new_with_discovered_at(run_id, "vm0/default".to_string(), enqueued_at);
    candidate.enqueued_at = Some(enqueued_at);
    candidate
}

#[tokio::test]
async fn duplicate_run_id_accepts_first_decision_and_preserves_first_discovery_time() {
    let inbox = direct_candidate_inbox(4);
    let first_discovered_at = StdInstant::now() - Duration::from_secs(5);
    let second_discovered_at = StdInstant::now();
    let source = run_id(2);
    let run_id = run_id(1);

    let inserted = inbox
        .push(DirectJobCandidate::new_with_routing_metadata(
            run_id,
            "vm0/default".to_string(),
            first_discovered_at,
            Some("session:sess-1".to_string()),
            None,
        ))
        .await;
    assert_eq!(
        inserted.snapshot(),
        DirectCandidateInboxSnapshot {
            depth: 1,
            capacity: 4,
        }
    );

    let exact_deadline = StdInstant::now() + Duration::from_secs(8);
    let updated = inbox
        .push(DirectJobCandidate::new_with_routing_metadata(
            run_id,
            "vm0/default".to_string(),
            second_discovered_at,
            Some("session:sess-2".to_string()),
            Some(ranked_preference_context(
                20,
                RunnerPreferenceTarget::ExactSandbox(source),
                exact_deadline,
            )),
        ))
        .await;
    assert!(matches!(
        updated,
        DirectCandidateInsertOutcome::Updated {
            snapshot: DirectCandidateInboxSnapshot {
                depth: 1,
                capacity: 4,
            },
            pruned: None,
        }
    ));

    let renewed = inbox
        .push(DirectJobCandidate::new_with_routing_metadata(
            run_id,
            "vm0/default".to_string(),
            second_discovered_at,
            Some("session:must-not-renew".to_string()),
            Some(ranked_preference_context(
                30,
                RunnerPreferenceTarget::HomeCache,
                StdInstant::now() + Duration::from_secs(30),
            )),
        ))
        .await;
    assert!(matches!(
        renewed,
        DirectCandidateInsertOutcome::Updated { .. }
    ));

    let candidate = inbox.try_pop().await.expect("direct candidate");
    assert_eq!(candidate.discovered_at(), first_discovered_at);
    assert!(candidate.enqueued_at().is_some());
    let candidate = candidate.into_job_candidate();
    assert_eq!(candidate.reuse_key(), Some("session:sess-2"));
    let preference = candidate
        .runner_preference()
        .expect("updated canonical preference");
    assert_eq!(
        preference.target(),
        RunnerPreferenceTarget::ExactSandbox(source)
    );
    assert_eq!(preference.deadline(), exact_deadline);
    assert!(preference.targets(RunnerProcessIdentity::new(uuid::Uuid::from_u128(20), 7).unwrap()));
    let telemetry = candidate
        .runner_preference_claim_telemetry()
        .expect("canonical preference telemetry");
    assert!(matches!(
        telemetry.runner_preference,
        RunnerPreference::Preference(
            crate::provider::RunnerPreferenceDecision::ExactSandbox { .. }
        )
    ));
    assert_eq!(
        telemetry.state,
        Some(super::super::RunnerPreferenceClaimState::Active)
    );
    assert!(
        candidate
            .direct_candidate_notification_to_enqueue_elapsed()
            .is_some_and(|elapsed| elapsed >= Duration::from_secs(5))
    );
    assert!(candidate.direct_candidate_inbox_wait_elapsed().is_some());
    assert!(inbox.try_pop().await.is_none());
}

#[tokio::test]
async fn duplicate_retains_first_decision_snapshot_and_deadline() {
    let inbox = direct_candidate_inbox(1);
    let candidate_run_id = run_id(5);
    let source = run_id(8);
    let first_deadline = StdInstant::now() + Duration::from_secs(5);
    inbox
        .push(DirectJobCandidate::new_with_routing_metadata(
            candidate_run_id,
            "vm0/default".to_string(),
            StdInstant::now(),
            Some("session:first-decision".to_string()),
            Some(ranked_preference_context(
                10,
                RunnerPreferenceTarget::PredecessorHome(
                    source,
                    crate::provider::ActivePredecessorHomeEvidence::Advertised,
                ),
                first_deadline,
            )),
        ))
        .await;

    inbox
        .push(DirectJobCandidate::new_with_routing_metadata(
            candidate_run_id,
            "vm0/default".to_string(),
            StdInstant::now(),
            Some("session:must-not-replace".to_string()),
            Some(ranked_preference_context(
                20,
                RunnerPreferenceTarget::ExactSandbox(run_id(9)),
                StdInstant::now() + Duration::from_secs(30),
            )),
        ))
        .await;

    inbox
        .push(DirectJobCandidate::new_with_routing_metadata(
            candidate_run_id,
            "vm0/default".to_string(),
            StdInstant::now(),
            None,
            Some(RunnerPreferenceContext::no_preference_for_test(
                RunnerNoPreferenceReason::NoViableHolder,
            )),
        ))
        .await;

    let candidate = inbox
        .try_pop()
        .await
        .expect("retained direct candidate")
        .into_job_candidate();
    assert_eq!(candidate.reuse_key(), Some("session:first-decision"));
    let preference = candidate.runner_preference().expect("runner preference");
    assert_eq!(
        preference.target(),
        RunnerPreferenceTarget::PredecessorHome(
            source,
            crate::provider::ActivePredecessorHomeEvidence::Advertised
        )
    );
    assert_eq!(preference.deadline(), first_deadline);
    assert!(preference.targets(RunnerProcessIdentity::new(uuid::Uuid::from_u128(10), 7).unwrap()));
    let telemetry = candidate
        .runner_preference_claim_telemetry()
        .expect("retained canonical preference telemetry");
    assert!(matches!(
        telemetry.runner_preference,
        RunnerPreference::Preference(
            crate::provider::RunnerPreferenceDecision::PredecessorHome { .. }
        )
    ));
    assert_eq!(
        telemetry.state,
        Some(super::super::RunnerPreferenceClaimState::Active)
    );
}

#[tokio::test]
async fn overflow_is_coalesced_until_capacity_makes_progress() {
    let inbox = direct_candidate_inbox(1);
    let _ = inbox
        .push(DirectJobCandidate::new(
            run_id(1),
            "vm0/default".to_string(),
        ))
        .await;

    let first_overflow = inbox
        .push(DirectJobCandidate::new(
            run_id(2),
            "vm0/default".to_string(),
        ))
        .await;
    assert!(matches!(
        first_overflow,
        DirectCandidateInsertOutcome::Overflow {
            snapshot: DirectCandidateInboxSnapshot {
                depth: 1,
                capacity: 1,
            },
            coalesced_count: 1,
            should_wake_poll: true,
            pruned: None,
        }
    ));

    let second_overflow = inbox
        .push(DirectJobCandidate::new(
            run_id(3),
            "vm0/default".to_string(),
        ))
        .await;
    assert!(matches!(
        second_overflow,
        DirectCandidateInsertOutcome::Overflow {
            snapshot: DirectCandidateInboxSnapshot {
                depth: 1,
                capacity: 1,
            },
            coalesced_count: 2,
            should_wake_poll: false,
            pruned: None,
        }
    ));

    assert_eq!(
        inbox.try_pop().await.expect("first candidate").run_id(),
        run_id(1)
    );
    let _ = inbox
        .push(DirectJobCandidate::new(
            run_id(4),
            "vm0/default".to_string(),
        ))
        .await;
    let reset_overflow = inbox
        .push(DirectJobCandidate::new(
            run_id(5),
            "vm0/default".to_string(),
        ))
        .await;
    assert!(matches!(
        reset_overflow,
        DirectCandidateInsertOutcome::Overflow {
            coalesced_count: 1,
            should_wake_poll: true,
            pruned: None,
            ..
        }
    ));
}

#[tokio::test]
async fn stale_candidates_are_pruned_before_push_and_reset_overflow_state() {
    let stale_after = Duration::from_secs(60);
    let inbox = direct_candidate_inbox_with_stale_after(1, stale_after);
    let stale_enqueued_at = StdInstant::now() - Duration::from_secs(120);
    let _ = inbox
        .push(candidate_with_enqueued_at(run_id(1), stale_enqueued_at))
        .await;

    let inserted_after_prune = inbox
        .push(DirectJobCandidate::new(
            run_id(2),
            "vm0/default".to_string(),
        ))
        .await;

    assert!(matches!(
        inserted_after_prune,
        DirectCandidateInsertOutcome::Inserted {
            snapshot: DirectCandidateInboxSnapshot {
                depth: 1,
                capacity: 1,
            },
            pruned: Some(DirectCandidatePruneSnapshot {
                pruned_count: 1,
                depth: 0,
                capacity: 1,
                stale_after: pruned_stale_after,
                oldest_pruned_wait_elapsed,
            }),
        } if pruned_stale_after == stale_after
            && oldest_pruned_wait_elapsed >= stale_after
    ));

    let overflow_after_prune = inbox
        .push(DirectJobCandidate::new(
            run_id(3),
            "vm0/default".to_string(),
        ))
        .await;
    assert!(matches!(
        overflow_after_prune,
        DirectCandidateInsertOutcome::Overflow {
            coalesced_count: 1,
            should_wake_poll: true,
            pruned: None,
            ..
        }
    ));
    assert_eq!(
        inbox.try_pop().await.expect("fresh candidate").run_id(),
        run_id(2)
    );
    assert!(inbox.try_pop().await.is_none());
}

#[tokio::test]
async fn stale_candidates_are_pruned_before_pop() {
    let stale_after = Duration::from_secs(60);
    let inbox = direct_candidate_inbox_with_stale_after(1, stale_after);
    let stale_enqueued_at = StdInstant::now() - Duration::from_secs(120);
    let _ = inbox
        .push(candidate_with_enqueued_at(run_id(1), stale_enqueued_at))
        .await;

    let outcome = inbox.try_pop_with_prune().await;

    assert!(outcome.candidate.is_none());
    assert!(matches!(
        outcome.pruned,
        Some(DirectCandidatePruneSnapshot {
            pruned_count: 1,
            depth: 0,
            capacity: 1,
            stale_after: pruned_stale_after,
            oldest_pruned_wait_elapsed,
        }) if pruned_stale_after == stale_after
            && oldest_pruned_wait_elapsed >= stale_after
    ));
    assert!(inbox.try_pop().await.is_none());
}

#[tokio::test]
async fn fresh_candidates_are_preserved_before_pop() {
    let stale_after = Duration::from_secs(60);
    let inbox = direct_candidate_inbox_with_stale_after(1, stale_after);
    let fresh_enqueued_at = StdInstant::now() - Duration::from_secs(5);
    let _ = inbox
        .push(candidate_with_enqueued_at(run_id(1), fresh_enqueued_at))
        .await;

    let outcome = inbox.try_pop_with_prune().await;

    assert!(outcome.pruned.is_none());
    assert_eq!(
        outcome.candidate.expect("fresh candidate").run_id(),
        run_id(1)
    );
    assert!(inbox.try_pop().await.is_none());
}

#[tokio::test]
async fn wait_pop_exits_on_cancel() {
    let inbox = direct_candidate_inbox(1);
    let cancel = CancellationToken::new();
    cancel.cancel();

    assert!(inbox.wait_pop(&cancel).await.is_none());
}
