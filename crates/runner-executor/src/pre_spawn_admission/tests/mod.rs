use std::future::Future;
use std::panic::AssertUnwindSafe;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::Duration;

use super::*;

const TEST_TIMEOUT: Duration = Duration::from_secs(2);

fn assert_pending<T>(future: Pin<&mut impl Future<Output = T>>) {
    let waker = futures_util::task::noop_waker();
    let mut context = Context::from_waker(&waker);
    assert!(matches!(future.poll(&mut context), Poll::Pending));
}

#[tokio::test]
async fn clones_share_weighted_capacity() {
    let admission = PreSpawnAdmission::new(3).unwrap();
    let other = admission.clone();
    let cancel = CancellationToken::new();
    let first_lease = admission.acquire(2, &cancel).await.unwrap();
    let second_lease = other.acquire(1, &cancel).await.unwrap();
    let mut blocked = Box::pin(admission.acquire(1, &cancel));

    assert_pending(blocked.as_mut());
    drop(second_lease);
    let acquired = tokio::time::timeout(TEST_TIMEOUT, blocked)
        .await
        .unwrap()
        .unwrap();

    assert!(acquired.metadata().contended);
    drop(first_lease);
}

#[tokio::test]
async fn cancelled_waiter_does_not_leak_capacity() {
    let admission = PreSpawnAdmission::new(2).unwrap();
    let holder_cancel = CancellationToken::new();
    let holder = admission.acquire(1, &holder_cancel).await.unwrap();
    let waiter_cancel = CancellationToken::new();
    let mut waiter = Box::pin(admission.acquire(2, &waiter_cancel));

    assert_pending(waiter.as_mut());
    waiter_cancel.cancel();
    assert!(matches!(
        tokio::time::timeout(TEST_TIMEOUT, waiter).await.unwrap(),
        Err(RunnerError::Cancelled)
    ));
    drop(holder);

    let full = tokio::time::timeout(TEST_TIMEOUT, admission.acquire(2, &holder_cancel))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(full.metadata().effective_tokens, 2);
}

#[tokio::test]
async fn mixed_weight_waiters_keep_fifo_order() {
    let admission = PreSpawnAdmission::new(2).unwrap();
    let cancel = CancellationToken::new();
    let holder = admission.acquire(1, &cancel).await.unwrap();
    let mut first = Box::pin(admission.acquire(2, &cancel));
    assert_pending(first.as_mut());
    let mut second = Box::pin(admission.acquire(1, &cancel));
    assert_pending(second.as_mut());

    drop(holder);
    let first_lease = tokio::time::timeout(TEST_TIMEOUT, first)
        .await
        .unwrap()
        .unwrap();
    assert_pending(second.as_mut());

    drop(first_lease);
    tokio::time::timeout(TEST_TIMEOUT, second)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn oversized_request_runs_alone() {
    let admission = PreSpawnAdmission::new(2).unwrap();
    let cancel = CancellationToken::new();
    let oversized = admission.acquire(8, &cancel).await.unwrap();
    assert_eq!(
        oversized.metadata(),
        PreSpawnAdmissionMetadata {
            requested_tokens: 8,
            effective_tokens: 2,
            total_tokens: 2,
            contended: false,
        }
    );
    let mut blocked = Box::pin(admission.acquire(1, &cancel));
    assert_pending(blocked.as_mut());

    drop(oversized);
    tokio::time::timeout(TEST_TIMEOUT, blocked)
        .await
        .unwrap()
        .unwrap();
}

#[tokio::test]
async fn drop_and_unwind_release_capacity() {
    let admission = PreSpawnAdmission::new(1).unwrap();
    let cancel = CancellationToken::new();

    let lease = admission.acquire(1, &cancel).await.unwrap();
    drop(lease);
    admission.acquire(1, &cancel).await.unwrap();

    let lease = admission.acquire(1, &cancel).await.unwrap();
    let panic = std::panic::catch_unwind(AssertUnwindSafe(|| {
        let _lease = lease;
        panic!("release admission lease during unwind");
    }));
    assert!(panic.is_err());
    admission.acquire(1, &cancel).await.unwrap();
}

#[tokio::test]
async fn background_admission_is_immediate_and_single_flight() {
    let admission = PreSpawnAdmission::new(3).unwrap();
    let background = admission.try_acquire_background(2).unwrap().unwrap();

    assert!(admission.try_acquire_background(1).unwrap().is_none());
    let cancel = CancellationToken::new();
    let real = admission.acquire(1, &cancel).await.unwrap();
    assert!(!real.metadata().contended);
    drop(real);
    drop(background);
    assert!(admission.try_acquire_background(3).unwrap().is_some());
}

#[tokio::test]
async fn real_waiter_cancels_background_admission() {
    let admission = PreSpawnAdmission::new(2).unwrap();
    let background = admission.try_acquire_background(2).unwrap().unwrap();
    let background_cancel = background.cancellation_token();
    let cancel = CancellationToken::new();
    let mut real = Box::pin(admission.acquire(1, &cancel));

    assert_pending(real.as_mut());
    assert!(background_cancel.is_cancelled());
    assert!(admission.try_acquire_background(1).unwrap().is_none());

    drop(background);
    let real = tokio::time::timeout(TEST_TIMEOUT, real)
        .await
        .unwrap()
        .unwrap();
    assert!(real.metadata().contended);
}

#[tokio::test]
async fn cancelled_real_waiter_reopens_background_admission() {
    let admission = PreSpawnAdmission::new(1).unwrap();
    let holder_cancel = CancellationToken::new();
    let holder = admission.acquire(1, &holder_cancel).await.unwrap();
    let waiter_cancel = CancellationToken::new();
    let mut waiter = Box::pin(admission.acquire(1, &waiter_cancel));

    assert_pending(waiter.as_mut());
    waiter_cancel.cancel();
    assert!(matches!(waiter.await, Err(RunnerError::Cancelled)));
    drop(holder);

    assert!(admission.try_acquire_background(1).unwrap().is_some());
}
