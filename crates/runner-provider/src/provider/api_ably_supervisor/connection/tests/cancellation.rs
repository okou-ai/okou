use tokio_util::task::AbortOnDrop;

use super::*;

async fn pending_connection() -> (AblyConnection, AbortOnDrop, Arc<AtomicBool>) {
    let started = Arc::new(Notify::new());
    let retired = Arc::new(AtomicBool::new(false));
    let mut connection = AblyConnection::new(None);
    connection.start_if_due(|| {
        blocked_token_config(
            Arc::clone(&started),
            Arc::new(Semaphore::new(0)),
            Arc::clone(&retired),
        )
    });
    let Phase::Connecting(task) = &connection.phase else {
        panic!("connection attempt was not started");
    };
    // Keep failure cleanup alive past the assertions so it cannot cause success.
    let retirement = AbortOnDrop::new(task.abort_handle());
    tokio::time::timeout(Duration::from_secs(2), started.notified())
        .await
        .unwrap();
    (connection, retirement, retired)
}

async fn assert_token_task_retired(retirement: &AbortOnDrop, retired: &AtomicBool) {
    tokio::time::timeout(Duration::from_secs(2), async {
        while !retirement.is_finished() {
            tokio::task::yield_now().await;
        }
    })
    .await
    .expect("abandoned connection kept its token task alive");
    assert!(retired.load(Ordering::Acquire));
}

#[tokio::test]
async fn dropping_connection_retires_pending_token_call() {
    let (connection, retirement, retired) = pending_connection().await;

    drop(connection);

    assert_token_task_retired(&retirement, &retired).await;
}

#[tokio::test]
async fn dropping_unpolled_shutdown_retires_pending_token_call() {
    let (connection, retirement, retired) = pending_connection().await;
    let shutdown = connection.shutdown();

    drop(shutdown);

    assert_token_task_retired(&retirement, &retired).await;
}
