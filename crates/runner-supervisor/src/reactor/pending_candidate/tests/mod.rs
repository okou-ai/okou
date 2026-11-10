use super::*;
use runner_host::runner_process_identity::RunnerProcessIdentity;
use runner_provider::{ActiveRunnerPreference, RunnerPreferenceClaimState, RunnerPreferenceTarget};
use uuid::Uuid;

fn candidate(run_id: RunId, deadline: std::time::Instant) -> JobCandidate {
    JobCandidate::new(run_id, "vm0/default".into()).with_runner_preference(
        ActiveRunnerPreference::new(
            RunnerProcessIdentity::new(Uuid::new_v4(), 1).unwrap(),
            RunnerPreferenceTarget::FinalizingPredecessor(RunId::new_v4()),
            deadline,
        ),
    )
}

fn retain(pending: &mut PendingCandidates, run_id: RunId, deadline: std::time::Instant) {
    let (candidate, checked) = pending.for_admission(candidate(run_id, deadline));
    pending.retain(candidate, RunnerMode::Running, checked);
}

#[tokio::test]
async fn pending_same_run_rediscovery_keeps_original_deadline() {
    let mut pending = PendingCandidates::new();
    let run_id = RunId::new_v4();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    retain(&mut pending, run_id, deadline);
    let (selected, _) =
        pending.for_admission(candidate(run_id, deadline + Duration::from_secs(30)));
    assert_eq!(selected.runner_preference().unwrap().deadline(), deadline);
    assert!(pending.entries.is_empty());
}

#[tokio::test]
async fn pending_first_candidate_does_not_block_unrelated_ready_work() {
    let mut pending = PendingCandidates::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    let first = RunId::new_v4();
    let second = RunId::new_v4();
    retain(&mut pending, first, deadline);
    retain(&mut pending, second, deadline);
    pending.request_retry(RunnerMode::Running);
    assert_eq!(
        pending
            .take_retry(RunnerMode::Running, true)
            .unwrap()
            .0
            .run_id(),
        first
    );
    assert_eq!(
        pending
            .take_retry(RunnerMode::Running, true)
            .unwrap()
            .0
            .run_id(),
        second
    );
    assert!(pending.entries.is_empty());
}

#[tokio::test(start_paused = true)]
async fn pending_expiry_and_mode_clear_release_unclaimed_state() {
    let mut pending = PendingCandidates::new();
    let deadline = Instant::now().into_std() + Duration::from_secs(5);
    retain(&mut pending, RunId::new_v4(), deadline);
    tokio::time::advance(Duration::from_secs(5)).await;
    let (expired, _) = pending.take_retry(RunnerMode::Running, true).unwrap();
    assert!(expired.runner_preference().is_none());
    assert_eq!(
        expired.runner_preference_claim_telemetry().unwrap().state,
        Some(RunnerPreferenceClaimState::Expired)
    );
    let run_id = RunId::new_v4();
    retain(
        &mut pending,
        run_id,
        Instant::now().into_std() + Duration::from_secs(1),
    );
    tokio::time::advance(Duration::from_secs(1)).await;
    assert_eq!(pending.release_expired(), vec![run_id]);
    retain(
        &mut pending,
        RunId::new_v4(),
        Instant::now().into_std() + Duration::from_secs(5),
    );
    pending.clear_if_inactive(RunnerMode::Draining);
    assert!(pending.entries.is_empty());
    assert_eq!(pending.slots.available_permits(), MAX_PENDING_CANDIDATES);
}

#[tokio::test]
async fn publication_during_admission_survives_retention_and_full_slots() {
    let mut pending = PendingCandidates::new();
    let run_id = RunId::new_v4();
    let (candidate, checked) = pending.for_admission(candidate(
        run_id,
        std::time::Instant::now() + Duration::from_secs(5),
    ));
    pending.request_retry(RunnerMode::Running);
    pending.retain(candidate, RunnerMode::Running, checked);
    assert!(pending.take_retry(RunnerMode::Running, false).is_none());
    assert_eq!(
        pending
            .take_retry(RunnerMode::Running, true)
            .unwrap()
            .0
            .run_id(),
        run_id
    );
}

#[tokio::test]
async fn pending_retry_keeps_its_metadata_slot_during_new_arrivals() {
    let mut pending = PendingCandidates::new();
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    for _ in 0..MAX_PENDING_CANDIDATES {
        retain(&mut pending, RunId::new_v4(), deadline);
    }
    pending.request_retry(RunnerMode::Running);
    let (older, checked) = pending.take_retry(RunnerMode::Running, true).unwrap();
    let older_id = older.run_id();
    retain(&mut pending, RunId::new_v4(), deadline);
    assert_eq!(pending.entries.len(), MAX_PENDING_CANDIDATES - 1);
    pending.retain(older, RunnerMode::Running, checked);
    assert_eq!(pending.entries.len(), MAX_PENDING_CANDIDATES);
    assert!(
        pending
            .entries
            .iter()
            .any(|entry| entry.candidate.run_id() == older_id)
    );
    pending.clear_if_inactive(RunnerMode::Stopping);
    assert_eq!(pending.slots.available_permits(), MAX_PENDING_CANDIDATES);
}
