use super::super::support::MockRunEnv;

use std::time::Duration;

use runner_types::ids::RunId;

pub(super) fn assert_no_completion_for_run(env: &MockRunEnv, run_id: RunId, reason: &str) {
    let completions = env.handle.completions.lock().unwrap();
    assert!(
        !completions
            .iter()
            .any(|completion| completion.run_id == run_id),
        "{reason}"
    );
}

pub(super) async fn assert_successful_completion_for_run(
    env: &MockRunEnv,
    run_id: RunId,
    reason: &str,
) {
    let completion = env
        .handle
        .wait_completion(run_id, Duration::from_secs(5))
        .await
        .expect(reason);
    assert_eq!(completion.exit_code, 0);
    assert!(completion.error.is_none(), "{reason}");
    let completions = env.handle.completions.lock().unwrap();
    assert_eq!(
        completions
            .iter()
            .filter(|completion| completion.run_id == run_id)
            .count(),
        1,
        "host completion must be reported exactly once",
    );
}
