#![deny(missing_docs)]

//! Tracing event capture helpers for tests.
//!
//! [`CapturedEvents`] implements [`tracing_subscriber::layer::Layer`] and stores structured
//! tracing events in a shared in-memory buffer for later assertions.
//!
//! # Example
//!
//! ```
//! use tracing::Level;
//! use tracing_subscriber::prelude::*;
//! use tracing_test_support::CapturedEvents;
//!
//! let captured = CapturedEvents::default();
//! let subscriber = tracing_subscriber::registry().with(captured.clone());
//!
//! tracing::subscriber::with_default(subscriber, || {
//!     tracing::info!(request_id = 42_u64, "handled request");
//! });
//!
//! let events = captured.entries();
//! assert_eq!(events.len(), 1);
//! assert!(events.iter().any(|event| {
//!     event.level == Level::INFO
//!         && event.fields.get("request_id").map(String::as_str) == Some("42")
//! }));
//! ```

use std::collections::BTreeMap;
use std::fmt;
use std::sync::{Arc, Mutex, MutexGuard};

use tracing::field::{Field, Visit};
use tracing::{Dispatch, Event, Level, Subscriber};
use tracing_subscriber::layer::{Context, Layer};

/// A structured tracing event captured by [`CapturedEvents`].
#[derive(Clone, Debug)]
pub struct CapturedEvent {
    /// The level from the event's tracing metadata.
    pub level: Level,
    /// String representations of the event's fields, keyed by field name.
    ///
    /// The event message, when present, uses the `message` key.
    pub fields: BTreeMap<String, String>,
    /// The `tracing::field::Visit` recording method used for each entry in [`Self::fields`].
    ///
    /// Each value is one of `str`, `i64`, `u64`, `i128`, `u128`, `bool`, or `debug`.
    pub field_kinds: BTreeMap<String, &'static str>,
}

/// A shared collector that captures tracing events as a [`Layer`].
///
/// The default value starts with an empty event buffer. Cloning a collector creates another
/// handle to the same buffer, not an independent collector. Events recorded through a layer
/// installed from any clone are therefore visible from every clone.
///
/// [`Layer`]: tracing_subscriber::layer::Layer
#[derive(Clone)]
pub struct CapturedEvents {
    events: Arc<Mutex<Vec<CapturedEvent>>>,
    // Keep a second dispatch registered while a capture is active. Without it, tracing-core's
    // single-dispatch fast path can cache Interest::Never when another thread first executes a
    // callsite. See https://github.com/tokio-rs/tracing/issues/2874.
    _callsite_interest_guard: Dispatch,
}

impl Default for CapturedEvents {
    fn default() -> Self {
        Self {
            events: Arc::default(),
            _callsite_interest_guard: Dispatch::new(tracing::subscriber::NoSubscriber::default()),
        }
    }
}

impl CapturedEvents {
    /// Returns a cloned, point-in-time snapshot of the captured events.
    ///
    /// The returned events are independent of the collector. Later captures or calls to
    /// [`Self::clear`] do not change an existing snapshot.
    pub fn entries(&self) -> Vec<CapturedEvent> {
        self.lock_events().clone()
    }

    /// Removes all events from the shared collector.
    ///
    /// Calling this method through any cloned handle clears the buffer observed by every handle.
    /// Snapshots previously returned by [`Self::entries`] are unaffected.
    pub fn clear(&self) {
        self.lock_events().clear();
    }

    fn lock_events(&self) -> MutexGuard<'_, Vec<CapturedEvent>> {
        match self.events.lock() {
            Ok(events) => events,
            Err(poisoned) => poisoned.into_inner(),
        }
    }
}

impl<S> Layer<S> for CapturedEvents
where
    S: Subscriber,
{
    fn on_event(&self, event: &Event<'_>, _ctx: Context<'_, S>) {
        let mut visitor = CapturedFields::default();
        event.record(&mut visitor);
        self.lock_events().push(CapturedEvent {
            level: *event.metadata().level(),
            fields: visitor.fields,
            field_kinds: visitor.field_kinds,
        });
    }
}

#[derive(Default)]
struct CapturedFields {
    fields: BTreeMap<String, String>,
    field_kinds: BTreeMap<String, &'static str>,
}

impl CapturedFields {
    fn record_value(&mut self, field: &Field, value: String, kind: &'static str) {
        let name = field.name().to_string();
        self.fields.insert(name.clone(), value);
        self.field_kinds.insert(name, kind);
    }
}

impl Visit for CapturedFields {
    fn record_str(&mut self, field: &Field, value: &str) {
        self.record_value(field, value.to_string(), "str");
    }

    fn record_i64(&mut self, field: &Field, value: i64) {
        self.record_value(field, value.to_string(), "i64");
    }

    fn record_u64(&mut self, field: &Field, value: u64) {
        self.record_value(field, value.to_string(), "u64");
    }

    fn record_i128(&mut self, field: &Field, value: i128) {
        self.record_value(field, value.to_string(), "i128");
    }

    fn record_u128(&mut self, field: &Field, value: u128) {
        self.record_value(field, value.to_string(), "u128");
    }

    fn record_bool(&mut self, field: &Field, value: bool) {
        self.record_value(field, value.to_string(), "bool");
    }

    fn record_debug(&mut self, field: &Field, value: &dyn fmt::Debug) {
        self.record_value(field, format!("{value:?}"), "debug");
    }
}

#[cfg(test)]
mod tests;
