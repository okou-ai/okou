use super::*;

#[tokio::test]
async fn unsupported_backing_never_becomes_proof_after_generic_kill() {
    let mut sandbox = MockSandbox::new("unsupported");
    assert!(sandbox.backing_process().is_none());
    sandbox.start().await.unwrap();
    sandbox.stop().await.unwrap();
    sandbox.kill().await.unwrap();
    assert!(sandbox.backing_process().is_none());
}

#[tokio::test]
async fn retained_backing_requires_explicit_wait_and_survives_sandbox_drop() {
    let (completion, backing) = MockBackingProcess::channel();
    let mut sandbox = MockSandbox::new("owned").with_backing_process(backing);
    let retained = sandbox.backing_process().unwrap();
    let other = sandbox.backing_process().unwrap();
    let identity = retained.identity();
    assert_eq!(other.identity(), identity);

    sandbox.start().await.unwrap();
    sandbox.stop().await.unwrap();
    sandbox.kill().await.unwrap();
    assert!(
        tokio::time::timeout(Duration::ZERO, retained.exit_confirmed())
            .await
            .is_err()
    );
    drop(sandbox);
    completion.confirm_exit();
    assert!(retained.exit_confirmed().await);
    assert!(other.exit_confirmed().await);
    assert_eq!(retained.identity(), identity);
}

#[tokio::test]
async fn retained_backing_wait_failure_or_lost_producer_stays_unconfirmed() {
    for publish_failure in [true, false] {
        let (completion, backing) = MockBackingProcess::channel();
        let sandbox = MockSandbox::new("unknown").with_backing_process(backing);
        let retained = sandbox.backing_process().unwrap();
        let identity = retained.identity();
        if publish_failure {
            completion.fail_wait();
        } else {
            drop(completion);
        }
        drop(sandbox);
        assert!(!retained.exit_confirmed().await);
        assert!(!retained.exit_confirmed().await);
        assert_eq!(retained.identity(), identity);
    }
}

#[tokio::test]
async fn equal_sandbox_labels_do_not_share_backing_generations_or_exit() {
    let (first_completion, first) = MockBackingProcess::channel();
    let (second_completion, second) = MockBackingProcess::channel();
    let first = MockSandbox::new("same-label").with_backing_process(first);
    let second = MockSandbox::new("same-label").with_backing_process(second);
    let first = first.backing_process().unwrap();
    let second = second.backing_process().unwrap();
    assert_ne!(first.identity(), second.identity());
    assert_ne!(
        first.identity().generation(),
        second.identity().generation()
    );
    first_completion.confirm_exit();
    assert!(first.exit_confirmed().await);
    assert!(
        tokio::time::timeout(Duration::ZERO, second.exit_confirmed())
            .await
            .is_err()
    );
    second_completion.fail_wait();
    assert!(!second.exit_confirmed().await);
}

#[tokio::test]
async fn simultaneous_backing_observers_share_one_terminal_result() {
    let (completion, backing) = MockBackingProcess::channel();
    let first = backing.clone();
    let second = backing.clone();
    let first = tokio::spawn(async move { first.exit_confirmed().await });
    let second = tokio::spawn(async move { second.exit_confirmed().await });
    completion.confirm_exit();
    assert!(first.await.unwrap());
    assert!(second.await.unwrap());
    assert!(backing.exit_confirmed().await);
}
