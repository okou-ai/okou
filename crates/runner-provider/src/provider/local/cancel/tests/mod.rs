use std::time::Duration;

use super::*;

fn empty_cancel_tokens() -> RunCancellationRegistry {
    RunCancellationRegistry::new()
}

fn scanner(dir: &std::path::Path, tokens: RunCancellationRegistry) -> LocalCancelScanner {
    LocalCancelScanner::new(
        LocalQueue::new(dir.to_path_buf()),
        tokens,
        Arc::new(tokio::sync::Mutex::new(HashSet::new())),
    )
}

async fn insert_cancel_registration(
    tokens: &RunCancellationRegistry,
    run_id: RunId,
) -> RunCancellationRegistration {
    tokens.register(run_id).await.unwrap()
}

fn write_job(dir: &std::path::Path, run_id: RunId) {
    let job_path = local_queue::job_path(dir, crate::profile::DEFAULT_PROFILE, run_id).unwrap();
    std::fs::create_dir_all(job_path.parent().unwrap()).unwrap();
    std::fs::write(job_path, b"{}").unwrap();
}

fn write_cancel(dir: &std::path::Path, run_id: RunId) -> std::path::PathBuf {
    let cancel_path = local_queue::cancel_path(dir, run_id);
    std::fs::create_dir_all(cancel_path.parent().unwrap()).unwrap();
    std::fs::write(&cancel_path, b"").unwrap();
    cancel_path
}

fn write_claim(dir: &std::path::Path, run_id: RunId) -> std::path::PathBuf {
    let claim_path = local_queue::claim_path(dir, run_id);
    std::fs::create_dir_all(claim_path.parent().unwrap()).unwrap();
    std::fs::write(&claim_path, b"").unwrap();
    claim_path
}

fn write_result(dir: &std::path::Path, run_id: RunId, content: &[u8]) -> std::path::PathBuf {
    let result_path = local_queue::result_path(dir, run_id);
    std::fs::create_dir_all(result_path.parent().unwrap()).unwrap();
    std::fs::write(&result_path, content).unwrap();
    result_path
}

async fn wait_for_marker_cleanup(scanner: &LocalCancelScanner, path: &std::path::Path) {
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let scans = scanner.scan_count();
            if !path.exists() {
                return;
            }
            scanner.wait_for_scan_count(scans + 1).await;
        }
    })
    .await
    .expect("completed cancellation should reconcile marker cleanup");
}

#[tokio::test]
async fn blocked_delivery_does_not_delay_same_scan_or_repeat_requests() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = empty_cancel_tokens();
    let scanner = scanner(dir.path(), tokens.clone());
    let blocked_id = RunId::new_v4();
    let ready_id = RunId::new_v4();
    let blocked = insert_cancel_registration(&tokens, blocked_id).await;
    let ready = insert_cancel_registration(&tokens, ready_id).await;
    let guard = blocked.handle().transfer_guard().await;
    write_job(dir.path(), blocked_id);
    write_job(dir.path(), ready_id);
    let blocked_marker = write_cancel(dir.path(), blocked_id);
    let ready_marker = write_cancel(dir.path(), ready_id);
    scanner.mark_owned_claim(blocked_id).await;
    scanner.mark_owned_claim(ready_id).await;

    // Scan completion proves progress regardless of directory entry order.
    for _ in 0..3 {
        tokio::time::timeout(Duration::from_secs(2), scanner.scan_cancel_files())
            .await
            .expect("a held gate must not delay reconciliation");
    }
    assert!(ready.handle().is_hard_cancelled());
    assert!(!ready_marker.exists());
    assert!(!blocked.is_cancelled());
    assert!(blocked_marker.exists());
    assert_eq!(scanner.deliveries.lock().unwrap().futures.len(), 1);

    let watcher = LocalCancelWatcher::start(scanner.clone());
    drop(guard);
    tokio::time::timeout(Duration::from_secs(2), blocked.token().cancelled())
        .await
        .expect("pending cancellation should complete after gate release");
    wait_for_marker_cleanup(&scanner, &blocked_marker).await;
    watcher.shutdown().await;
}

