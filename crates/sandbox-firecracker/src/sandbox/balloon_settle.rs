//! Balloon settlement policy, bounded observation and Guest memory diagnostics.
//!
//! Physical park/unpark, fencing, deflation and pause custody stay with the parent.

use std::sync::Arc;
use std::time::Duration;

use guest_control_client::GuestControlClient;
use sandbox::{
    GuestMemorySnapshot, SandboxFinalExecParkHandoff, SandboxFinalExecParkSubstageOutcome,
    SandboxParkNonReusableReason, SandboxParkOutcome, SevereMemoryRetentionDiagnostics,
};
use tracing::{info, warn};

use super::park_admission_action;
use crate::api::{ApiClient, BalloonStatistics};
use crate::balloon;
use crate::duration::duration_ms;

/// Independent deadline for terminal diagnostics on an already-severe park.
pub(super) const GUEST_MEMORY_SNAPSHOT_TIMEOUT: Duration = Duration::from_secs(1);

/// Initial time to wait for balloon inflation before considering an extension.
pub(super) const BALLOON_SETTLE_INITIAL_TIMEOUT: Duration = Duration::from_secs(5);
/// Additional wait when the balloon is still making progress and the
/// guest has enough immediately free or freshly observed available memory to
/// finish reclaiming safely.
pub(super) const BALLOON_SETTLE_PROGRESS_GRACE: Duration = Duration::from_secs(5);
/// Absolute upper bound for balloon inflation across all progress extensions.
pub(super) const BALLOON_SETTLE_MAX_TIMEOUT: Duration = Duration::from_secs(30);
/// Fast-start poll intervals while waiting for balloon inflation.
pub(super) const BALLOON_SETTLE_FAST_POLL_INTERVALS: [Duration; 7] = [
    Duration::from_millis(25),
    Duration::from_millis(50),
    Duration::from_millis(100),
    Duration::from_millis(100),
    Duration::from_millis(100),
    Duration::from_millis(200),
    Duration::from_millis(200),
];
/// Maximum poll interval while waiting for balloon inflation.
const BALLOON_SETTLE_MAX_POLL: Duration = Duration::from_millis(200);
/// Upper bound for accepting residual differences between requested and
/// reported balloon size. Current 4 GiB production profiles commonly settle
/// with low-hundreds MiB residuals when the guest reports little available
/// memory.
const BALLOON_SETTLE_TOLERANCE_CAP_MIB: u32 = 256;
/// Keep the settle tolerance proportional for smaller profiles so tiny balloon
/// targets are not fully swallowed by the 4 GiB cap.
const BALLOON_SETTLE_TOLERANCE_TARGET_DIVISOR: u32 = 8;
const BALLOON_SEVERE_DEFICIT_MIN_MIB: u32 = 256;
const BALLOON_PRESSURE_LIMITED_REASON: &str = "pressure_limited_partial_reclaim";
pub(super) const BYTES_PER_MIB: i64 = 1024 * 1024;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum BalloonProgressExtensionDecision {
    CachedMemory,
    FreshGuestMemory,
    Ineligible(&'static str),
}

pub(super) enum FreshGuestMemorySnapshotResult {
    Snapshot(GuestMemorySnapshot),
    GuestUnavailable,
    RequestFailed,
    Deadline,
    Handoff,
}

pub(super) fn balloon_settle_tolerance_mib(target_mib: u32) -> u32 {
    BALLOON_SETTLE_TOLERANCE_CAP_MIB.min(target_mib / BALLOON_SETTLE_TOLERANCE_TARGET_DIVISOR)
}

#[derive(Debug)]
pub(super) struct BalloonSettleSummary {
    requested_target_mib: u32,
    started_at: tokio::time::Instant,
    sample_count: u32,
    first_observed_target_mib: Option<u32>,
    last_observed_target_mib: Option<u32>,
    target_observed: bool,
    pub(super) first_actual_mib: Option<u32>,
    previous_actual_mib: Option<u32>,
    pub(super) last_actual_mib: Option<u32>,
    pub(super) max_actual_mib: Option<u32>,
    pub(super) last_deficit_mib: Option<u32>,
    pub(super) last_free_memory_bytes: Option<i64>,
    pub(super) last_available_memory_bytes: Option<i64>,
    last_total_memory_bytes: Option<i64>,
    last_swap_in_bytes: Option<i64>,
    last_swap_out_bytes: Option<i64>,
    last_major_faults: Option<i64>,
    last_minor_faults: Option<i64>,
    last_disk_caches_bytes: Option<i64>,
    progress_extension_blocker: Option<&'static str>,
    guest_memory_snapshot_attempted: bool,
    guest_memory_snapshot: Option<GuestMemorySnapshot>,
}

impl BalloonSettleSummary {
    pub(super) fn new(requested_target_mib: u32) -> Self {
        Self {
            requested_target_mib,
            started_at: tokio::time::Instant::now(),
            sample_count: 0,
            first_observed_target_mib: None,
            last_observed_target_mib: None,
            target_observed: false,
            first_actual_mib: None,
            previous_actual_mib: None,
            last_actual_mib: None,
            max_actual_mib: None,
            last_deficit_mib: None,
            last_free_memory_bytes: None,
            last_available_memory_bytes: None,
            last_total_memory_bytes: None,
            last_swap_in_bytes: None,
            last_swap_out_bytes: None,
            last_major_faults: None,
            last_minor_faults: None,
            last_disk_caches_bytes: None,
            progress_extension_blocker: None,
            guest_memory_snapshot_attempted: false,
            guest_memory_snapshot: None,
        }
    }

    pub(super) fn observe(&mut self, stats: &BalloonStatistics) -> u32 {
        let deficit_mib = self.requested_target_mib.saturating_sub(stats.actual_mib);
        self.sample_count = self.sample_count.saturating_add(1);
        self.first_observed_target_mib
            .get_or_insert(stats.target_mib);
        self.last_observed_target_mib = Some(stats.target_mib);
        self.target_observed |= stats.target_mib == self.requested_target_mib;
        self.first_actual_mib.get_or_insert(stats.actual_mib);
        self.previous_actual_mib = self.last_actual_mib;
        self.last_actual_mib = Some(stats.actual_mib);
        self.max_actual_mib = Some(
            self.max_actual_mib
                .map_or(stats.actual_mib, |max| max.max(stats.actual_mib)),
        );
        self.last_deficit_mib = Some(deficit_mib);
        self.last_free_memory_bytes = stats.free_memory;
        self.last_available_memory_bytes = stats.available_memory;
        self.last_total_memory_bytes = stats.total_memory;
        self.last_swap_in_bytes = stats.swap_in;
        self.last_swap_out_bytes = stats.swap_out;
        self.last_major_faults = stats.major_faults;
        self.last_minor_faults = stats.minor_faults;
        self.last_disk_caches_bytes = stats.disk_caches;
        deficit_mib
    }

    fn elapsed_ms(&self) -> u64 {
        duration_ms(self.started_at.elapsed())
    }

    pub(super) fn actual_delta_mib(&self) -> Option<i64> {
        match (self.first_actual_mib, self.last_actual_mib) {
            (Some(first), Some(last)) => Some(i64::from(last) - i64::from(first)),
            _ => None,
        }
    }

    fn reported_free_mib(&self) -> Option<i64> {
        self.last_free_memory_bytes
            .map(|bytes| bytes / BYTES_PER_MIB)
    }

    fn reported_available_mib(&self) -> Option<i64> {
        self.last_available_memory_bytes
            .map(|bytes| bytes / BYTES_PER_MIB)
    }

    fn reported_total_mib(&self) -> Option<i64> {
        self.last_total_memory_bytes
            .map(|bytes| bytes / BYTES_PER_MIB)
    }

    pub(super) fn reason(&self) -> &'static str {
        if self.sample_count == 0 {
            return "stats_unavailable";
        }

        if !self.target_observed {
            return "target_not_observed";
        }

        if self.is_severe_deficit() {
            return "severe_deficit";
        }

        if matches!(
            (self.first_actual_mib, self.last_actual_mib),
            (Some(first), Some(last)) if last > first
        ) {
            return "actual_progressing_timeout";
        }

        "actual_stalled"
    }

    fn is_severe_deficit(&self) -> bool {
        self.target_observed
            && self
                .last_deficit_mib
                .is_some_and(|deficit| deficit >= self.severe_deficit_threshold_mib())
    }

    pub(super) fn progress_extension_decision(&self) -> BalloonProgressExtensionDecision {
        if !self.is_severe_deficit() {
            return BalloonProgressExtensionDecision::Ineligible("not_severe_deficit");
        }

        if self.last_observed_target_mib != Some(self.requested_target_mib) {
            return BalloonProgressExtensionDecision::Ineligible("target_not_current");
        }

        let (Some(previous_actual_mib), Some(last_actual_mib), Some(deficit_mib)) = (
            self.previous_actual_mib,
            self.last_actual_mib,
            self.last_deficit_mib,
        ) else {
            return BalloonProgressExtensionDecision::Ineligible("recent_progress_unavailable");
        };

        if last_actual_mib <= previous_actual_mib {
            return BalloonProgressExtensionDecision::Ineligible("actual_not_progressing");
        }

        let (Some(free_mib), Some(available_mib)) =
            (self.reported_free_mib(), self.reported_available_mib())
        else {
            return BalloonProgressExtensionDecision::Ineligible("memory_stats_unavailable");
        };

        if available_mib < i64::from(deficit_mib) + balloon::PRESSURE_AVAILABLE_MIB {
            return BalloonProgressExtensionDecision::Ineligible(
                "cached_available_reserve_insufficient",
            );
        }

        if free_mib >= i64::from(deficit_mib) {
            BalloonProgressExtensionDecision::CachedMemory
        } else {
            BalloonProgressExtensionDecision::FreshGuestMemory
        }
    }

    pub(super) fn fresh_guest_memory_has_reserve(&self, snapshot: GuestMemorySnapshot) -> bool {
        let Some(deficit_mib) = self.last_deficit_mib else {
            return false;
        };
        let required_mib =
            u64::from(deficit_mib).saturating_add(balloon::PRESSURE_AVAILABLE_MIB as u64);
        snapshot.mem_available_bytes >= required_mib.saturating_mul(BYTES_PER_MIB as u64)
    }

    fn record_terminal_guest_memory_probe(
        &mut self,
        blocker: &'static str,
        snapshot: Option<GuestMemorySnapshot>,
    ) {
        self.progress_extension_blocker = Some(blocker);
        self.guest_memory_snapshot_attempted = true;
        self.guest_memory_snapshot = snapshot;
    }

    pub(super) fn park_outcome(&self) -> SandboxParkOutcome {
        if self.is_severe_deficit() {
            SandboxParkOutcome::NonReusable(SandboxParkNonReusableReason::SevereMemoryRetention(
                Box::new(SevereMemoryRetentionDiagnostics {
                    requested_target_mib: self.requested_target_mib,
                    first_observed_target_mib: self.first_observed_target_mib,
                    observed_target_mib: self.last_observed_target_mib,
                    target_observed: self.target_observed,
                    first_actual_mib: self.first_actual_mib,
                    previous_actual_mib: self.previous_actual_mib,
                    actual_mib: self.last_actual_mib,
                    max_actual_mib: self.max_actual_mib,
                    deficit_mib: self.last_deficit_mib,
                    actual_delta_mib: self.actual_delta_mib(),
                    elapsed_ms: self.elapsed_ms(),
                    sample_count: self.sample_count,
                    reported_free_memory_bytes: self.last_free_memory_bytes,
                    reported_available_memory_bytes: self.last_available_memory_bytes,
                    reported_total_memory_bytes: self.last_total_memory_bytes,
                    reported_swap_in_bytes: self.last_swap_in_bytes,
                    reported_swap_out_bytes: self.last_swap_out_bytes,
                    reported_major_faults: self.last_major_faults,
                    reported_minor_faults: self.last_minor_faults,
                    reported_disk_caches_bytes: self.last_disk_caches_bytes,
                    progress_extension_blocker: self.progress_extension_blocker,
                    guest_memory_snapshot_attempted: self.guest_memory_snapshot_attempted,
                    guest_memory_snapshot: self.guest_memory_snapshot,
                }),
            ))
        } else {
            SandboxParkOutcome::Reusable
        }
    }

    pub(super) fn is_pressure_limited_partial_reclaim(
        &self,
        deficit_mib: u32,
        tolerance_mib: u32,
    ) -> bool {
        deficit_mib > tolerance_mib
            && deficit_mib < self.severe_deficit_threshold_mib()
            && self.target_observed
            && self.is_guest_memory_pressure_limited()
    }

    fn is_guest_memory_pressure_limited(&self) -> bool {
        self.reported_available_mib()
            .is_some_and(|available_mib| available_mib < balloon::PRESSURE_AVAILABLE_MIB)
    }

    fn severe_deficit_threshold_mib(&self) -> u32 {
        BALLOON_SEVERE_DEFICIT_MIN_MIB.max(self.requested_target_mib / 5)
    }
}

