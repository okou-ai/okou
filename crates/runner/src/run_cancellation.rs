//! Per-run cancellation state shared by provider, lifecycle, admission, and
//! execution paths.
//!
//! [`RunCancellationRegistry`] owns one [`RunCancellationHandle`] for each
//! registered run. The [`RunCancellationRegistration`] returned by
//! [`RunCancellationRegistry::register`] is the lifecycle owner for that
//! registry entry: it must stay owned until the run has been cleaned up, and
//! callers must explicitly call [`RunCancellationRegistration::unregister`].
//! Dropping the registration does not remove the entry.
//!
//! ## Cancellation protocol
//!
//! A registration is unique by run ID. A duplicate registration is rejected
//! so that provider and local cancellation continue to target the active
//! handle. [`RunCancellationRegistry::begin_hard_stop`] marks the hard-stop
//! barrier and returns a snapshot of registrations that existed at that
//! point. The caller dispatches hard cancellation to that snapshot. A
//! registration created after the barrier is inserted and then returned with
//! hard cancellation already requested.
//!
//! Each handle exposes an aggregate cancellation token and two independent
//! class-specific tokens through [`RunCancellationSignals`]. Either a
//! cooperative-user request or a hard request cancels the aggregate token;
//! only the matching class-specific token is cancelled. Request methods return
//! whether their cancellation class changed from not requested to requested.
//! The signals are monotonic, so a hard cancellation remains observable after
//! a cooperative request and a cooperative request does not imply hard
//! cancellation.
//!
//! ## Ownership transfer protocol
//!
//! The handle's transfer gate serializes cancellation requests with ownership
//! transitions for a sandbox. A caller transferring or publishing ownership
//! should acquire [`RunCancellationHandle::transfer_guard`], inspect the
//! applicable cancellation signal while holding it, perform the ownership
//! transition, and release the guard only after the transition is complete.
//! The gate is not itself a cancellation signal.
//!
//! A caller must not await the transfer gate while holding another shared lock
//! whose release is needed by cancellation or finalization. It should use
//! [`RunCancellationHandle::try_transfer_guard`] while holding that lock and,
//! when the attempt fails, release the other lock before awaiting the gate.
//! The idle-pool publication path in
//! [`sandbox_finalization`](https://github.com/vm0-ai/vm0/blob/main/crates/runner/src/cmd/start/sandbox_finalization.rs#L809-L829)
//! follows this ordering. The broader lifecycle is exercised by
//! [`signals`](https://github.com/vm0-ai/vm0/blob/main/crates/runner/src/cmd/start/signals.rs#L213-L247),
//! [`provider cancellation`](https://github.com/vm0-ai/vm0/blob/main/crates/runner/src/provider/api_ably_supervisor.rs#L850-L884),
//! [`job discovery`](https://github.com/vm0-ai/vm0/blob/main/crates/runner/src/cmd/start/job_discovery.rs#L976-L1004),
//! [`sandbox finalization`](https://github.com/vm0-ai/vm0/blob/main/crates/runner/src/cmd/start/sandbox_finalization.rs#L697-L732),
//! and the focused
//! [`cancellation tests`](https://github.com/vm0-ai/vm0/blob/main/crates/runner/src/run_cancellation.rs#L395-L494).
//! The job-discovery-specific ownership lifecycle is described in
//! [issue #30953](https://github.com/vm0-ai/vm0/issues/30953).

use std::collections::HashMap;
use std::sync::Arc;

use tokio::sync::{Mutex, OwnedMutexGuard};
use tokio_util::sync::CancellationToken;

use crate::ids::RunId;

#[derive(Clone, Debug, Default)]
/// Registry of cancellation handles for active runs.
///
/// The registry permits at most one registration for each run ID. Keep the
/// [`RunCancellationRegistration`] returned by [`Self::register`] owned until
/// the corresponding run has completed cleanup; the registry does not remove
/// an entry when that value is dropped. Cancellation callers receive cloned
/// handles, so the registration remains the authority for removing the active
/// mapping.
pub(crate) struct RunCancellationRegistry {
    inner: Arc<Mutex<RunCancellationRegistryState>>,
}