#[tokio::test]
async fn blocked_delivery_allows_later_markers_and_shutdown() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = empty_cancel_tokens();
    let scanner = scanner(dir.path(), tokens.clone());
    let blocked_id = RunId::new_v4();
    let blocked = insert_cancel_registration(&tokens, blocked_id).await;
    let guard = blocked.handle().transfer_guard().await;
    write_job(dir.path(), blocked_id);
    let blocked_marker = write_cancel(dir.path(), blocked_id);
    scanner.mark_owned_claim(blocked_id).await;
    let watcher = LocalCancelWatcher::start(scanner.clone());
    tokio::time::timeout(Duration::from_secs(2), scanner.wait_for_scan_count(1))
        .await
        .expect("watcher should finish discovering the blocked marker");

    let later_id = RunId::new_v4();
    let later = insert_cancel_registration(&tokens, later_id).await;
    write_job(dir.path(), later_id);
    write_cancel(dir.path(), later_id);
    tokio::time::timeout(Duration::from_secs(2), later.token().cancelled())
        .await
        .expect("later marker should progress while the earlier gate is held");
    assert!(!blocked.is_cancelled());
    assert!(blocked_marker.exists());

    tokio::time::timeout(Duration::from_secs(2), watcher.shutdown())
        .await
        .expect("shutdown must not wait for a transfer gate");
    // A scan racing after shutdown must not recreate pending deliveries.
    scanner.scan_cancel_files().await;
    drop(guard);
    let _guard = tokio::time::timeout(Duration::from_secs(2), blocked.handle().transfer_guard())
        .await
        .expect("shutdown should release the pending gate waiter");
    assert!(!blocked.is_cancelled());
    assert!(blocked_marker.exists());
}

#[tokio::test]
async fn dropping_watcher_releases_pending_delivery_without_cancelling() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = empty_cancel_tokens();
    let scanner = scanner(dir.path(), tokens.clone());
    let run_id = RunId::new_v4();
    let registration = insert_cancel_registration(&tokens, run_id).await;
    let guard = registration.handle().transfer_guard().await;
    write_job(dir.path(), run_id);
    let marker = write_cancel(dir.path(), run_id);
    scanner.mark_owned_claim(run_id).await;
    let watcher = LocalCancelWatcher::start(scanner.clone());
    tokio::time::timeout(Duration::from_secs(2), scanner.wait_for_scan_count(1))
        .await
        .expect("watcher should discover the blocked marker");

    drop(watcher);
    drop(guard);
    let _guard = tokio::time::timeout(
        Duration::from_secs(2),
        registration.handle().transfer_guard(),
    )
    .await
    .expect("dropping the watcher should release its queued gate waiter");
    assert!(!registration.is_cancelled());
    assert!(marker.exists());
}

#[tokio::test]
async fn deferred_cancellation_keeps_registration_identity_and_preclaim_marker() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = empty_cancel_tokens();
    let scanner = scanner(dir.path(), tokens.clone());
    let run_id = RunId::new_v4();
    let original = insert_cancel_registration(&tokens, run_id).await;
    let original_guard = original.handle().transfer_guard().await;
    write_job(dir.path(), run_id);
    let marker = write_cancel(dir.path(), run_id);
    scanner.scan_cancel_files().await;

    assert!(original.unregister().await);
    let replacement = insert_cancel_registration(&tokens, run_id).await;
    let replacement_guard = replacement.handle().transfer_guard().await;
    scanner.scan_cancel_files().await;
    assert_eq!(scanner.deliveries.lock().unwrap().futures.len(), 2);
    let watcher = LocalCancelWatcher::start(scanner.clone());

    drop(original_guard);
    tokio::time::timeout(Duration::from_secs(2), original.token().cancelled())
        .await
        .expect("the deferred request must still cancel its original registration");
    assert!(!replacement.is_cancelled());
    assert!(marker.exists());

    drop(replacement_guard);
    tokio::time::timeout(Duration::from_secs(2), replacement.token().cancelled())
        .await
        .expect("the replacement's separate delivery should also complete");
    scanner.scan_cancel_files().await;
    assert!(
        marker.exists(),
        "pre-claim cancellation must retain the marker"
    );
    scanner.mark_owned_claim(run_id).await;
    scanner.scan_cancel_files().await;
    assert!(!marker.exists());
    watcher.shutdown().await;
}

#[tokio::test]
async fn cancel_file_triggers_token() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = empty_cancel_tokens();
    let run_id = RunId::new_v4();
    let registration = insert_cancel_registration(&tokens, run_id).await;
    let job_token = registration.token();
    let signals = registration.handle().signals();
    write_job(dir.path(), run_id);
    write_cancel(dir.path(), run_id);

    scanner(dir.path(), tokens).scan_cancel_files().await;

    assert!(job_token.is_cancelled(), "cancel token should be triggered");
    assert!(signals.hard().is_cancelled());
    assert!(!signals.cooperative_user().is_cancelled());
}

