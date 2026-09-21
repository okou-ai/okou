//! Process-local shadow observations for likely storage-baseline candidates.
//!
//! The observer measures whether the exact set of entries marked as baseline candidates is stable
//! across consecutive jobs. It is an observational telemetry aid only: its result does not affect
//! storage selection, materialization, cache reuse, or any other execution decision.
//!
//! In production, the observer is owned by [`super::ExecutorConfig`], so its state is local to the
//! Runner process and resets when the Runner restarts. The previous candidate set is kept separately
//! for each configured profile and [`EffectiveCliFramework`]. Candidate identities remain in this
//! process-local state only; they are not emitted to telemetry, persisted, hashed, or transformed
//! into stable pseudonyms.

use std::collections::HashMap;
use std::sync::Mutex;

use super::JobParams;
use super::cli_framework::{EffectiveCliFramework, effective_cli_framework};
use crate::storage_manifest::StorageEntry;
use crate::telemetry::JobTelemetry;
use crate::types::ExecutionContext;

const STABILITY_ACTION: &str = "runner_storage_baseline_candidate_stability";
const CANDIDATE_COUNT_ACTION: &str = "runner_storage_baseline_candidate_count";
const ADDED_COUNT_ACTION: &str = "runner_storage_baseline_added_count";
const REMOVED_COUNT_ACTION: &str = "runner_storage_baseline_removed_count";
const CHANGED_AT_PATH_COUNT_ACTION: &str = "runner_storage_baseline_changed_at_path_count";

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
/// The exact identity used when comparing one baseline-candidate mount.
///
/// The identity consists of the mount path, VAS storage name, VAS version ID, and optional
/// instructions target filename. Other [`StorageEntry`] fields, including the archive URL and
/// size, do not participate in this observation. The derived [`Ord`] implementation provides the
/// deterministic ordering used for the candidate vector before it is compared with the previous
/// observation.
struct CandidateIdentity {
    mount_path: String,
    vas_storage_name: String,
    vas_version_id: String,
    instructions_target_filename: Option<String>,
}

impl From<&StorageEntry> for CandidateIdentity {
    fn from(entry: &StorageEntry) -> Self {
        Self {
            mount_path: entry.mount_path.clone(),
            vas_storage_name: entry.vas_storage_name.clone(),
            vas_version_id: entry.vas_version_id.clone(),
            instructions_target_filename: entry.instructions_target_filename.clone(),
        }
    }
}

#[derive(Debug, PartialEq, Eq, Hash)]
/// Scope of a process-local previous candidate set.
///
/// Observations are independent for each configured profile and effective CLI framework. The
/// framework is the normalized [`EffectiveCliFramework`] value, rather than the raw CLI-agent
/// string: `codex` maps to `Codex`, `pi` maps to `Pi`, and empty, `claude-code`, or unrecognized
/// values map to `ClaudeCode`.
struct ObservationKey {
    profile_name: String,
    framework: EffectiveCliFramework,
}

struct Observation {
    outcome: &'static str,
    candidate_count: usize,
    added_count: usize,
    removed_count: usize,
    changed_at_path_count: usize,
}

#[derive(Default)]
/// Process-local observer for exact baseline-candidate stability.
///
/// The previous candidate vector is protected by one mutex so concurrent executor entry points
/// observe and replace a key's state atomically. The production instance lives in
/// [`super::ExecutorConfig`], which gives the observation its Runner-process lifetime; a new
/// process (or a newly constructed observer) starts without a previous observation. The stored
/// [`CandidateIdentity`] values never leave this in-memory map and are not serialized, logged,
/// persisted, hashed, or converted to stable pseudonyms.
pub(crate) struct StorageBaselineObserver {
    previous: Mutex<HashMap<ObservationKey, Vec<CandidateIdentity>>>,
    #[cfg(test)]
    test_probe: Option<Box<dyn Fn(BaselineObservationTestEvent) + Send + Sync>>,
}

runner_test_support!(executor; #[cfg(test)]
#[derive(Debug, PartialEq, Eq)]
pub(super) enum BaselineObservationTestEvent {
    BeforeLock { contended: bool },
    BeforeFirstInsert,
});

impl StorageBaselineObserver {
    runner_test_support!(executor; #[cfg(test)]
    pub(super) fn with_test_probe(
        probe: impl Fn(BaselineObservationTestEvent) + Send + Sync + 'static,
    ) -> Self {
        Self {
            test_probe: Some(Box::new(probe)),
            ..Self::default()
        }
    });