#[derive(Debug, Default)]
struct RunCancellationRegistryState {
    registrations: HashMap<RunId, RunCancellationHandle>,
    hard_stopping: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
/// Registration failed because the run ID already has an active entry.
pub(crate) struct DuplicateRunCancellationRegistration;

#[derive(Debug)]
#[must_use = "the registration must remain owned until its run is cleaned up"]
/// Lifecycle owner for one entry in a [`RunCancellationRegistry`].
///
/// Keep this value alive from registration through provider claim, activation,
/// execution, and the final cleanup path so provider or lifecycle cancellation
/// can continue to find the run. Registration teardown is explicit: dropping
/// this value does not unregister it, so callers must invoke
/// [`Self::unregister`]. The boolean result distinguishes removal of the
/// current entry from a stale registration that has already been replaced or
/// removed.
pub(crate) struct RunCancellationRegistration {
    registry: RunCancellationRegistry,
    run_id: RunId,
    handle: RunCancellationHandle,
}

#[derive(Clone, Debug)]
/// Cloneable cancellation state for one run.
///
/// Clones share the aggregate token, the cooperative-user token, the hard
/// token, and the transfer gate. Use the class-specific signals when behavior
/// differs between cooperative recovery and destructive hard cancellation.
/// Cancellation requests and sandbox ownership transitions are serialized by
/// the transfer gate.
pub(crate) struct RunCancellationHandle {
    inner: Arc<RunCancellationInner>,
}

#[derive(Clone, Debug)]
/// Cancellation tokens consumed by execution and recovery paths.
///
/// [`Self::any`] is cancelled by either cancellation class. [`Self::cooperative_user`]
/// is cancelled only by a cooperative-user request, and [`Self::hard`] is
/// cancelled only by a hard request. The class-specific tokens are independent
/// monotonic signals rather than interchangeable aliases.
pub(crate) struct RunCancellationSignals {
    any: CancellationToken,
    cooperative_user: CancellationToken,
    hard: CancellationToken,
}

#[derive(Debug)]
struct RunCancellationInner {
    token: CancellationToken,
    cooperative_user_token: CancellationToken,
    hard_token: CancellationToken,
    transfer_gate: Arc<Mutex<()>>,
}

impl RunCancellationRegistry {
    /// Create an empty registry with no hard-stop barrier set.
    pub(crate) fn new() -> Self {
        Self::default()
    }

    /// Register one run and return the registration that owns its entry.
    ///
    /// Registration is unique by `run_id`; a duplicate returns
    /// [`DuplicateRunCancellationRegistration`] and leaves the existing
    /// handle untouched. If [`Self::begin_hard_stop`] has already run, the new
    /// entry is inserted and then hard-cancelled before this method returns.
    pub(crate) async fn register(
        &self,
        run_id: RunId,
    ) -> Result<RunCancellationRegistration, DuplicateRunCancellationRegistration> {
        let handle = RunCancellationHandle::new();
        let hard_stopping = {
            let mut state = self.inner.lock().await;
            if state.registrations.contains_key(&run_id) {
                return Err(DuplicateRunCancellationRegistration);
            }
            state.registrations.insert(run_id, handle.clone());
            state.hard_stopping
        };
        if hard_stopping {
            handle.request_hard_cancellation().await;
        }
        Ok(RunCancellationRegistration {
            registry: self.clone(),
            run_id,
            handle,
        })
    }

    /// Clone the current handle for `run_id`, if it is registered.
    ///
    /// The returned handle does not own registry membership. The corresponding
    /// [`RunCancellationRegistration`] must remain owned until the run's
    /// cleanup path calls [`RunCancellationRegistration::unregister`].
    pub(crate) async fn handle(&self, run_id: RunId) -> Option<RunCancellationHandle> {
        self.inner.lock().await.registrations.get(&run_id).cloned()
    }

    /// Clone handles for the registered run IDs in `run_ids`.
    ///
    /// Missing IDs are omitted. The returned map is a snapshot of handles and
    /// does not change registry membership.
    pub(crate) async fn handles_for(
        &self,
        run_ids: &[RunId],
    ) -> HashMap<RunId, RunCancellationHandle> {
        let state = self.inner.lock().await;
        run_ids
            .iter()
            .filter_map(|run_id| {
                state
                    .registrations
                    .get(run_id)
                    .cloned()
                    .map(|handle| (*run_id, handle))
            })
            .collect()
    }

    #[cfg(test)]
    /// Test whether a run ID currently has a registry entry.
    pub(crate) async fn contains(&self, run_id: RunId) -> bool {
        self.inner.lock().await.registrations.contains_key(&run_id)
    }

    /// Return the run IDs in `run_ids` that are not currently registered.
    pub(crate) async fn missing_run_ids(&self, run_ids: &[RunId]) -> Vec<RunId> {
        let state = self.inner.lock().await;
        run_ids
            .iter()
            .copied()
            .filter(|run_id| !state.registrations.contains_key(run_id))
            .collect()
    }

