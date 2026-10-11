//! Scope SDK HTTP/actor diagnostics without changing unrelated Runner logging.

use std::cell::{Cell, RefCell};
use tracing::{Dispatch, Event, Metadata, Subscriber, span};

thread_local! {
    static NATIVE_DOMAIN: Cell<bool> = const { Cell::new(false) };
    static BLOCKING_DISPATCH: RefCell<Option<tracing::dispatcher::DefaultGuard>> = const { RefCell::new(None) };
}

pub(super) fn in_domain() -> bool {
    NATIVE_DOMAIN.with(Cell::get)
}

/// This allow-list is also the only error event admitted into production sinks.
pub(super) fn failed(failure: super::Failure) {
    let reason = match failure {
        super::Failure::Cancelled => return,
        super::Failure::DomainFailed => "authority_failure",
        super::Failure::ResourceExhausted => "resource_exhausted",
        super::Failure::CleanupTimedOut => "cleanup_timed_out",
    };
    tracing::warn!(target: "runner_remote::ssh::tailscale", stage = "node", reason, "native SSH resource domain failed");
}

/// Only fixed application stages cross the private SDK diagnostic boundary.
pub(super) enum Stage {
    Provisioning,
    UnusedKeyCleanup,
    KeyTls,
    ControlKey,
    ControlTls,
    Noise,
    Registration,
    Map,
}

impl Stage {
    pub(super) fn record(self) {
        let stage = match self {
            Self::Provisioning => "provisioning",
            Self::UnusedKeyCleanup => "unused_key_cleanup",
            Self::KeyTls => "key_tls",
            Self::ControlKey => "control_key",
            Self::ControlTls => "control_tls",
            Self::Noise => "noise",
            Self::Registration => "registration",
            Self::Map => "map",
        };
        tracing::info!(target: "runner_remote::ssh::tailscale", stage, reason = "starting", "native SSH startup");
    }
}

pub(super) fn private_dispatch() -> Dispatch {
    tracing::dispatcher::get_default(|parent| {
        Dispatch::new(Scoped {
            parent: parent.clone(),
        })
    })
}

pub(super) struct Guard {
    _dispatch: tracing::dispatcher::DefaultGuard,
}

impl Guard {
    pub(super) fn enter(dispatch: &Dispatch) -> Self {
        NATIVE_DOMAIN.with(|value| value.set(true));
        Self {
            _dispatch: tracing::dispatcher::set_default(dispatch),
        }
    }
}

impl Drop for Guard {
    fn drop(&mut self) {
        NATIVE_DOMAIN.with(|value| value.set(false));
    }
}

pub(super) fn blocking_start(dispatch: &Dispatch) {
    NATIVE_DOMAIN.with(|value| value.set(true));
    BLOCKING_DISPATCH
        .with(|guard| *guard.borrow_mut() = Some(tracing::dispatcher::set_default(dispatch)));
}

pub(super) fn blocking_stop() {
    BLOCKING_DISPATCH.with(|guard| {
        guard.borrow_mut().take();
    });
    NATIVE_DOMAIN.with(|value| value.set(false));
}

struct Scoped {
    parent: Dispatch,
}

impl Subscriber for Scoped {
    fn enabled(&self, metadata: &Metadata<'_>) -> bool {
        metadata.is_event()
            && metadata.target() == "runner_remote::ssh::tailscale"
            && self.parent.enabled(metadata)
    }
    fn new_span(&self, _attributes: &span::Attributes<'_>) -> span::Id {
        // No raw span fields or context are admitted into production sinks,
        // including a callsite whose interest was cached by another dispatch.
        span::Id::from_u64(1)
    }
    fn record(&self, _id: &span::Id, _values: &span::Record<'_>) {}
    fn record_follows_from(&self, _id: &span::Id, _follows: &span::Id) {}
    fn event(&self, event: &Event<'_>) {
        if self.enabled(event.metadata()) {
            self.parent.event(event);
        }
    }
    fn enter(&self, _id: &span::Id) {}
    fn exit(&self, _id: &span::Id) {}
    fn clone_span(&self, id: &span::Id) -> span::Id {
        id.clone()
    }
    fn try_close(&self, _id: span::Id) -> bool {
        true
    }
}
