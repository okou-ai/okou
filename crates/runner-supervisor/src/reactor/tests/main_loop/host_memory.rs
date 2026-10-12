use super::super::super::*;
use super::super::support::{mock_run_config, shutdown, test_profiles, wait_status_mode};
use crate::host_memory::HostMemoryObserver;
use tracing_subscriber::prelude::*;
use tracing_test_support::CapturedEvents;

#[tokio::test]
async fn reactor_pool_wait_does_not_block_host_sampling_and_stop_joins_owner() {
    let captured = CapturedEvents::default();
    let _subscriber =
        tracing::subscriber::set_default(tracing_subscriber::registry().with(captured.clone()));
    tracing::callsite::rebuild_interest_cache();
    let (config, env) = mock_run_config(test_profiles(), 8, 32768, 4);
    let status_path = RunnerPaths::new(config.paths.base_dir.clone()).status();
    let pool = Arc::clone(&config.shared.idle_pool);
    let held_pool = pool.lock().await;
    let observer = HostMemoryObserver::spawn();
    let run_handle = tokio::spawn(run(config));
    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            if captured.entries().iter().any(|event| {
                event.fields.get("message").map(String::as_str) == Some("host memory observation")
                    && event.fields.get("valid").map(String::as_str) == Some("true")
            }) {
                break;
            }
            tokio::task::yield_now().await;
        }
    })
    .await
    .unwrap();
    assert!(!run_handle.is_finished());
    drop(held_pool);
    wait_status_mode(&status_path, "running", Duration::from_secs(2)).await;
    shutdown(&env, run_handle).await;
    observer.shutdown().await.unwrap();
    assert_eq!(
        captured
            .entries()
            .iter()
            .filter(|event| {
                event.fields.get("message").map(String::as_str)
                    == Some("host memory observer stopped")
            })
            .count(),
        1
    );
}
