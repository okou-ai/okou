use super::{Failure, Key, Work, fixture::bounded};
use std::sync::Arc;
use tokio::sync::Semaphore;

#[tokio::test]
async fn post_ready_work_failure_survives_cancellation_and_distinct_physical_cleanup_failure() {
    let pool = Arc::new(super::super::Pool::new());
    let registry = super::super::Registry::new(Arc::clone(&pool));
    let fail = Arc::new(Semaphore::new(0));
    let cleanup = Arc::new(Semaphore::new(1));
    // Release the finalizer on unwind so failed assertions cannot block runtime shutdown.
    let cleanup_gate = cleanup.try_acquire().unwrap();
    let worker_fail = Arc::clone(&fail);
    let worker_cleanup = Arc::clone(&cleanup);
    let work: Work = Box::new(move |control| {
        Box::pin(async move {
            control.retain_finalizer(Box::pin(async move {
                worker_cleanup.acquire().await.unwrap().forget();
                Err(Failure::CleanupTimedOut)
            }))?;
            control.ready();
            worker_fail.acquire().await.unwrap().forget();
            Err(Failure::DomainFailed)
        })
    });
    let key = Key {
        configuration: uuid::Uuid::new_v4(),
        generation: 1,
    };
    let node = registry.acquire(key, work).unwrap();
    let source = node.diagnostic_source(key);
    node.start();
    bounded(node.ready()).await.unwrap();
    fail.add_permits(1);
    bounded(async {
        while source.evidence.terminal().is_none() {
            tokio::task::yield_now().await;
        }
    })
    .await;
    registry.close();
    assert_eq!(bounded(node.ready()).await, Err(Failure::DomainFailed));
    let pending = serde_json::to_value(&source).unwrap();
    assert_eq!(pending["evidence"]["ready"], true);
    assert_eq!(pending["evidence"]["terminal"], "domain_failed");
    assert_eq!(pending["evidence"]["cleanup_complete"], false);
    let physical = node.physical();
    drop(node);
    drop(cleanup_gate);
    assert_eq!(bounded(physical).await, Err(Failure::CleanupTimedOut));
    let completed = serde_json::to_value(&source).unwrap();
    assert_eq!(completed["evidence"]["terminal"], "domain_failed");
    assert_eq!(
        completed["evidence"]["cleanup_failure"],
        "cleanup_timed_out"
    );
    assert_eq!(completed["evidence"]["cleanup_complete"], true);
}

#[tokio::test]
async fn retirement_between_source_failure_and_readiness_publication_preserves_first_cause() {
    let pool = Arc::new(super::super::Pool::new());
    let registry = super::super::Registry::new(pool);
    let work: Work = Box::new(|control| {
        Box::pin(async move {
            control.cancelled().cancelled().await;
            Ok(())
        })
    });
    let key = Key {
        configuration: uuid::Uuid::new_v4(),
        generation: 1,
    };
    let node = registry.acquire(key, work).unwrap();
    node.start();
    // The producer has latched its work failure but has not yet notified startup
    // waiters. A concurrent retirement must publish that same first cause.
    node.diagnostic_source(key)
        .evidence
        .terminate(Failure::DomainFailed);
    registry.close();
    assert_eq!(bounded(node.ready()).await, Err(Failure::DomainFailed));
    let physical = node.physical();
    drop(node);
    bounded(physical).await.unwrap();
}
