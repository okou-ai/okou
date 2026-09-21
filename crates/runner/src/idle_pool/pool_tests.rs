use std::sync::Arc;
use std::time::{Duration, Instant};

use crate::ids::RunId;
use crate::resource_budget::{BudgetLease, ResourceBudget};
use crate::types::{HeldSandboxState, ReusableSandboxState};

use super::test_support::ParkedIdleCandidateBuilder;
use super::*;

fn make_budget_lease(vcpu: u32, memory_mb: u32) -> BudgetLease {
    let budget = Arc::new(ResourceBudget::new(1, 1, 1.0, 0));
    ResourceBudget::try_reserve_lease(&budget, vcpu, memory_mb).unwrap()
}

fn make_candidate_for(reuse_key: &str, vcpu: u32, memory_mb: u32) -> ParkedIdleCandidate {
    make_candidate_for_with_lease(reuse_key, make_budget_lease(vcpu, memory_mb))
}

fn make_candidate_for_with_lease(
    reuse_key: &str,
    budget_lease: BudgetLease,
) -> ParkedIdleCandidate {
    ParkedIdleCandidateBuilder::new(reuse_key, budget_lease)
        .with_mock_sandbox_name("test")
        .build()
}

fn make_blank_candidate(profile_name: &str, vcpu: u32, memory_mb: u32) -> ParkedIdleCandidate {
    let sandbox_id = sandbox::SandboxId::new_v4();
    ParkedIdleCandidate::blank(
        Box::new(sandbox_mock::MockSandbox::new(sandbox_id.to_string())),
        Arc::new(Box::new(sandbox_mock::MockSandboxFactory::new())),
        make_budget_lease(vcpu, memory_mb),
        sandbox_id,
        profile_name.to_owned(),
        None,
    )
}

fn park_at(
    pool: &mut IdlePool,
    reuse_key: &str,
    candidate: ParkedIdleCandidate,
    parked_at: Instant,
) -> ParkResult {
    assert_eq!(candidate.reuse_key(), Some(reuse_key));
    pool.park_at_for_test(candidate, parked_at)
}

fn pool_config(max_idle: usize) -> IdlePoolConfig {
    IdlePoolConfig { max_idle }
}

#[test]
fn park_and_take() {
    let mut pool = IdlePool::new(pool_config(0));
    assert_eq!(pool.len(), 0);

    let result = pool.park(make_candidate_for("session-1", 2, 2048));
    assert!(matches!(result, ParkResult::Parked));
    assert_eq!(pool.len(), 1);

    let entry = pool.take("session-1").unwrap();
    assert_eq!(entry.budget_vcpu(), 2);
    assert_eq!(entry.budget_memory_mb(), 2048);
    assert_eq!(pool.len(), 0);
}

#[tokio::test]
async fn blank_capacity_yield_selects_only_the_oldest_compatible_aged_exact() {
    let now = Instant::now();
    let min_idle_age = Duration::from_secs(30 * 60);
    let mut pool = IdlePool::new(pool_config(0));
    assert!(matches!(
        pool.park_at_for_test(
            make_blank_candidate("vm0/default", 2, 2048),
            now - Duration::from_secs(60 * 60),
        ),
        ParkResult::Parked
    ));
    assert!(matches!(
        park_at(
            &mut pool,
            "wrong-profile",
            ParkedIdleCandidateBuilder::new("wrong-profile", make_budget_lease(2, 2048))
                .with_profile_name("vm0/other")
                .build(),
            now - Duration::from_secs(50 * 60),
        ),
        ParkResult::Parked
    ));
    assert!(matches!(
        park_at(
            &mut pool,
            "wrong-resource",
            make_candidate_for("wrong-resource", 4, 4096),
            now - Duration::from_secs(50 * 60),
        ),
        ParkResult::Parked
    ));
    for (reuse_key, idle_for) in [
        ("young", Duration::from_secs(29 * 60 + 59)),
        ("boundary", min_idle_age),
        ("oldest", Duration::from_secs(45 * 60)),
    ] {
        assert!(matches!(
            park_at(
                &mut pool,
                reuse_key,
                make_candidate_for(reuse_key, 2, 2048),
                now - idle_for,
            ),
            ParkResult::Parked
        ));
    }

    let revision = pool.status_snapshot().revision;
    let (oldest, idle_age) = pool
        .evict_oldest_exact_for_blank(now, min_idle_age, "vm0/default", &None, 2, 2048)
        .expect("oldest compatible exact should yield capacity");
    assert_eq!(oldest.reuse_key(), Some("oldest"));
    assert_eq!(idle_age, Duration::from_secs(45 * 60));
    assert_eq!(pool.status_snapshot().revision, revision + 1);
    oldest.run().await;

    let (boundary, idle_age) = pool
        .evict_oldest_exact_for_blank(now, min_idle_age, "vm0/default", &None, 2, 2048)
        .expect("the age boundary should be inclusive");
    assert_eq!(boundary.reuse_key(), Some("boundary"));
    assert_eq!(idle_age, min_idle_age);
    boundary.run().await;

    assert!(
        pool.evict_oldest_exact_for_blank(now, min_idle_age, "vm0/default", &None, 2, 2048,)
            .is_none(),
        "blank, young, and incompatible entries must remain"
    );
    for job in pool.drain() {
        job.run().await;
    }
}