    /// Record the current baseline-candidate observation and its bounded telemetry dimensions.
    ///
    /// Only read-only manifest entries with `baseline_candidate` set are considered. Their
    /// [`CandidateIdentity`] values are sorted before comparison, so incoming manifest order does
    /// not affect the result. For a given [`ObservationKey`], the stability outcome is:
    ///
    /// - `first` when this is the first non-empty candidate set; it becomes the previous set and
    ///   all change counts are zero.
    /// - `same` when the sorted candidate set exactly matches the previous set; all change counts
    ///   are zero and the previous set is retained.
    /// - `changed` when a non-empty candidate set differs from the previous set; the new set
    ///   replaces the previous set.
    /// - `none` when there are no candidates; all counts are zero and the previous non-empty set is
    ///   not replaced.
    ///
    /// For `changed`, `candidate_count` is the number of current candidates. `added_count` counts
    /// current candidates whose mount path was absent from the previous set, `removed_count` counts
    /// previous candidates whose mount path is absent from the current set, and
    /// `changed_at_path_count` counts current candidates whose mount path exists in both sets but
    /// whose complete identity differs. Each count is recorded using the fixed labels `0`, `1`,
    /// `2`, `3_4`, `5_8`, `9_16`, or `17_plus`.
    ///
    /// The stability outcome is emitted as
    /// `runner_storage_baseline_candidate_stability`; the four count dimensions are emitted as
    /// `runner_storage_baseline_candidate_count`, `runner_storage_baseline_added_count`,
    /// `runner_storage_baseline_removed_count`, and
    /// `runner_storage_baseline_changed_at_path_count`. These are bounded telemetry dimensions;
    /// no candidate identity is included. This method does not affect storage selection,
    /// materialization, or any other execution behavior.
    pub(crate) fn record(
        &self,
        context: &ExecutionContext,
        params: &JobParams,
        telemetry: &mut JobTelemetry,
    ) {
        let mut candidates = context
            .storage_manifest
            .iter()
            .flat_map(|manifest| &manifest.storages)
            .filter(|entry| entry.baseline_candidate)
            .map(CandidateIdentity::from)
            .collect::<Vec<_>>();
        candidates.sort_unstable();

        let observation = if candidates.is_empty() {
            Observation {
                outcome: "none",
                candidate_count: 0,
                added_count: 0,
                removed_count: 0,
                changed_at_path_count: 0,
            }
        } else {
            self.observe_marked(
                ObservationKey {
                    profile_name: params.profile_name.clone(),
                    framework: effective_cli_framework(&context.cli_agent_type),
                },
                candidates,
            )
        };

        telemetry.record_bounded_outcome(STABILITY_ACTION, true, observation.outcome, None);
        for (action, count) in [
            (CANDIDATE_COUNT_ACTION, observation.candidate_count),
            (ADDED_COUNT_ACTION, observation.added_count),
            (REMOVED_COUNT_ACTION, observation.removed_count),
            (
                CHANGED_AT_PATH_COUNT_ACTION,
                observation.changed_at_path_count,
            ),
        ] {
            telemetry.record_bounded_outcome(action, true, count_bucket(count), None);
        }
    }

    fn observe_marked(
        &self,
        key: ObservationKey,
        candidates: Vec<CandidateIdentity>,
    ) -> Observation {
        let candidate_count = candidates.len();
        #[cfg(test)]
        if let Some(probe) = &self.test_probe {
            // Drop any acquired guard before the probe coordinates another caller.
            let contended = matches!(
                self.previous.try_lock(),
                Err(std::sync::TryLockError::WouldBlock)
            );
            probe(BaselineObservationTestEvent::BeforeLock { contended });
        }
        let mut previous_by_key = self
            .previous
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(previous) = previous_by_key.get_mut(&key) else {
            #[cfg(test)]
            if let Some(probe) = &self.test_probe {
                probe(BaselineObservationTestEvent::BeforeFirstInsert);
            }
            previous_by_key.insert(key, candidates);
            return Observation {
                outcome: "first",
                candidate_count,
                added_count: 0,
                removed_count: 0,
                changed_at_path_count: 0,
            };
        };

        if *previous == candidates {
            return Observation {
                outcome: "same",
                candidate_count,
                added_count: 0,
                removed_count: 0,
                changed_at_path_count: 0,
            };
        }

        let added_count = candidates
            .iter()
            .filter(|candidate| {
                previous
                    .iter()
                    .all(|entry| entry.mount_path != candidate.mount_path)
            })
            .count();
        let removed_count = previous
            .iter()
            .filter(|entry| {
                candidates
                    .iter()
                    .all(|candidate| candidate.mount_path != entry.mount_path)
            })
            .count();
        let changed_at_path_count = candidates
            .iter()
            .filter(|candidate| {
                previous
                    .iter()
                    .any(|entry| entry.mount_path == candidate.mount_path && entry != *candidate)
            })
            .count();
        *previous = candidates;

        Observation {
            outcome: "changed",
            candidate_count,
            added_count,
            removed_count,
            changed_at_path_count,
        }
    }
}

/// Convert a raw count to the fixed low-cardinality telemetry label set.
///
/// The labels represent the exact ranges `0`, `1`, `2`, `3..=4`, `5..=8`, `9..=16`, and `17+`,
/// respectively.
fn count_bucket(count: usize) -> &'static str {
    match count {
        0 => "0",
        1 => "1",
        2 => "2",
        3 | 4 => "3_4",
        5..=8 => "5_8",
        9..=16 => "9_16",
        _ => "17_plus",
    }
}