    /// Enter the hard-stop barrier and snapshot the registrations before it.
    ///
    /// This method marks the registry as hard-stopping and returns cloned
    /// handles for entries that existed under the registry lock. It does not
    /// cancel those handles itself; the caller dispatches hard cancellation to
    /// the returned snapshot. A concurrent registration is ordered either
    /// before this barrier and appears in the snapshot, or after it and is
    /// returned by [`Self::register`] already hard-cancelled.
    pub(crate) async fn begin_hard_stop(&self) -> Vec<(RunId, RunCancellationHandle)> {
        let mut state = self.inner.lock().await;
        state.hard_stopping = true;
        state
            .registrations
            .iter()
            .map(|(run_id, handle)| (*run_id, handle.clone()))
            .collect()
    }
}

impl RunCancellationRegistration {
    /// Clone the handle associated with this registration.
    pub(crate) fn handle(&self) -> RunCancellationHandle {
        self.handle.clone()
    }

    /// Clone the aggregate token, which observes either cancellation class.
    pub(crate) fn token(&self) -> CancellationToken {
        self.handle.token()
    }

    #[cfg(test)]
    /// Test whether either cancellation class has been requested.
    pub(crate) fn is_cancelled(&self) -> bool {
        self.handle.is_cancelled()
    }

    /// Request hard cancellation for this registration's run.
    ///
    /// Returns `true` only when hard cancellation was not already requested.
    /// The request also cancels the aggregate token and is serialized with
    /// ownership transitions by the transfer gate.
    pub(crate) async fn request_hard_cancellation(&self) -> bool {
        self.handle.request_hard_cancellation().await
    }

    /// Remove this registration when it is still the current entry.
    ///
    /// Returns `true` when this call removed the mapping for the registration's
    /// run ID. Returns `false` for a stale registration or an entry already
    /// removed by an earlier call. A stale registration cannot remove a
    /// replacement registration for the same run ID.
    pub(crate) async fn unregister(&self) -> bool {
        let mut state = self.registry.inner.lock().await;
        let is_current = state
            .registrations
            .get(&self.run_id)
            .is_some_and(|handle| handle.same_registration(&self.handle));
        if is_current {
            state.registrations.remove(&self.run_id);
        }
        is_current
    }
}

impl RunCancellationHandle {
    /// Create an uncancelled handle with a fresh transfer gate.
    pub(crate) fn new() -> Self {
        Self {
            inner: Arc::new(RunCancellationInner {
                token: CancellationToken::new(),
                cooperative_user_token: CancellationToken::new(),
                hard_token: CancellationToken::new(),
                transfer_gate: Arc::new(Mutex::new(())),
            }),
        }
    }

    /// Clone the aggregate token, cancelled by either cancellation class.
    pub(crate) fn token(&self) -> CancellationToken {
        self.inner.token.clone()
    }

    /// Return whether cooperative or hard cancellation has been requested.
    pub(crate) fn is_cancelled(&self) -> bool {
        self.inner.token.is_cancelled()
    }

    /// Return whether hard cancellation has been requested.
    pub(crate) fn is_hard_cancelled(&self) -> bool {
        self.inner.hard_token.is_cancelled()
    }

    /// Snapshot the aggregate, cooperative-user, and hard cancellation tokens.
    pub(crate) fn signals(&self) -> RunCancellationSignals {
        RunCancellationSignals {
            any: self.inner.token.clone(),
            cooperative_user: self.inner.cooperative_user_token.clone(),
            hard: self.inner.hard_token.clone(),
        }
    }

    /// Request cooperative-user cancellation.
    ///
    /// The cooperative-user and aggregate tokens are cancelled while holding
    /// the transfer gate. Returns `true` only for the first request of this
    /// cancellation class; a hard request is tracked independently.
    pub(crate) async fn request_cooperative_user_cancellation(&self) -> bool {
        let _transfer_guard = self.inner.transfer_gate.lock().await;
        let was_requested = self.inner.cooperative_user_token.is_cancelled();
        self.inner.cooperative_user_token.cancel();
        self.inner.token.cancel();
        !was_requested
    }

    /// Request hard cancellation.
    ///
    /// The hard and aggregate tokens are cancelled while holding the transfer
    /// gate. Returns `true` only for the first request of the hard cancellation
    /// class; a cooperative-user request is tracked independently.
    pub(crate) async fn request_hard_cancellation(&self) -> bool {
        let _transfer_guard = self.inner.transfer_gate.lock().await;
        let was_requested = self.inner.hard_token.is_cancelled();
        self.inner.hard_token.cancel();
        self.inner.token.cancel();
        !was_requested
    }