#[test]
fn reusable_reservation_is_exclusive_and_restorable() {
    let mut pool = IdlePool::new(pool_config(0));
    let candidate = make_candidate_for("session-reserved", 2, 2048);
    let sandbox_id = candidate.sandbox_id();
    assert!(matches!(pool.park(candidate), ParkResult::Parked));
    let parked_revision = pool.status_snapshot().revision;

    assert!(
        pool.reserve_reusable("session-reserved", "vm0/large", &None)
            .is_none(),
        "profile mismatch must not reserve the idle entry"
    );
    let reservation = pool
        .reserve_reusable("session-reserved", "vm0/default", &None)
        .expect("matching idle entry should be reserved");
    assert_eq!(pool.len(), 0);
    assert_eq!(pool.status_snapshot().revision, parked_revision + 1);
    assert!(
        pool.reserve_reusable("session-reserved", "vm0/default", &None)
            .is_none(),
        "a removed reservation cannot be acquired twice"
    );

    assert!(matches!(
        pool.restore_reserved(reservation),
        RestoreReservedIdleResult::Restored
    ));
    assert_eq!(pool.len(), 1);
    assert_eq!(pool.status_snapshot().revision, parked_revision + 2);
    assert_eq!(
        pool.status_snapshot().idle_sandboxes[0].sandbox_id,
        sandbox_id
    );
}

#[test]
fn reusable_generation_reservation_classifies_exact_misses() {
    let mut pool = IdlePool::new(pool_config(0));
    let held_generation_run_id = RunId::new_v4();
    let requested_generation_run_id = RunId::new_v4();
    let device_rate_limits = sandbox::DeviceRateLimits {
        block: sandbox::BlockRateLimits {
            bandwidth_bytes_per_sec: 100 * 1024 * 1024,
            ops_per_sec: 10_000,
        },
        network: sandbox::NetworkRateLimits {
            rx_bytes_per_sec: 50 * 1024 * 1024,
            tx_bytes_per_sec: 25 * 1024 * 1024,
        },
    };
    let candidate =
        ParkedIdleCandidateBuilder::new("session-generation", make_budget_lease(2, 2048))
            .with_device_rate_limits(device_rate_limits.clone())
            .with_history_generation_run_id(held_generation_run_id)
            .with_last_completed_at("2026-07-15T00:00:00.000Z")
            .build();
    assert!(matches!(pool.park(candidate), ParkResult::Parked));
    let parked_revision = pool.status_snapshot().revision;

    assert!(matches!(
        pool.reserve_reusable_generation_with_reason(
            "missing-session",
            "vm0/default",
            &Some(device_rate_limits.clone()),
            held_generation_run_id,
        ),
        Err(ExactIdleReservationMiss::Absent)
    ));
    assert!(matches!(
        pool.reserve_reusable_generation_with_reason(
            "session-generation",
            "vm0/large",
            &Some(device_rate_limits.clone()),
            held_generation_run_id,
        ),
        Err(ExactIdleReservationMiss::ProfileMismatch)
    ));
    assert!(matches!(
        pool.reserve_reusable_generation_with_reason(
            "session-generation",
            "vm0/default",
            &None,
            held_generation_run_id,
        ),
        Err(ExactIdleReservationMiss::DeviceLimitMismatch)
    ));
    assert!(matches!(
        pool.reserve_reusable_generation_with_reason(
            "session-generation",
            "vm0/default",
            &Some(device_rate_limits.clone()),
            requested_generation_run_id,
        ),
        Err(ExactIdleReservationMiss::HistoryGenerationMismatch)
    ));
    assert_eq!(pool.len(), 1);
    assert_eq!(pool.status_snapshot().revision, parked_revision);

    let _reservation = pool
        .reserve_reusable_generation(
            "session-generation",
            "vm0/default",
            &Some(device_rate_limits),
            held_generation_run_id,
        )
        .expect("the exact generation should reserve");
    assert_eq!(pool.len(), 0);
}

