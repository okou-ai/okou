//! Content-free home dimensions carried by ordinary sandbox operations.

use std::fmt;
use std::path::Path;

use runner_types::ids::RunId;
use serde::Serialize;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum HomeObservationKind {
    #[serde(rename = "runner_home_preservation")]
    Preservation,
    #[serde(rename = "runner_home_image_publication")]
    Publication,
    #[serde(rename = "runner_home_image_consumption")]
    Consumption,
    #[serde(rename = "runner_home_image_removal")]
    Removal,
    #[serde(rename = "runner_home_inventory")]
    Inventory,
    #[serde(rename = "runner_home_admission")]
    Admission,
}

impl fmt::Display for HomeObservationKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Preservation => "runner_home_preservation",
            Self::Publication => "runner_home_image_publication",
            Self::Consumption => "runner_home_image_consumption",
            Self::Removal => "runner_home_image_removal",
            Self::Inventory => "runner_home_inventory",
            Self::Admission => "runner_home_admission",
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HomeObservationOutcome {
    Selected,
    Busy,
    Unavailable,
    Retained,
    Published,
    PreservedExisting,
    Skipped,
    Failed,
    Fallback,
    Deleted,
    Assembled,
    Loading,
    Deferred,
}

impl fmt::Display for HomeObservationOutcome {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Selected => "selected",
            Self::Busy => "busy",
            Self::Unavailable => "unavailable",
            Self::Retained => "retained",
            Self::Published => "published",
            Self::PreservedExisting => "preserved_existing",
            Self::Skipped => "skipped",
            Self::Failed => "failed",
            Self::Fallback => "fallback",
            Self::Deleted => "deleted",
            Self::Assembled => "assembled",
            Self::Loading => "loading",
            Self::Deferred => "deferred",
        })
    }
}

/// Facts already held by a resource owner. Missing evidence stays absent;
/// observations never grant resource or deletion authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HomeObservation {
    #[serde(skip)]
    pub kind: HomeObservationKind,
    #[serde(skip)]
    pub outcome: HomeObservationOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<RunId>,
    #[serde(skip)]
    pub is_first_run: Option<bool>,
    #[serde(skip)]
    pub reuse_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_generation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allocated_bytes: Option<u64>,
    #[serde(skip)]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handoff_path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runner_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub runner_heartbeat_generation: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inventory_loaded: Option<bool>,
    /// States assembled before active/profile filtering and the heartbeat cap.
    /// Earlier snapshot truncation is outside this observation's scope.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inventory_observed_states: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inventory_output_states: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub inventory_omitted_states: Option<usize>,
}

impl HomeObservation {
    pub fn new(kind: HomeObservationKind, outcome: HomeObservationOutcome) -> Self {
        Self {
            kind,
            outcome,
            run_id: None,
            is_first_run: None,
            reuse_key: None,
            cache_key: None,
            profile_name: None,
            image_generation: None,
            allocated_bytes: None,
            reason: None,
            handoff_path: None,
            runner_id: None,
            runner_heartbeat_generation: None,
            inventory_loaded: None,
            inventory_observed_states: None,
            inventory_output_states: None,
            inventory_omitted_states: None,
        }
    }
}

/// Borrowed diagnostics for the local logger only, excluded from remote facts.
#[derive(Default)]
pub struct HomeObservationLocalDetails<'a> {
    pub detail: Option<&'a str>,
    pub path: Option<&'a Path>,
}

impl HomeObservation {
    pub fn log_local(&self, details: HomeObservationLocalDetails<'_>) {
        tracing::info!(
            target: "runner::home_observation",
            op_type = %self.kind,
            outcome = %self.outcome,
            run_id = self.run_id.as_ref().map(tracing::field::display),
            is_first_run = self.is_first_run,
            reuse_key = self.reuse_key.as_deref(),
            cache_key = self.cache_key.as_deref(),
            profile_name = self.profile_name.as_deref(),
            image_generation = self.image_generation.as_deref(),
            allocated_bytes = self.allocated_bytes,
            reason = self.reason.as_deref(),
            handoff_path = self.handoff_path.as_deref(),
            runner_id = self.runner_id.as_deref(),
            runner_heartbeat_generation = self.runner_heartbeat_generation,
            inventory_loaded = self.inventory_loaded,
            inventory_observed_states = self.inventory_observed_states,
            inventory_output_states = self.inventory_output_states,
            inventory_omitted_states = self.inventory_omitted_states,
            local_detail = details.detail,
            local_path = details.path.map(|path| tracing::field::display(path.display())),
            "home resource observation"
        );
    }
}
