mod fresh_claim;
mod stale_journal;

use super::*;
use runner_provider::{ActiveRunnerPreference, RunnerPreferenceClaimState};
use std::time::Duration;
use uuid::Uuid;

fn finalizing_candidate(run_id: RunId, deadline: Instant) -> JobCandidate {
    JobCandidate::new(run_id, "vm0/default".into()).with_runner_preference(
        ActiveRunnerPreference::new(
            RunnerProcessIdentity::new(Uuid::new_v4(), 1).unwrap(),
            runner_provider::RunnerPreferenceTarget::FinalizingPredecessor(RunId::new_v4()),
            deadline,
        ),
    )
}

#[test]
fn pending_same_run_rediscovery_keeps_original_deadline() {
    let run_id = RunId::new_v4();
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut pending = PendingFinalizingCandidate::new();
    pending.retain(finalizing_candidate(run_id, deadline));

    let selected = pending.for_admission(finalizing_candidate(
        run_id,
        deadline + Duration::from_secs(30),
    ));
    assert_eq!(selected.runner_preference().unwrap().deadline(), deadline);
    assert!(!pending.is_some());
}

#[test]
fn pending_first_candidate_does_not_block_unrelated_ready_work() {
    let first_run = RunId::new_v4();
    let second_run = RunId::new_v4();
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut pending = PendingFinalizingCandidate::new();
    pending.retain(finalizing_candidate(first_run, deadline));

    let ready = pending.for_admission(finalizing_candidate(second_run, deadline));
    assert_eq!(ready.run_id(), second_run);
    pending.retain(ready);
    assert_eq!(pending.deadline(), Some(deadline));
    assert_eq!(pending.take().unwrap().run_id(), first_run);
    assert!(!pending.is_some());
}

#[test]
fn pending_expiry_and_mode_clear_release_unclaimed_state() {
    let deadline = Instant::now() + Duration::from_secs(5);
    let mut pending = PendingFinalizingCandidate::new();
    pending.retain(finalizing_candidate(RunId::new_v4(), deadline));
    let expired = pending.take_expired().unwrap();
    assert!(expired.runner_preference().is_none());
    assert_eq!(
        expired.runner_preference_claim_telemetry().unwrap().state,
        Some(RunnerPreferenceClaimState::Expired)
    );
    assert_eq!(pending.deadline(), None);
    pending.retain(finalizing_candidate(RunId::new_v4(), deadline));
    pending.clear();
    assert!(pending.take().is_none());
}

#[test]
fn ranked_preference_admission_matrix() {
    use RunnerPreferenceTier::{ExactSandbox, FinalizingPredecessor, HomeCache, ReusableSandbox};

    let tiers = [
        HomeCache,
        ReusableSandbox,
        FinalizingPredecessor,
        ExactSandbox,
    ];
    let selected = [
        [true, true, true, true],
        [false, true, true, true],
        [false, false, true, true],
        [false, false, false, true],
    ];
    let unselected = [
        [false, true, true, true],
        [false, false, true, true],
        [false, false, false, true],
        [false, false, false, false],
    ];

    for ((advertised_tier, selected_row), unselected_row) in
        tiers.into_iter().zip(selected).zip(unselected)
    {
        for ((local_tier, selected_expected), unselected_expected) in
            tiers.into_iter().zip(selected_row).zip(unselected_row)
        {
            assert_eq!(
                ranked_preference_allows(advertised_tier, local_tier, true),
                selected_expected,
                "selected runner: advertised={advertised_tier:?}, local={local_tier:?}"
            );
            assert_eq!(
                ranked_preference_allows(advertised_tier, local_tier, false),
                unselected_expected,
                "unselected runner: advertised={advertised_tier:?}, local={local_tier:?}"
            );
        }
    }
}