#[tokio::test]
async fn reserved_restore_preserves_newer_same_session_entry() {
    let mut pool = IdlePool::new(pool_config(0));
    let old = make_candidate_for("session-collision", 2, 2048);
    let old_sandbox_id = old.sandbox_id();
    assert!(matches!(pool.park(old), ParkResult::Parked));
    let reservation = pool
        .reserve_reusable("session-collision", "vm0/default", &None)
        .expect("old entry should reserve");

    let replacement = make_candidate_for("session-collision", 2, 2048);
    let replacement_sandbox_id = replacement.sandbox_id();
    assert!(matches!(pool.park(replacement), ParkResult::Parked));
    let RestoreReservedIdleResult::Rejected(rejected) = pool.restore_reserved(reservation) else {
        panic!("collision must reject the older reservation");
    };
    assert_eq!(
        pool.status_snapshot().idle_sandboxes[0].sandbox_id,
        replacement_sandbox_id
    );
    assert_ne!(old_sandbox_id, replacement_sandbox_id);
    rejected.run().await;
    assert_eq!(pool.len(), 1);
}

#[tokio::test]
async fn reserved_restore_rejects_after_parking_closes() {
    let mut pool = IdlePool::new(pool_config(0));
    assert!(matches!(
        pool.park(make_candidate_for("session-closed", 2, 2048)),
        ParkResult::Parked
    ));
    let reservation = pool
        .reserve_reusable("session-closed", "vm0/default", &None)
        .expect("entry should reserve");
    pool.parking_gate().close();

    let RestoreReservedIdleResult::Rejected(rejected) = pool.restore_reserved(reservation) else {
        panic!("closed parking must reject reservation restore");
    };
    rejected.run().await;
    assert_eq!(pool.len(), 0);
}

#[test]
fn reserved_restore_accepts_an_entry_regardless_of_original_age() {
    let mut pool = IdlePool::new(pool_config(0));
    let now = Instant::now();
    let candidate = make_candidate_for("session-aged-reservation", 2, 2048);
    assert!(matches!(
        park_at(
            &mut pool,
            "session-aged-reservation",
            candidate,
            now - Duration::from_secs(301),
        ),
        ParkResult::Parked
    ));
    let reservation = pool
        .reserve_reusable("session-aged-reservation", "vm0/default", &None)
        .expect("idle age must not prevent reservation");

    assert!(matches!(
        pool.restore_reserved(reservation),
        RestoreReservedIdleResult::Restored
    ));
    assert_eq!(pool.len(), 1);
}

#[test]
fn park_uses_candidate_reuse_key_as_pool_key() {
    let mut pool = IdlePool::new(pool_config(0));
    let result = pool.park(make_candidate_for("candidate-session", 2, 2048));
    assert!(matches!(result, ParkResult::Parked));

    assert!(
        pool.take("caller-provided-session").is_none(),
        "park no longer accepts a separate reuse key"
    );
    assert!(pool.take("candidate-session").is_some());
}

#[test]
fn take_missing_returns_none() {
    let mut pool = IdlePool::new(pool_config(0));
    assert!(pool.take("nonexistent").is_none());
}

