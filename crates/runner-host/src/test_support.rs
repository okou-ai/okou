//! Crate-private helpers for tests that must isolate process environment state.

use std::ffi::OsStr;
use std::process::Stdio;
use std::time::Duration;

const CHILD_ENV_GUARD_ACTIVE_PREFIX: &str = "ignored child env guard active: ";

pub async fn run_ignored_child_test(
    child_test_name: &str,
    env_guard: (&str, &str),
    child_env: &[(&str, Option<&str>)],
    timeout: Duration,
) {
    let (guard_key, guard_value) = env_guard;
    let mut command =
        tokio::process::Command::new(std::env::current_exe().expect("resolve current test binary"));
    command
        .arg("--exact")
        .arg(child_test_name)
        .arg("--ignored")
        .arg("--nocapture")
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .env(guard_key, guard_value);
    for &(key, value) in child_env {
        match value {
            Some(value) => {
                command.env(key, value);
            }
            None => {
                command.env_remove(key);
            }
        }
    }

    let child = command.spawn().expect("spawn ignored child test");
    let output = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .unwrap_or_else(|_| panic!("ignored child test {child_test_name} timed out"))
        .unwrap_or_else(|error| panic!("wait for ignored child test {child_test_name}: {error}"));
    assert!(
        output.status.success(),
        "ignored child test {child_test_name} failed\nstdout:\n{}\nstderr:\n{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr),
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.contains(child_test_name),
        "ignored child test {child_test_name} did not run\nstdout:\n{stdout}"
    );
    assert!(
        stdout.contains(&format!("{CHILD_ENV_GUARD_ACTIVE_PREFIX}{guard_key}")),
        "ignored child test {child_test_name} did not activate {guard_key}\nstdout:\n{stdout}"
    );
}

pub fn ignored_child_test_env_guard_enabled(env_guard: (&str, &str)) -> bool {
    let (key, value) = env_guard;
    if std::env::var_os(key).as_deref() != Some(OsStr::new(value)) {
        return false;
    }
    println!("{CHILD_ENV_GUARD_ACTIVE_PREFIX}{key}");
    true
}
