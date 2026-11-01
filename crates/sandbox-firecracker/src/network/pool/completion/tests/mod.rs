use super::*;

fn failed_completion(id: u64) -> CreationCompletion {
    CreationCompletion {
        id: PendingId(id),
        kind: NetnsKind::Plain,
        result: Err(NetworkError::Prerequisite("test completion".into())),
    }
}

#[tokio::test]
async fn prepare_wait_drains_completion_sent_without_receiver() {
    let mut coordinator = CreationCompletionCoordinator::new();
    let notifier = coordinator.notifier(NetnsLifecycleOps::trusted_for_test());
    notifier.send(failed_completion(1)).await;

    let prepared = coordinator.prepare_wait();

    assert_eq!(prepared.completions.len(), 1);
    assert_eq!(prepared.completions[0].id, PendingId(1));
    assert!(!prepared.receiver.has_changed().unwrap());
}

#[tokio::test]
async fn prepared_receiver_observes_later_completion() {
    let mut coordinator = CreationCompletionCoordinator::new();
    let notifier = coordinator.notifier(NetnsLifecycleOps::trusted_for_test());
    let prepared = coordinator.prepare_wait();
    assert!(prepared.completions.is_empty());

    notifier.send(failed_completion(2)).await;

    assert!(prepared.receiver.has_changed().unwrap());
    let completion = coordinator.try_recv().unwrap();
    assert_eq!(completion.id, PendingId(2));
}

#[tokio::test]
async fn one_completion_wakes_all_prepared_receivers_and_drains_once() {
    let mut coordinator = CreationCompletionCoordinator::new();
    let notifier = coordinator.notifier(NetnsLifecycleOps::trusted_for_test());
    let first = coordinator.prepare_wait();
    let second = coordinator.prepare_wait();

    notifier.send(failed_completion(3)).await;

    assert!(first.receiver.has_changed().unwrap());
    assert!(second.receiver.has_changed().unwrap());
    let completion = coordinator.try_recv().unwrap();
    assert_eq!(completion.id, PendingId(3));
    assert!(coordinator.try_recv().is_none());
}