#[test]
fn park_same_reuse_key_evicts_previous() {
    let mut pool = IdlePool::new(pool_config(0));

    let _ = pool.park(make_candidate_for("session-1", 2, 2048));
    let result = pool.park(make_candidate_for("session-1", 4, 4096));

    match result {
        ParkResult::Replaced(evicted) => {
            assert_eq!(evicted.budget_vcpu(), 2);
            assert_eq!(evicted.budget_memory_mb(), 2048);
        }
        _ => panic!("expected Replaced"),
    }

    assert_eq!(pool.len(), 1);
    let entry = pool.take("session-1").unwrap();
    assert_eq!(entry.budget_vcpu(), 4);
}

#[test]
fn park_respects_max_idle() {
    let mut pool = IdlePool::new(pool_config(2));

    let _ = pool.park(make_candidate_for("s1", 2, 2048));
    let _ = pool.park(make_candidate_for("s2", 2, 2048));

    // Third session should fail
    let result = pool.park(make_candidate_for("s3", 2, 2048));
    assert!(matches!(result, ParkResult::Rejected(_)));
    assert_eq!(pool.len(), 2);

    // But replacing existing session should work
    let result = pool.park(make_candidate_for("s1", 4, 4096));
    assert!(matches!(result, ParkResult::Replaced(_)));
    assert_eq!(pool.len(), 2);
}

#[test]
fn blank_entries_are_reserved_only_by_compatible_blank_lookup() {
    let mut pool = IdlePool::new(pool_config(0));
    assert!(matches!(
        pool.reserve_blank("vm0/default", &None),
        BlankIdleReservation::Empty
    ));
    let blank = make_blank_candidate("vm0/default", 2, 2048);
    let blank_id = blank.sandbox_id();
    assert!(blank.reuse_key().is_none());
    assert!(matches!(pool.park(blank), ParkResult::Parked));

    assert_eq!(pool.blank_len(), 1);
    assert!(pool.take_reserved(&blank_id.to_string()).is_none());
    assert!(
        pool.reserve_reusable(&blank_id.to_string(), "vm0/default", &None)
            .is_none()
    );
    assert!(matches!(
        pool.reserve_blank("vm0/large", &None),
        BlankIdleReservation::Incompatible
    ));

    // A real exact key that equals a blank's sandbox ID is a different identity.
    let exact_key = blank_id.to_string();
    assert!(matches!(
        pool.park(make_candidate_for(&exact_key, 2, 2048)),
        ParkResult::Parked
    ));
    let exact = pool
        .reserve_reusable(&exact_key, "vm0/default", &None)
        .unwrap();
    assert_eq!(exact.kind(), IdleSandboxKind::Exact);
    assert_eq!(exact.reuse_key(), Some(exact_key.as_str()));
    assert_eq!(pool.blank_len(), 1);
    assert!(matches!(
        pool.restore_reserved(exact),
        RestoreReservedIdleResult::Restored
    ));

    let BlankIdleReservation::Reserved(reserved) = pool.reserve_blank("vm0/default", &None) else {
        panic!("compatible blank should reserve");
    };
    assert_eq!(reserved.kind(), IdleSandboxKind::Blank);
    assert_eq!(reserved.sandbox_id(), blank_id);
    assert!(reserved.reuse_key().is_none());
    assert_eq!(pool.blank_len(), 0);
}

#[test]
fn blank_entries_remain_in_status_but_not_heartbeat_state() {
    let mut pool = IdlePool::new(pool_config(0));
    assert!(matches!(
        pool.park(make_blank_candidate("vm0/default", 2, 2048)),
        ParkResult::Parked
    ));

    assert!(pool.status_snapshot().idle_sandboxes.is_empty());
    assert_eq!(pool.status_snapshot().blank_sandboxes.len(), 1);
    assert!(pool.held_sandbox_states().is_empty());
}

#[test]
fn completed_exact_entry_replaces_blank_at_max_idle() {
    let mut pool = IdlePool::new(pool_config(1));
    assert!(matches!(
        pool.park(make_blank_candidate("vm0/default", 2, 2048)),
        ParkResult::Parked
    ));

    let result = pool.park(make_candidate_for("session-exact", 2, 2048));
    assert!(matches!(result, ParkResult::Replaced(_)));
    assert_eq!(pool.blank_len(), 0);
    assert!(pool.has_reusable("session-exact", "vm0/default", &None));
}