fn log_balloon_settle_timeout(
    log_id: &str,
    target_mib: u32,
    tolerance_mib: u32,
    settle_timeout: Duration,
    summary: &BalloonSettleSummary,
    outcome: &SandboxParkOutcome,
) {
    macro_rules! emit_timeout {
        ($level:expr) => {
            tracing::event!(
                $level,
                id = %log_id,
                actual = ?summary.last_actual_mib,
                target = target_mib,
                deficit_mib = ?summary.last_deficit_mib,
                tolerance_mib,
                elapsed_ms = summary.elapsed_ms(),
                sample_count = summary.sample_count,
                requested_target_mib = summary.requested_target_mib,
                first_observed_target_mib = ?summary.first_observed_target_mib,
                observed_target_mib = ?summary.last_observed_target_mib,
                target_observed = summary.target_observed,
                first_actual_mib = ?summary.first_actual_mib,
                previous_actual_mib = ?summary.previous_actual_mib,
                max_actual_mib = ?summary.max_actual_mib,
                actual_delta_mib = ?summary.actual_delta_mib(),
                reported_free_mib = ?summary.reported_free_mib(),
                reported_available_mib = ?summary.reported_available_mib(),
                reported_total_mib = ?summary.reported_total_mib(),
                progress_extension_blocker = ?summary.progress_extension_blocker,
                guest_memory_snapshot_attempted = summary.guest_memory_snapshot_attempted,
                guest_mem_free_bytes = summary
                    .guest_memory_snapshot
                    .map(|snapshot| snapshot.mem_free_bytes),
                guest_mem_available_bytes = summary
                    .guest_memory_snapshot
                    .map(|snapshot| snapshot.mem_available_bytes),
                reason = summary.reason(),
                admission_action = park_admission_action(outcome),
                "balloon inflate incomplete after {}s, pausing anyway",
                settle_timeout.as_secs()
            );
        };
    }

    if summary.reason() == "actual_progressing_timeout"
        && matches!(outcome, SandboxParkOutcome::Reusable)
    {
        emit_timeout!(tracing::Level::INFO);
    } else {
        emit_timeout!(tracing::Level::WARN);
    }
}