#[tokio::test]
async fn cancel_file_deleted_after_owned_trigger() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = empty_cancel_tokens();
    let run_id = RunId::new_v4();
    let registration = insert_cancel_registration(&tokens, run_id).await;
    let job_token = registration.token();
    write_job(dir.path(), run_id);
    let cancel_path = write_cancel(dir.path(), run_id);
    let scanner = scanner(dir.path(), tokens);
    scanner.mark_owned_claim(run_id).await;

    scanner.scan_cancel_files().await;

    assert!(job_token.is_cancelled(), "cancel token should be triggered");
    assert!(
        !cancel_path.exists(),
        "cancel file should be deleted after triggering an owned token"
    );
}

#[tokio::test]
async fn cancel_file_with_preclaim_token_is_kept() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = empty_cancel_tokens();
    let run_id = RunId::new_v4();
    let registration = insert_cancel_registration(&tokens, run_id).await;
    let job_token = registration.token();
    write_job(dir.path(), run_id);
    let cancel_path = write_cancel(dir.path(), run_id);

    scanner(dir.path(), tokens).scan_cancel_files().await;

    assert!(
        job_token.is_cancelled(),
        "pre-claim token should be cancelled"
    );
    assert!(
        cancel_path.exists(),
        "cancel file should stay until this runner owns the claim"
    );
}

#[tokio::test]
async fn cancel_file_with_preclaim_token_and_other_runner_claim_is_kept() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = empty_cancel_tokens();
    let run_id = RunId::new_v4();
    let registration = insert_cancel_registration(&tokens, run_id).await;
    let job_token = registration.token();
    let cancel_path = write_cancel(dir.path(), run_id);
    write_claim(dir.path(), run_id);

    scanner(dir.path(), tokens).scan_cancel_files().await;

    assert!(
        job_token.is_cancelled(),
        "pre-claim token should still observe cancellation"
    );
    assert!(
        cancel_path.exists(),
        "cancel file should stay for the runner that owns the claim"
    );
}

#[tokio::test]
async fn cancel_file_with_token_but_no_pending_target_is_deleted() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = empty_cancel_tokens();
    let run_id = RunId::new_v4();
    let registration = insert_cancel_registration(&tokens, run_id).await;
    let job_token = registration.token();
    let cancel_path = write_cancel(dir.path(), run_id);

    scanner(dir.path(), tokens).scan_cancel_files().await;

    assert!(
        job_token.is_cancelled(),
        "stale token should still be cancelled"
    );
    assert!(
        !cancel_path.exists(),
        "cancel file should be deleted when no claim or job target remains"
    );
}

#[tokio::test]
async fn cancel_file_with_token_terminal_result_and_leftover_claim_is_deleted() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = empty_cancel_tokens();
    let run_id = RunId::new_v4();
    let registration = insert_cancel_registration(&tokens, run_id).await;
    let job_token = registration.token();
    let cancel_path = write_cancel(dir.path(), run_id);
    write_result(dir.path(), run_id, b"terminal");
    write_claim(dir.path(), run_id);

    scanner(dir.path(), tokens).scan_cancel_files().await;

    assert!(
        job_token.is_cancelled(),
        "stale token should still observe the cancel"
    );
    assert!(
        !cancel_path.exists(),
        "terminal result should let stale token markers be deleted"
    );
}

#[tokio::test]
async fn cancel_watcher_triggers_owned_token_without_discover() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = empty_cancel_tokens();
    let scanner = scanner(dir.path(), tokens.clone());
    let run_id = RunId::new_v4();
    let registration = insert_cancel_registration(&tokens, run_id).await;
    let job_token = registration.token();
    write_job(dir.path(), run_id);
    write_cancel(dir.path(), run_id);
    scanner.mark_owned_claim(run_id).await;

    let watcher = LocalCancelWatcher::start(scanner);
    tokio::time::timeout(Duration::from_secs(2), job_token.cancelled())
        .await
        .expect("cancel watcher should trigger token");

    watcher.shutdown().await;
}

#[tokio::test]
async fn cancel_watcher_shutdown_is_idempotent() {
    let dir = tempfile::tempdir().unwrap();
    let watcher = LocalCancelWatcher::start(scanner(dir.path(), empty_cancel_tokens()));

    tokio::time::timeout(Duration::from_secs(2), watcher.shutdown())
        .await
        .expect("first shutdown should complete");
    tokio::time::timeout(Duration::from_secs(2), watcher.shutdown())
        .await
        .expect("second shutdown should complete");
}

