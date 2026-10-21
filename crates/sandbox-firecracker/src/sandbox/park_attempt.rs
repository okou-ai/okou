//! Original park fence and actual pause result outlive borrowed park observers.

use std::io;
use std::sync::{Arc, Mutex, MutexGuard};

use sandbox::SandboxParkOutcome;
use uuid::Uuid;

use crate::api::ApiClient;
use crate::park_coordinator::{DirtyReason, ParkCoordinator};

use super::unpark_attempt::Step;

pub(super) struct Attempt<Fence> {
    pub(super) id: Uuid,
    coordinator: ParkCoordinator,
    inner: Arc<Mutex<Inner<Fence>>>,
}

struct Inner<Fence> {
    fence: Option<Fence>,
    pause: Option<Arc<Step>>,
    outcome: Option<SandboxParkOutcome>,
}

impl<Fence> Clone for Attempt<Fence> {
    fn clone(&self) -> Self {
        Self {
            id: self.id,
            coordinator: self.coordinator.clone(),
            inner: Arc::clone(&self.inner),
        }
    }
}

impl<Fence> Attempt<Fence> {
    pub(super) fn new(coordinator: ParkCoordinator) -> Self {
        Self {
            id: Uuid::new_v4(),
            coordinator,
            inner: Arc::new(Mutex::new(Inner {
                fence: None,
                pause: None,
                outcome: None,
            })),
        }
    }

    fn inner(&self) -> MutexGuard<'_, Inner<Fence>> {
        match self.inner.lock() {
            Ok(inner) => inner,
            Err(error) => {
                // Preserve actual ownership while revoking recovery authority.
                self.coordinator
                    .mark_dirty(DirtyReason::new("park custody mutex poisoned"));
                error.into_inner()
            }
        }
    }

    pub(super) fn retain_fence(&self, fence: Fence) {
        self.inner().fence = Some(fence);
    }

    pub(super) fn take_fence(&self) -> Option<Fence> {
        self.inner().fence.take()
    }

    pub(super) fn has_pause(&self) -> bool {
        self.inner().pause.is_some()
    }

    pub(super) fn cancellation_reason(&self, message: &'static str) -> DirtyReason {
        DirtyReason::abandoned_native_transition(message, self.has_pause().then_some(self.id))
    }

    pub(super) async fn pause(
        &self,
        client: ApiClient,
        outcome: SandboxParkOutcome,
    ) -> io::Result<()> {
        let pause = {
            let mut inner = self.inner();
            if inner.fence.is_none() {
                return Err(io::Error::other("physical pause lost its operation fence"));
            }
            if inner.pause.is_none() {
                inner.outcome = Some(outcome);
                inner.pause = Some(Arc::new(Step::new(async move {
                    client.pause().await.map_err(io::Error::other)
                })));
            }
            Arc::clone(inner.pause.as_ref().ok_or_else(|| {
                io::Error::other("physical pause custody missing after admission")
            })?)
        };
        pause.join().await
    }

    pub(super) async fn join(&self) -> io::Result<Option<SandboxParkOutcome>> {
        let (pause, outcome) = {
            let inner = self.inner();
            (inner.pause.clone(), inner.outcome.clone())
        };
        let Some(pause) = pause else {
            return Ok(None);
        };
        pause.join().await?;
        outcome
            .map(Some)
            .ok_or_else(|| io::Error::other("joined physical pause lost its outcome"))
    }
}