fn log_balloon_settle_progress_grace(
    log_id: &str,
    target_mib: u32,
    progress_grace: Duration,
    remaining_progress_grace: Duration,
    summary: &BalloonSettleSummary,
    memory_evidence: &'static str,
    fresh_guest_memory_snapshot: Option<GuestMemorySnapshot>,
) {
    info!(
        id = %log_id,
        actual = ?summary.last_actual_mib,
        target = target_mib,
        deficit_mib = ?summary.last_deficit_mib,
        elapsed_ms = summary.elapsed_ms(),
        sample_count = summary.sample_count,
        previous_actual_mib = ?summary.previous_actual_mib,
        reported_free_mib = ?summary.reported_free_mib(),
        reported_available_mib = ?summary.reported_available_mib(),
        memory_evidence,
        guest_mem_free_bytes = fresh_guest_memory_snapshot
            .map(|snapshot| snapshot.mem_free_bytes),
        guest_mem_available_bytes = fresh_guest_memory_snapshot
            .map(|snapshot| snapshot.mem_available_bytes),
        grace_ms = duration_ms(progress_grace),
        remaining_grace_ms = duration_ms(remaining_progress_grace),
        "balloon inflation still progressing, extending settle deadline"
    );
}

fn balloon_settle_deadline_result(
    log_id: &str,
    target_mib: u32,
    tolerance_mib: u32,
    settle_timeout: Duration,
    summary: &BalloonSettleSummary,
) -> BalloonSettleWaitResult {
    let outcome = summary.park_outcome();
    log_balloon_settle_timeout(
        log_id,
        target_mib,
        tolerance_mib,
        settle_timeout,
        summary,
        &outcome,
    );
    BalloonSettleWaitResult::Settled(BalloonSettleResult {
        park_outcome: outcome,
        telemetry_outcome: SandboxFinalExecParkSubstageOutcome::Deadline,
    })
}

