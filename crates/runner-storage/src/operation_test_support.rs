//! Test recorder at the existing sandbox-operation reporting boundary.

use crate::{SandboxOpRecord, SandboxOpReporter};
use runner_host::home_observation::{HomeObservation, HomeObservationKind};
use std::sync::{Arc, Mutex};

#[derive(Clone, Default)]
pub struct RecordedHomeObservations {
    records: Arc<Mutex<Vec<SandboxOpRecord>>>,
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
        if record.home.is_some() {
            self.records
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .push(record);
        }
    }

    /// Resource-state facts, excluding passive phase diagnostics.
    pub fn events(&self) -> Vec<HomeObservation> {
        self.records
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .filter_map(|record| record.home.as_ref())
            .filter(|home| home.kind != HomeObservationKind::LifecycleTiming)
            .cloned()
            .collect()
    }

    /// Passive diagnostics retain their actual measured durations and success flags.
    pub fn timings(&self) -> Vec<SandboxOpRecord> {
        self.records
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .iter()
            .filter(|record| {
                record
                    .home
                    .as_ref()
                    .is_some_and(|home| home.kind == HomeObservationKind::LifecycleTiming)
            })
            .cloned()
            .collect()
    }
}
