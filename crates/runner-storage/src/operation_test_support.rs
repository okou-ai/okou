//! Test recorder at the existing sandbox-operation reporting boundary.

use crate::{SandboxOpRecord, SandboxOpReporter};
use runner_host::home_observation::HomeObservation;
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
pub struct RecordedHomeObservations {
    events: Arc<Mutex<Vec<HomeObservation>>>,
}

impl RecordedHomeObservations {
    pub fn handle(&self) -> SandboxOpReporter {
        let asynchronous = self.clone();
        let synchronous = self.clone();
        SandboxOpReporter::new(move |records| {
            for record in records {
                asynchronous.record(record);
            }
            async {}
        })
        .with_record(move |record| {
            synchronous.record(record);
        })
    }

    fn record(&self, record: SandboxOpRecord) {
        if let Some(home) = record.home {
            self.events
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(home);
        }
    }

    pub fn events(&self) -> Vec<HomeObservation> {
        self.events
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }
}