pub(super) async fn fresh_guest_memory_snapshot_for_progress(
    guest: Option<&Arc<tokio::sync::Mutex<Option<Arc<GuestControlClient>>>>>,
    log_id: &str,
    max_deadline: tokio::time::Instant,
    handoff: Option<&SandboxFinalExecParkHandoff>,
) -> FreshGuestMemorySnapshotResult {
    let request = tokio::time::timeout_at(max_deadline, async {
        let Some(guest) = guest else {
            return FreshGuestMemorySnapshotResult::GuestUnavailable;
        };
        let Some(guest) = guest.lock().await.as_ref().cloned() else {
            return FreshGuestMemorySnapshotResult::GuestUnavailable;
        };
        let request_timeout = GUEST_MEMORY_SNAPSHOT_TIMEOUT
            .min(max_deadline.saturating_duration_since(tokio::time::Instant::now()));
        if request_timeout.is_zero() {
            return FreshGuestMemorySnapshotResult::Deadline;
        }
        match guest.memory_snapshot(request_timeout).await {
            Ok(snapshot) => {
                FreshGuestMemorySnapshotResult::Snapshot(guest_memory_snapshot(snapshot))
            }
            Err(error) => {
                info!(
                    id = %log_id,
                    %error,
                    "fresh guest memory snapshot unavailable for balloon progress extension"
                );
                FreshGuestMemorySnapshotResult::RequestFailed
            }
        }
    });
    tokio::pin!(request);

    match handoff {
        Some(handoff) => {
            tokio::select! {
                biased;
                accepted = handoff.wait_and_accept() => {
                    if accepted {
                        FreshGuestMemorySnapshotResult::Handoff
                    } else {
                        match request.await {
                            Ok(result) => result,
                            Err(_) => FreshGuestMemorySnapshotResult::Deadline,
                        }
                    }
                }
                result = request.as_mut() => match result {
                    Ok(result) => result,
                    Err(_) => FreshGuestMemorySnapshotResult::Deadline,
                },
            }
        }
        None => match request.await {
            Ok(result) => result,
            Err(_) => FreshGuestMemorySnapshotResult::Deadline,
        },
    }
}