#[tokio::test]
async fn owned_claim_without_cancel_token_is_pruned() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = empty_cancel_tokens();
    let run_id = RunId::new_v4();
    let registration = tokens.register(run_id).await.unwrap();
    let scanner = scanner(dir.path(), tokens.clone());
    scanner.mark_owned_claim(run_id).await;
    assert!(
        scanner
            .snapshot_owned_claims(&[run_id])
            .await
            .contains(&run_id),
        "claim should be tracked as locally owned"
    );

    scanner.prune_owned_claims_without_tokens().await;
    assert!(
        scanner
            .snapshot_owned_claims(&[run_id])
            .await
            .contains(&run_id),
        "owned claim should stay while its cancel token is still active"
    );

    registration.unregister().await;
    scanner.prune_owned_claims_without_tokens().await;

    assert!(
        !scanner
            .snapshot_owned_claims(&[run_id])
            .await
            .contains(&run_id),
        "owned claim should be pruned after token cleanup"
    );
}

#[tokio::test]
async fn cancel_file_without_pending_target_is_deleted() {
    let dir = tempfile::tempdir().unwrap();
    let unknown_id = RunId::new_v4();
    let cancel_path = write_cancel(dir.path(), unknown_id);

    scanner(dir.path(), empty_cancel_tokens())
        .scan_cancel_files()
        .await;

    assert!(
        !cancel_path.exists(),
        "cancel file should be deleted when no pending target exists"
    );
}

#[tokio::test]
async fn cancel_file_is_kept_when_job_scan_fails() {
    let dir = tempfile::tempdir().unwrap();
    let run_id = RunId::new_v4();
    let cancel_path = write_cancel(dir.path(), run_id);
    std::fs::write(local_queue::jobs_dir(dir.path()), b"not a directory").unwrap();

    scanner(dir.path(), empty_cancel_tokens())
        .scan_cancel_files()
        .await;

    assert!(
        cancel_path.exists(),
        "cancel file should stay when the pending target state is unknown"
    );
}

#[tokio::test]
async fn cancel_file_with_claim_owned_by_other_runner_is_kept() {
    let dir = tempfile::tempdir().unwrap();
    let run_id = RunId::new_v4();
    let cancel_path = write_cancel(dir.path(), run_id);
    write_claim(dir.path(), run_id);

    scanner(dir.path(), empty_cancel_tokens())
        .scan_cancel_files()
        .await;

    assert!(
        cancel_path.exists(),
        "cancel file should be kept when another runner may own the claim"
    );
}

#[tokio::test]
async fn cancel_file_with_terminal_result_and_leftover_job_is_deleted() {
    let dir = tempfile::tempdir().unwrap();
    let run_id = RunId::new_v4();
    let cancel_path = write_cancel(dir.path(), run_id);
    write_result(dir.path(), run_id, b"terminal");
    write_job(dir.path(), run_id);

    scanner(dir.path(), empty_cancel_tokens())
        .scan_cancel_files()
        .await;

    assert!(
        !cancel_path.exists(),
        "cancel file should be deleted when the result is already terminal"
    );
}

#[tokio::test]
async fn cancel_file_with_terminal_result_and_leftover_claim_is_deleted() {
    let dir = tempfile::tempdir().unwrap();
    let run_id = RunId::new_v4();
    let cancel_path = write_cancel(dir.path(), run_id);
    write_result(dir.path(), run_id, b"terminal");
    write_claim(dir.path(), run_id);

    scanner(dir.path(), empty_cancel_tokens())
        .scan_cancel_files()
        .await;

    assert!(
        !cancel_path.exists(),
        "terminal result should make a leftover claim non-pending"
    );
}

#[tokio::test]
async fn cancel_file_with_empty_result_and_pending_job_is_kept() {
    let dir = tempfile::tempdir().unwrap();
    let run_id = RunId::new_v4();
    let cancel_path = write_cancel(dir.path(), run_id);
    write_result(dir.path(), run_id, b"");
    write_job(dir.path(), run_id);

    scanner(dir.path(), empty_cancel_tokens())
        .scan_cancel_files()
        .await;

    assert!(
        cancel_path.exists(),
        "empty result file is not terminal, so cancel should stay pending"
    );
}

#[tokio::test]
async fn cancel_file_before_token_survives_until_token_inserted() {
    let dir = tempfile::tempdir().unwrap();
    let tokens = empty_cancel_tokens();
    let scanner = scanner(dir.path(), tokens.clone());
    let run_id = RunId::new_v4();
    let cancel_path = write_cancel(dir.path(), run_id);
    write_job(dir.path(), run_id);

    scanner.scan_cancel_files().await;
    assert!(
        cancel_path.exists(),
        "cancel file should survive while there is no token"
    );

    let registration = insert_cancel_registration(&tokens, run_id).await;
    let job_token = registration.token();
    scanner.mark_owned_claim(run_id).await;
    scanner.scan_cancel_files().await;

    assert!(
        job_token.is_cancelled(),
        "token should be cancelled on second scan"
    );
    assert!(
        !cancel_path.exists(),
        "cancel file should be deleted after trigger"
    );
}