    /// Wait for and hold the transfer gate across an ownership transition.
    ///
    /// The caller must inspect the relevant cancellation signal while holding
    /// the returned guard, perform the transfer or cleanup decision, and drop
    /// the guard after that decision. Do not await this method while holding a
    /// different shared lock that cancellation or finalization needs.
    pub(crate) async fn transfer_guard(&self) -> OwnedMutexGuard<()> {
        self.inner.transfer_gate.clone().lock_owned().await
    }

    /// Try to hold the transfer gate without waiting.
    ///
    /// Use this when another shared lock is currently held. If this returns
    /// `None`, release that lock before awaiting [`Self::transfer_guard`] so a
    /// cancellation or finalization path cannot be blocked by lock ordering.
    pub(crate) fn try_transfer_guard(&self) -> Option<OwnedMutexGuard<()>> {
        self.inner.transfer_gate.clone().try_lock_owned().ok()
    }

    /// Compare registration identity, even when a run ID has been reused.
    pub(crate) fn same_registration(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.inner, &other.inner)
    }
}

impl RunCancellationSignals {
    /// Clone the aggregate token, cancelled by either cancellation class.
    pub(crate) fn any(&self) -> CancellationToken {
        self.any.clone()
    }

    /// Clone the token cancelled by a cooperative-user request.
    pub(crate) fn cooperative_user(&self) -> CancellationToken {
        self.cooperative_user.clone()
    }

    /// Clone the token cancelled by a hard request.
    pub(crate) fn hard(&self) -> CancellationToken {
        self.hard.clone()
    }

    #[cfg(test)]
    /// Build test signals that share one aggregate and hard token.
    pub(crate) fn hard_only(cancel: CancellationToken) -> Self {
        Self {
            any: cancel.clone(),
            cooperative_user: CancellationToken::new(),
            hard: cancel,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn duplicate_registration_preserves_the_active_handle() {
        let registry = RunCancellationRegistry::new();
        let run_id = RunId::new_v4();
        let registration = registry.register(run_id).await.unwrap();
        let token = registration.token();

        assert_eq!(
            registry.register(run_id).await.unwrap_err(),
            DuplicateRunCancellationRegistration,
        );

        registry
            .handle(run_id)
            .await
            .unwrap()
            .request_hard_cancellation()
            .await;
        assert!(token.is_cancelled());
    }

    #[tokio::test]
    async fn registration_before_hard_stop_is_included_in_the_snapshot() {
        let registry = RunCancellationRegistry::new();
        let run_id = RunId::new_v4();
        let registration = registry.register(run_id).await.unwrap();
        let token = registration.token();
        let signals = registration.handle().signals();

        let handles = registry.begin_hard_stop().await;

        assert_eq!(handles.len(), 1);
        assert_eq!(handles[0].0, run_id);
        assert!(!token.is_cancelled());
        handles[0].1.request_hard_cancellation().await;
        assert!(token.is_cancelled());
        assert!(signals.hard().is_cancelled());
        assert!(!signals.cooperative_user().is_cancelled());
    }

    #[tokio::test]
    async fn registration_after_hard_stop_is_returned_cancelled() {
        let registry = RunCancellationRegistry::new();
        assert!(registry.begin_hard_stop().await.is_empty());

        let registration = registry.register(RunId::new_v4()).await.unwrap();

        assert!(registration.is_cancelled());
        assert!(registration.handle().signals().hard().is_cancelled());
        assert!(
            !registration
                .handle()
                .signals()
                .cooperative_user()
                .is_cancelled()
        );
    }

    #[tokio::test]
    async fn cooperative_user_and_hard_cancellation_are_independent_monotonic_signals() {
        let handle = RunCancellationHandle::new();
        let signals = handle.signals();

        assert!(handle.request_cooperative_user_cancellation().await);
        assert!(!handle.request_cooperative_user_cancellation().await);
        assert!(signals.any().is_cancelled());
        assert!(signals.cooperative_user().is_cancelled());
        assert!(!signals.hard().is_cancelled());
        assert!(!handle.is_hard_cancelled());

        assert!(handle.request_hard_cancellation().await);
        assert!(!handle.request_hard_cancellation().await);
        assert!(signals.hard().is_cancelled());
        assert!(handle.is_hard_cancelled());
    }

    #[tokio::test]
    async fn stale_registration_does_not_remove_its_replacement() {
        let registry = RunCancellationRegistry::new();
        let run_id = RunId::new_v4();
        let stale = registry.register(run_id).await.unwrap();
        assert!(stale.unregister().await);
        let replacement = registry.register(run_id).await.unwrap();
        let replacement_token = replacement.token();

        assert!(!stale.unregister().await);
        registry
            .handle(run_id)
            .await
            .unwrap()
            .request_hard_cancellation()
            .await;

        assert!(replacement_token.is_cancelled());
    }
}