#[derive(Debug)]
pub(super) struct BalloonSettleResult {
    pub(super) park_outcome: SandboxParkOutcome,
    pub(super) telemetry_outcome: SandboxFinalExecParkSubstageOutcome,
}

pub(super) enum BalloonSettleWaitResult {
    Settled(BalloonSettleResult),
    Handoff,
}

/// Wait until the guest balloon driver inflates close enough to `target_mib`.
///
/// The guest needs running vCPUs to inflate, so this must be called
/// **before** pausing. Returns when `actual_mib >= target_mib`, when
/// the remaining deficit is within [`balloon_settle_tolerance_mib`],
/// when guest pressure indicates further reclaim is unsafe, or after
/// [`BALLOON_SETTLE_INITIAL_TIMEOUT`]. A severe deficit that is still progressing
/// with enough cached or freshly observed guest memory gets repeated
/// [`BALLOON_SETTLE_PROGRESS_GRACE`] extensions up to
/// [`BALLOON_SETTLE_MAX_TIMEOUT`]. The returned outcome rejects only the existing
/// severe-deficit classification. Errors from stats fetching are non-fatal —
/// we log and proceed to pause.
#[cfg(test)]
pub(super) async fn wait_for_balloon_with_outcome(
    client: &ApiClient,
    target_mib: u32,
    log_id: &str,
) -> BalloonSettleResult {
    match wait_for_balloon_with_optional_handoff(client, target_mib, log_id, None, None).await {
        BalloonSettleWaitResult::Settled(result) => result,
        BalloonSettleWaitResult::Handoff => panic!("handoff signal was not provided"),
    }
}