#[test]
fn blank_entry_never_replaces_exact_entry_at_max_idle() {
    let mut pool = IdlePool::new(pool_config(1));
    assert!(matches!(
        pool.park(make_candidate_for("session-exact", 2, 2048)),
        ParkResult::Parked
    ));

    assert!(matches!(
        pool.park(make_blank_candidate("vm0/default", 2, 2048)),
        ParkResult::Rejected(_)
    ));
    assert!(pool.has_reusable("session-exact", "vm0/default", &None));
}

#[tokio::test]
async fn rejected_parked_idle_candidate_returns_active_owned_lease() {
    let mut pool = IdlePool::new(pool_config(1));
    let _ = pool.park(make_candidate_for("existing", 2, 2048));

    let rejected_budget = Arc::new(ResourceBudget::new(2, 2048, 1.0, 0));
    let rejected_lease = ResourceBudget::try_reserve_lease(&rejected_budget, 2, 2048).unwrap();
    let result = pool.park(make_candidate_for_with_lease("rejected", rejected_lease));

    let ParkResult::Rejected(rejected) = result else {
        panic!("expected rejected parked idle candidate");
    };
    assert_eq!(
        rejected_budget.allocated().2,
        1,
        "rejected candidate must retain active job lease"
    );

    let (payload, lease) = rejected.into_active_destroy_parts();
    assert_eq!(
        rejected_budget.allocated().2,
        1,
        "splitting physical destroy from lease must keep active capacity"
    );
    payload.stop_and_destroy().await;
    drop(lease);
    assert_eq!(rejected_budget.allocated().2, 0);
}

#[test]
fn pressure_ordering_evicts_oldest_first() {
    let mut pool = IdlePool::new(pool_config(0));
    let now = Instant::now();

    let _ = park_at(
        &mut pool,
        "old",
        make_candidate_for("old", 2, 2048),
        now - Duration::from_secs(100),
    );
    let _ = park_at(&mut pool, "new", make_candidate_for("new", 4, 4096), now);

    let reuse_keys = pool.oldest_first_pressure_keys();
    assert_eq!(
        reuse_keys,
        ["old", "new"].map(|key| IdleSandboxIdentity::Exact(key.to_owned()))
    );
    let evicted = pool.evict_for_pressure(&reuse_keys[0]).unwrap();
    assert_eq!(evicted.budget_vcpu(), 2); // the old one
    assert_eq!(pool.len(), 1);
    assert!(pool.take("new").is_some());
}

#[test]
fn pressure_ordering_evicts_blank_before_older_exact_entry() {
    let mut pool = IdlePool::new(pool_config(0));
    let now = Instant::now();
    let exact = make_candidate_for("session-exact", 2, 2048);
    assert!(matches!(
        park_at(
            &mut pool,
            "session-exact",
            exact,
            now - Duration::from_secs(100),
        ),
        ParkResult::Parked
    ));
    let blank = make_blank_candidate("vm0/default", 2, 2048);
    let blank_id = blank.sandbox_id();
    assert!(blank.reuse_key().is_none());
    assert!(matches!(
        pool.park_at_for_test(blank, now),
        ParkResult::Parked
    ));

    assert_eq!(
        pool.oldest_first_pressure_keys(),
        vec![
            IdleSandboxIdentity::Blank(blank_id),
            IdleSandboxIdentity::Exact("session-exact".to_owned())
        ]
    );
}

#[test]
fn pressure_ordering_breaks_equal_park_time_by_reuse_key() {
    let mut pool = IdlePool::new(pool_config(0));
    let parked_at = Instant::now();
    for reuse_key in ["session-z", "session-a", "session-m"] {
        let _ = park_at(
            &mut pool,
            reuse_key,
            make_candidate_for(reuse_key, 2, 2048),
            parked_at,
        );
    }

    let reuse_keys = pool.oldest_first_pressure_keys();
    assert_eq!(
        reuse_keys,
        ["session-a", "session-m", "session-z"]
            .map(|key| IdleSandboxIdentity::Exact(key.to_owned()))
    );
}

