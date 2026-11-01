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