pub(super) async fn wait_for_balloon_with_optional_handoff(
    client: &ApiClient,
    target_mib: u32,
    log_id: &str,
    guest: Option<&Arc<tokio::sync::Mutex<Option<Arc<GuestControlClient>>>>>,
    handoff: Option<&SandboxFinalExecParkHandoff>,
) -> BalloonSettleWaitResult {
    let tolerance_mib = balloon_settle_tolerance_mib(target_mib);
    let mut summary = BalloonSettleSummary::new(target_mib);
    let mut settle_timeout = BALLOON_SETTLE_INITIAL_TIMEOUT;
    let mut deadline = summary.started_at + settle_timeout;
    let max_deadline = summary.started_at + BALLOON_SETTLE_MAX_TIMEOUT;
    let mut fast_poll_intervals = BALLOON_SETTLE_FAST_POLL_INTERVALS.into_iter();
    loop {
        let now = tokio::time::Instant::now();
        if now >= deadline {
            if now >= max_deadline {
                summary.progress_extension_blocker = Some("absolute_deadline");
                return balloon_settle_deadline_result(
                    log_id,
                    target_mib,
                    tolerance_mib,
                    settle_timeout,
                    &summary,
                );
            }

            let (memory_evidence, fresh_guest_memory_snapshot) =
                match summary.progress_extension_decision() {
                    BalloonProgressExtensionDecision::CachedMemory => ("cached_firecracker", None),
                    BalloonProgressExtensionDecision::FreshGuestMemory => {
                        match fresh_guest_memory_snapshot_for_progress(
                            guest,
                            log_id,
                            max_deadline,
                            handoff,
                        )
                        .await
                        {
                            FreshGuestMemorySnapshotResult::Snapshot(snapshot)
                                if summary.fresh_guest_memory_has_reserve(snapshot) =>
                            {
                                ("fresh_guest", Some(snapshot))
                            }
                            FreshGuestMemorySnapshotResult::Snapshot(snapshot) => {
                                summary.record_terminal_guest_memory_probe(
                                    "fresh_guest_available_reserve_insufficient",
                                    Some(snapshot),
                                );
                                return balloon_settle_deadline_result(
                                    log_id,
                                    target_mib,
                                    tolerance_mib,
                                    settle_timeout,
                                    &summary,
                                );
                            }
                            FreshGuestMemorySnapshotResult::GuestUnavailable => {
                                summary.record_terminal_guest_memory_probe(
                                    "fresh_guest_unavailable",
                                    None,
                                );
                                return balloon_settle_deadline_result(
                                    log_id,
                                    target_mib,
                                    tolerance_mib,
                                    settle_timeout,
                                    &summary,
                                );
                            }
                            FreshGuestMemorySnapshotResult::RequestFailed => {
                                summary.record_terminal_guest_memory_probe(
                                    "fresh_guest_snapshot_failed",
                                    None,
                                );
                                return balloon_settle_deadline_result(
                                    log_id,
                                    target_mib,
                                    tolerance_mib,
                                    settle_timeout,
                                    &summary,
                                );
                            }
                            FreshGuestMemorySnapshotResult::Deadline => {
                                summary.record_terminal_guest_memory_probe(
                                    "fresh_guest_snapshot_deadline",
                                    None,
                                );
                                return balloon_settle_deadline_result(
                                    log_id,
                                    target_mib,
                                    tolerance_mib,
                                    settle_timeout,
                                    &summary,
                                );
                            }
                            FreshGuestMemorySnapshotResult::Handoff => {
                                return BalloonSettleWaitResult::Handoff;
                            }
                        }
                    }
                    BalloonProgressExtensionDecision::Ineligible(blocker) => {
                        summary.progress_extension_blocker = Some(blocker);
                        return balloon_settle_deadline_result(
                            log_id,
                            target_mib,
                            tolerance_mib,
                            settle_timeout,
                            &summary,
                        );
                    }
                };

            let previous_deadline = deadline;
            let next_deadline =
                (previous_deadline + BALLOON_SETTLE_PROGRESS_GRACE).min(max_deadline);
            let now = tokio::time::Instant::now();
            if now >= next_deadline {
                summary.progress_extension_blocker = Some("absolute_deadline");
                return balloon_settle_deadline_result(
                    log_id,
                    target_mib,
                    tolerance_mib,
                    settle_timeout,
                    &summary,
                );
            }
            let progress_grace = next_deadline - previous_deadline;
            let remaining_progress_grace = next_deadline - now;
            deadline = next_deadline;
            settle_timeout = deadline - summary.started_at;
            summary.progress_extension_blocker = None;
            log_balloon_settle_progress_grace(
                log_id,
                target_mib,
                progress_grace,
                remaining_progress_grace,
                &summary,
                memory_evidence,
                fresh_guest_memory_snapshot,
            );
        }

        let statistics = match handoff {
            Some(handoff) => {
                tokio::select! {
                    biased;
                    accepted = handoff.wait_and_accept() => {
                        if accepted {
                            return BalloonSettleWaitResult::Handoff;
                        }
                        tokio::time::timeout_at(deadline, client.get_balloon_statistics()).await
                    }
                    statistics = tokio::time::timeout_at(deadline, client.get_balloon_statistics()) => statistics,
                }
            }
            None => tokio::time::timeout_at(deadline, client.get_balloon_statistics()).await,
        };
        match statistics {
            Ok(Ok(stats)) => {
                let deficit_mib = summary.observe(&stats);
                if deficit_mib == 0 {
                    info!(
                        id = %log_id,
                        actual = stats.actual_mib,
                        target = target_mib,
                        deficit_mib,
                        tolerance_mib,
                        elapsed_ms = summary.elapsed_ms(),
                        sample_count = summary.sample_count,
                        requested_target_mib = summary.requested_target_mib,
                        first_observed_target_mib = ?summary.first_observed_target_mib,
                        observed_target_mib = ?summary.last_observed_target_mib,
                        target_observed = summary.target_observed,
                        first_actual_mib = ?summary.first_actual_mib,
                        max_actual_mib = ?summary.max_actual_mib,
                        actual_delta_mib = ?summary.actual_delta_mib(),
                        reported_free_mib = ?summary.reported_free_mib(),
                        reported_available_mib = ?summary.reported_available_mib(),
                        reported_total_mib = ?summary.reported_total_mib(),
                        "balloon fully inflated, proceeding to pause"
                    );
                    return BalloonSettleWaitResult::Settled(BalloonSettleResult {
                        park_outcome: SandboxParkOutcome::Reusable,
                        telemetry_outcome: SandboxFinalExecParkSubstageOutcome::TargetReached,
                    });
                }

                if deficit_mib <= tolerance_mib {
                    info!(
                        id = %log_id,
                        actual = stats.actual_mib,
                        target = target_mib,
                        deficit_mib,
                        tolerance_mib,
                        elapsed_ms = summary.elapsed_ms(),
                        sample_count = summary.sample_count,
                        requested_target_mib = summary.requested_target_mib,
                        first_observed_target_mib = ?summary.first_observed_target_mib,
                        observed_target_mib = ?summary.last_observed_target_mib,
                        target_observed = summary.target_observed,
                        first_actual_mib = ?summary.first_actual_mib,
                        max_actual_mib = ?summary.max_actual_mib,
                        actual_delta_mib = ?summary.actual_delta_mib(),
                        reported_free_mib = ?summary.reported_free_mib(),
                        reported_available_mib = ?summary.reported_available_mib(),
                        reported_total_mib = ?summary.reported_total_mib(),
                        "balloon inflated within tolerance, proceeding to pause"
                    );
                    return BalloonSettleWaitResult::Settled(BalloonSettleResult {
                        park_outcome: SandboxParkOutcome::Reusable,
                        telemetry_outcome: SandboxFinalExecParkSubstageOutcome::WithinTolerance,
                    });
                }

                if summary.is_pressure_limited_partial_reclaim(deficit_mib, tolerance_mib) {
                    info!(
                        id = %log_id,
                        actual = stats.actual_mib,
                        target = target_mib,
                        deficit_mib,
                        tolerance_mib,
                        elapsed_ms = summary.elapsed_ms(),
                        sample_count = summary.sample_count,
                        requested_target_mib = summary.requested_target_mib,
                        first_observed_target_mib = ?summary.first_observed_target_mib,
                        observed_target_mib = ?summary.last_observed_target_mib,
                        target_observed = summary.target_observed,
                        first_actual_mib = ?summary.first_actual_mib,
                        max_actual_mib = ?summary.max_actual_mib,
                        actual_delta_mib = ?summary.actual_delta_mib(),
                        reported_free_mib = ?summary.reported_free_mib(),
                        reported_available_mib = ?summary.reported_available_mib(),
                        reported_total_mib = ?summary.reported_total_mib(),
                        reason = BALLOON_PRESSURE_LIMITED_REASON,
                        "balloon pressure-limited partial reclaim, proceeding to pause"
                    );
                    return BalloonSettleWaitResult::Settled(BalloonSettleResult {
                        park_outcome: SandboxParkOutcome::Reusable,
                        telemetry_outcome: SandboxFinalExecParkSubstageOutcome::PressureLimited,
                    });
                }

                // Balloon timing tests advance paused time only after a completed stats sample.
                #[cfg(test)]
                tracing::event!(tracing::Level::TRACE, "waiting for balloon");
            }
            Ok(Err(e)) => {
                summary.progress_extension_blocker = Some("balloon_stats_unavailable");
                let outcome = summary.park_outcome();
                warn!(
                    id = %log_id,
                    actual = ?summary.last_actual_mib,
                    target = target_mib,
                    deficit_mib = ?summary.last_deficit_mib,
                    tolerance_mib,
                    elapsed_ms = summary.elapsed_ms(),
                    sample_count = summary.sample_count,
                    requested_target_mib = summary.requested_target_mib,
                    first_observed_target_mib = ?summary.first_observed_target_mib,
                    observed_target_mib = ?summary.last_observed_target_mib,
                    target_observed = summary.target_observed,
                    first_actual_mib = ?summary.first_actual_mib,
                    max_actual_mib = ?summary.max_actual_mib,
                    actual_delta_mib = ?summary.actual_delta_mib(),
                    reported_free_mib = ?summary.reported_free_mib(),
                    reported_available_mib = ?summary.reported_available_mib(),
                    reported_total_mib = ?summary.reported_total_mib(),
                    reason = summary.reason(),
                    admission_action = park_admission_action(&outcome),
                    %e,
                    "balloon stats unavailable, proceeding to pause"
                );
                return BalloonSettleWaitResult::Settled(BalloonSettleResult {
                    park_outcome: outcome,
                    telemetry_outcome: SandboxFinalExecParkSubstageOutcome::StatsUnavailable,
                });
            }
            Err(_) => {
                summary.progress_extension_blocker =
                    Some(if tokio::time::Instant::now() >= max_deadline {
                        "absolute_deadline"
                    } else {
                        "balloon_stats_deadline"
                    });
                return balloon_settle_deadline_result(
                    log_id,
                    target_mib,
                    tolerance_mib,
                    settle_timeout,
                    &summary,
                );
            }
        }

        let poll_interval = fast_poll_intervals
            .next()
            .unwrap_or(BALLOON_SETTLE_MAX_POLL);
        let next_poll = tokio::time::Instant::now() + poll_interval;
        let sleep = tokio::time::sleep_until(if next_poll < deadline {
            next_poll
        } else {
            deadline
        });
        tokio::pin!(sleep);
        match handoff {
            Some(handoff) => {
                tokio::select! {
                    biased;
                    accepted = handoff.wait_and_accept() => {
                        if accepted {
                            return BalloonSettleWaitResult::Handoff;
                        }
                        sleep.as_mut().await;
                    }
                    () = sleep.as_mut() => {}
                }
            }
            None => sleep.as_mut().await,
        }
    }
}