#[test]
fn pressure_selection_reserves_exact_match_before_oldest_eviction() {
    let mut pool = IdlePool::new(pool_config(0));
    let parked_at = Instant::now();
    let history_generation_run_id = RunId::new_v4();
    let matching = ParkedIdleCandidateBuilder::new("session-matching", make_budget_lease(2, 2048))
        .with_history_generation_run_id(history_generation_run_id)
        .build();
    let _ = park_at(
        &mut pool,
        "session-matching",
        matching,
        parked_at - Duration::from_secs(1),
    );
    let _ = park_at(
        &mut pool,
        "session-unrelated",
        make_candidate_for("session-unrelated", 2, 2048),
        parked_at,
    );

    let selection = pool.reserve_reusable_for_pressure(
        Some("session-matching"),
        "vm0/default",
        &None,
        Some(history_generation_run_id),
    );

    let reservation = selection.expect("matching entry must be reserved before pressure eviction");
    assert_eq!(pool.held_reuse_keys(), vec!["session-unrelated"]);
    assert!(matches!(
        pool.restore_reserved(reservation),
        RestoreReservedIdleResult::Restored
    ));
}

#[test]
fn pressure_ordering_empty_returns_no_keys() {
    let pool = IdlePool::new(pool_config(0));
    let reuse_keys = pool.oldest_first_pressure_keys();
    assert!(reuse_keys.is_empty());
}

#[test]
fn held_reuse_keys() {
    let mut pool = IdlePool::new(pool_config(0));
    let _ = pool.park(make_candidate_for("s1", 2, 2048));
    let _ = pool.park(make_candidate_for("s2", 2, 2048));

    let reuse_keys = pool.held_reuse_keys();
    assert_eq!(reuse_keys, vec!["s1", "s2"]);
}

#[test]
fn held_sandbox_states_include_only_entries_with_timestamps() {
    let mut pool = IdlePool::new(pool_config(0));
    let history_generation_run_id = RunId::new_v4();
    let unconfirmed = make_candidate_for("sess-unconfirmed", 2, 2048);
    let confirmed_b = make_candidate_for("sess-b", 2, 2048)
        .with_last_completed_at("2026-05-28T00:00:01.000Z".to_string());
    let confirmed_a = ParkedIdleCandidateBuilder::new("sess-a", make_budget_lease(2, 2048))
        .with_mock_sandbox_name("test")
        .with_history_generation_run_id(history_generation_run_id)
        .with_last_completed_at("2026-05-28T00:00:00.000Z")
        .build();

    let _ = pool.park(unconfirmed);
    let _ = pool.park(confirmed_b);
    let _ = pool.park(confirmed_a);

    assert_eq!(
        pool.held_sandbox_states(),
        vec![
            HeldSandboxState {
                reuse_key: "sess-a".to_string(),
                last_completed_at: "2026-05-28T00:00:00.000Z".to_string(),
                reusable_sandbox: ReusableSandboxState {
                    profile: "vm0/default".to_string(),
                    history_generation_run_id: Some(history_generation_run_id),
                },
            },
            HeldSandboxState {
                reuse_key: "sess-b".to_string(),
                last_completed_at: "2026-05-28T00:00:01.000Z".to_string(),
                reusable_sandbox: ReusableSandboxState {
                    profile: "vm0/default".to_string(),
                    history_generation_run_id: None,
                },
            },
        ],
    );
}

#[test]
fn held_snapshot_pairs_and_sorts() {
    // Park in reverse order to ensure sort kicks in.
    let mut pool = IdlePool::new(pool_config(0));
    let entry_b = make_candidate_for("sess-b", 2, 2048);
    let sid_b = entry_b.sandbox_id();
    let entry_a = make_candidate_for("sess-a", 2, 2048);
    let sid_a = entry_a.sandbox_id();
    let _ = pool.park(entry_b);
    let _ = pool.park(entry_a);

    let sandboxes = pool.held_snapshot();
    assert_eq!(sandboxes.len(), 2);
    assert_eq!(sandboxes[0].reuse_key, "sess-a");
    assert_eq!(sandboxes[0].sandbox_id, sid_a);
    assert_eq!(sandboxes[1].reuse_key, "sess-b");
    assert_eq!(sandboxes[1].sandbox_id, sid_b);
}

#[test]
fn held_snapshot_empty_pool() {
    let pool = IdlePool::new(pool_config(0));
    assert!(pool.held_snapshot().is_empty());
}

