//! Content-free resource facts delivered by the owning Runner's optional sink.

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
        }
    }
}

/// Implementations enqueue synchronously without waiting for transport,
/// retaining resources, or changing the caller's outcome.
pub trait HomeObservationSink: Send + Sync {
    fn observe(&self, observation: HomeObservation);
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
        if let Some(sink) = &self.sink {
            sink.observe(observation);
        }
    }
}