pub(super) fn guest_memory_snapshot(
    snapshot: guest_control_proto::MemorySnapshot,
) -> GuestMemorySnapshot {
    GuestMemorySnapshot {
        mem_total_bytes: snapshot.mem_total_bytes,
        mem_free_bytes: snapshot.mem_free_bytes,
        mem_available_bytes: snapshot.mem_available_bytes,
        buffers_bytes: snapshot.buffers_bytes,
        cached_bytes: snapshot.cached_bytes,
        anon_pages_bytes: snapshot.anon_pages_bytes,
        mapped_bytes: snapshot.mapped_bytes,
        dirty_bytes: snapshot.dirty_bytes,
        writeback_bytes: snapshot.writeback_bytes,
        shmem_bytes: snapshot.shmem_bytes,
        slab_bytes: snapshot.slab_bytes,
        slab_reclaimable_bytes: snapshot.slab_reclaimable_bytes,
        slab_unreclaimable_bytes: snapshot.slab_unreclaimable_bytes,
        unevictable_bytes: snapshot.unevictable_bytes,
        kernel_stack_bytes: snapshot.kernel_stack_bytes,
        page_tables_bytes: snapshot.page_tables_bytes,
        swap_total_bytes: snapshot.swap_total_bytes,
        swap_free_bytes: snapshot.swap_free_bytes,
    }
}

pub(super) async fn terminal_guest_memory_snapshot(
    guest: &Arc<tokio::sync::Mutex<Option<Arc<GuestControlClient>>>>,
    log_id: &str,
) -> Option<GuestMemorySnapshot> {
    let Some(guest) = guest.lock().await.as_ref().cloned() else {
        warn!(
            id = %log_id,
            reason = "guest_unavailable",
            "guest memory snapshot unavailable after severe balloon retention"
        );
        return None;
    };
    match guest.memory_snapshot(GUEST_MEMORY_SNAPSHOT_TIMEOUT).await {
        Ok(snapshot) => Some(guest_memory_snapshot(snapshot)),
        Err(error) => {
            warn!(
                id = %log_id,
                reason = "snapshot_request_failed",
                %error,
                "guest memory snapshot unavailable after severe balloon retention"
            );
            None
        }
    }
}
