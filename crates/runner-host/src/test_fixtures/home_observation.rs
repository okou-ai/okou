//! Recorder at the resource-observation sink boundary for owner regressions.

use std::sync::{Arc, Mutex};

use crate::home_observation::{HomeObservation, HomeObservationHandle, HomeObservationSink};

#[derive(Clone, Default)]
pub struct RecordedHomeObservations {
    events: Arc<Mutex<Vec<HomeObservation>>>,
}

impl RecordedHomeObservations {
    pub fn handle(&self) -> HomeObservationHandle {
        HomeObservationHandle::new(Arc::new(self.clone()))
    }

    pub fn events(&self) -> Vec<HomeObservation> {
        self.events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}

impl HomeObservationSink for RecordedHomeObservations {
    fn observe(&self, observation: HomeObservation) {
        self.events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .push(observation);
    }
}
