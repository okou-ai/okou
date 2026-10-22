//! Test-only operation counts supplement the configured TCP traffic assertions.

use std::{
    cell::{Cell, RefCell},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicUsize, Ordering},
    },
};

use crate::tailscale::Work;

thread_local! {
    static OBSERVER: RefCell<Option<Arc<Liveness>>> = const { RefCell::new(None) };
    static CHECKS: Cell<Option<usize>> = const { Cell::new(None) };
}

#[derive(Default)]
pub(crate) struct Liveness {
    enabled: AtomicBool,
    projections: AtomicUsize,
    maximum: AtomicUsize,
}

impl Liveness {
    pub(crate) fn start(&self) {
        self.enabled.store(true, Ordering::Release);
    }

    pub(crate) fn stop(&self) {
        self.enabled.store(false, Ordering::Release);
    }

    pub(crate) fn snapshot(&self) -> (usize, usize) {
        (
            self.projections.load(Ordering::Acquire),
            self.maximum.load(Ordering::Relaxed),
        )
    }

    pub(crate) fn observe(self: &Arc<Self>, work: Work) -> Work {
        let observer = Arc::clone(self);
        Box::new(move |control| {
            Box::pin(async move {
                // Each native root owns its OS thread. Keep this observer there
                // for the lifetime of its root future.
                struct Guard;
                impl Drop for Guard {
                    fn drop(&mut self) {
                        OBSERVER.with(|slot| slot.borrow_mut().take());
                    }
                }
                OBSERVER.with(|slot| assert!(slot.replace(Some(observer)).is_none()));
                let _guard = Guard;
                work(control).await
            })
        })
    }
}

pub(crate) struct Projection(Arc<Liveness>);

impl Projection {
    pub(crate) fn start() -> Option<Self> {
        OBSERVER.with(|slot| {
            slot.borrow()
                .as_ref()
                .filter(|observer| observer.enabled.load(Ordering::Acquire))
                .map(|observer| {
                    assert!(CHECKS.replace(Some(0)).is_none());
                    Self(Arc::clone(observer))
                })
        })
    }
}

impl Drop for Projection {
    fn drop(&mut self) {
        let checks = CHECKS.with(Cell::take).unwrap();
        self.0.maximum.fetch_max(checks, Ordering::Relaxed);
        self.0.projections.fetch_add(1, Ordering::Release);
    }
}

pub(crate) fn record_liveness() {
    CHECKS.with(|checks| checks.set(checks.get().map(|count| count + 1)));
}
