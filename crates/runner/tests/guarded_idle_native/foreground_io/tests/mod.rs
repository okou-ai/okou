use super::*;
use runner_host::test_fixtures::ignored_child::{
    ignored_child_test_env_guard_enabled, run_ignored_child_test,
};
use std::{sync::Arc, time::Duration};

const CHILD: (&str, &str) = ("OKOU_NATIVE_FOREGROUND_IO_CHILD", "1");

#[tokio::test]
async fn accepted_kernel_reader_waits_for_external_byte_and_joins() {
    run_ignored_child_test(
        "foreground_io::tests::blocked_kernel_reader_child",
        CHILD,
        &[],
        Duration::from_secs(5),
    )
    .await;
}

#[tokio::test]
#[ignore = "executed by accepted_kernel_reader_waits_for_external_byte_and_joins"]
async fn blocked_kernel_reader_child() {
    if !ignored_child_test_env_guard_enabled(CHILD) {
        return;
    }
    let gate = Arc::new(Gate::new().unwrap());
    let reader = gate.clone();
    let work = tokio::task::spawn_blocking(move || reader.blocking_wait());
    gate.wait_entered().await.unwrap();
    assert!(!work.is_finished());
    let observation = super::super::foreground_probe::observe().await.unwrap();
    assert!(observation["available_bytes"].as_u64().unwrap() > 0);
    assert!(!work.is_finished());
    gate.release().unwrap();
    work.await.unwrap().unwrap();
    gate.release().unwrap();
}