#[test]
fn contains_sandbox_id_tracks_current_idle_ownership() {
    let mut pool = IdlePool::new(pool_config(0));
    let candidate = make_candidate_for("s1", 2, 2048);
    let sandbox_id = candidate.sandbox_id();
    assert!(!pool.contains_sandbox_id(sandbox_id));

    assert!(matches!(pool.park(candidate), ParkResult::Parked));
    assert!(pool.contains_sandbox_id(sandbox_id));

    assert!(pool.take("s1").is_some());
    assert!(!pool.contains_sandbox_id(sandbox_id));
}

#[test]
fn status_snapshot_revision_tracks_idle_sandbox_mutations() {
    let mut pool = IdlePool::new(pool_config(0));
    assert_eq!(pool.status_snapshot().revision, 0);

    let _ = pool.park(make_candidate_for("s1", 2, 2048));
    assert_eq!(pool.status_snapshot().revision, 1);

    assert!(pool.take("s1").is_some());
    assert_eq!(pool.status_snapshot().revision, 2);

    let drained = pool.drain();
    assert!(drained.is_empty());
    assert_eq!(
        pool.status_snapshot().revision,
        2,
        "empty drain must not create a fake idle_sandboxes mutation",
    );

    let _ = pool.park(make_candidate_for("s2", 2, 2048));
    assert_eq!(pool.status_snapshot().revision, 3);

    let drained = pool.drain();
    assert_eq!(drained.len(), 1);
    assert_eq!(pool.status_snapshot().revision, 4);
}

#[test]
fn drain() {
    let mut pool = IdlePool::new(pool_config(0));
    let _ = pool.park(make_candidate_for("s1", 2, 2048));
    let _ = pool.park(make_candidate_for("s2", 4, 4096));

    let drained = pool.drain();
    assert_eq!(drained.len(), 2);
    assert_eq!(pool.len(), 0);
    assert_eq!(pool.parking_state(), ParkingState::Open);
}

#[test]
fn park_rejected_while_soft_draining() {
    let mut pool = IdlePool::new(pool_config(0));
    let gate = pool.parking_gate();
    let _ = pool.park(make_candidate_for("s1", 2, 2048));
    gate.soft_drain();
    assert_eq!(pool.parking_state(), ParkingState::SoftDraining);

    let result = pool.park(make_candidate_for("s2", 4, 4096));
    assert!(matches!(result, ParkResult::Rejected(_)));
    assert_eq!(pool.len(), 1);
}

#[test]
fn park_rejected_when_closed() {
    let mut pool = IdlePool::new(pool_config(0));
    let gate = pool.parking_gate();
    gate.close();

    let result = pool.park(make_candidate_for("s1", 2, 2048));
    assert!(matches!(result, ParkResult::Rejected(_)));
    assert_eq!(pool.len(), 0);
}

#[test]
fn soft_drain_can_reopen_parking() {
    let mut pool = IdlePool::new(pool_config(0));
    let gate = pool.parking_gate();
    gate.soft_drain();
    assert!(matches!(
        pool.park(make_candidate_for("s1", 2, 2048)),
        ParkResult::Rejected(_)
    ));

    gate.open_after_soft_drain();
    let result = pool.park(make_candidate_for("s1", 2, 2048));
    assert!(matches!(result, ParkResult::Parked));
    assert_eq!(pool.len(), 1);
}

#[test]
fn drain_empty_pool() {
    let mut pool = IdlePool::new(pool_config(0));
    let drained = pool.drain();
    assert!(drained.is_empty());
    assert_eq!(pool.parking_state(), ParkingState::Open);
}

#[test]
fn park_max_idle_one() {
    let mut pool = IdlePool::new(pool_config(1));

    let result = pool.park(make_candidate_for("s1", 2, 2048));
    assert!(matches!(result, ParkResult::Parked));

    // Second different session rejected
    let result = pool.park(make_candidate_for("s2", 4, 4096));
    assert!(matches!(result, ParkResult::Rejected(_)));
    assert_eq!(pool.len(), 1);

    // Same session replacement still works
    let result = pool.park(make_candidate_for("s1", 8, 8192));
    assert!(matches!(result, ParkResult::Replaced(_)));
    assert_eq!(pool.len(), 1);
    let entry = pool.take("s1").unwrap();
    assert_eq!(entry.budget_vcpu(), 8);
}
