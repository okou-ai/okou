//! Resource facts written to the existing local logger and optional remote sink.

use std::fmt;
use std::path::Path;
use std::sync::Arc;

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
}

impl fmt::Display for HomeObservationKind {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Preservation => "runner_home_preservation",
            Self::Publication => "runner_home_image_publication",
            Self::Consumption => "runner_home_image_consumption",
            Self::Removal => "runner_home_image_removal",
        })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum HomeObservationOutcome {
    Retained,
    Published,
    PreservedExisting,
    Skipped,
    Failed,
    Fallback,
    Deleted,
}

impl fmt::Display for HomeObservationOutcome {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Retained => "retained",
            Self::Published => "published",
            Self::PreservedExisting => "preserved_existing",
            Self::Skipped => "skipped",
            Self::Failed => "failed",
            Self::Fallback => "fallback",
            Self::Deleted => "deleted",
        })
    }
}

/// Facts already held by a resource owner. Missing evidence stays absent;
/// observations never grant resource or deletion authority.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct HomeObservation {
    #[serde(rename = "event_type")]
    pub kind: HomeObservationKind,
    pub outcome: HomeObservationOutcome,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub run_id: Option<RunId>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reuse_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cache_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub profile_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_generation: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub allocated_bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub handoff_path: Option<String>,
}

impl HomeObservation {
    pub fn new(kind: HomeObservationKind, outcome: HomeObservationOutcome) -> Self {
        Self {
            kind,
            outcome,
            run_id: None,
            reuse_key: None,
            cache_key: None,
            profile_name: None,
            image_generation: None,
            allocated_bytes: None,
            reason: None,
            handoff_path: None,
        }
    }
}

/// Implementations enqueue synchronously without waiting for transport,
/// retaining resources, or changing the caller's outcome.
pub trait HomeObservationSink: Send + Sync {
    fn observe(&self, observation: HomeObservation);
}

/// Borrowed diagnostics for the local logger only, excluded from remote facts.
#[derive(Default)]
pub struct HomeObservationLocalDetails<'a> {
    pub detail: Option<&'a str>,
    pub path: Option<&'a Path>,
}

#[derive(Clone, Default)]
pub struct HomeObservationHandle {
    sink: Option<Arc<dyn HomeObservationSink>>,
}

impl HomeObservationHandle {
    pub fn new(sink: Arc<dyn HomeObservationSink>) -> Self {
        Self { sink: Some(sink) }
    }

    pub fn observe(&self, observation: HomeObservation) {
        self.observe_with_local_details(observation, HomeObservationLocalDetails::default());
    }

    pub fn observe_with_local_details(
        &self,
        observation: HomeObservation,
        details: HomeObservationLocalDetails<'_>,
    ) {
        // Local evidence survives an unconfigured or dropping remote sink. The
        // uniform WARN+ Axiom tracing filter excludes this INFO event, so the
        // typed sink remains the sole remote producer of this resource fact.
        tracing::info!(
            target: "runner::home_observation",
            event_type = %observation.kind,
            outcome = %observation.outcome,
            run_id = observation.run_id.as_ref().map(tracing::field::display),
            reuse_key = observation.reuse_key.as_deref(),
            cache_key = observation.cache_key.as_deref(),
            profile_name = observation.profile_name.as_deref(),
            image_generation = observation.image_generation.as_deref(),
            allocated_bytes = observation.allocated_bytes,
            reason = observation.reason.as_deref(),
            handoff_path = observation.handoff_path.as_deref(),
            local_detail = details.detail,
            local_path = details.path.map(|path| tracing::field::display(path.display())),
            "home resource observation"
        );
        if let Some(sink) = &self.sink {
            sink.observe(observation);
        }
    }
}
