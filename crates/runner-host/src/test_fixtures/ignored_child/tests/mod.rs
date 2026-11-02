#[cfg(target_os = "linux")]
use std::os::unix::process::CommandExt as _;

use super::*;

const LARGE_SUCCESS_OUTPUT_CHILD_ENV: &str = "OKOU_RUN_IGNORED_CHILD_LARGE_SUCCESS_OUTPUT_TEST";
const LARGE_OUTPUT_CHILD_ENV: &str = "OKOU_RUN_IGNORED_CHILD_LARGE_OUTPUT_TEST";
const CAPTURE_OUTPUT_CHILD_ENV: &str = "OKOU_RUN_IGNORED_CHILD_CAPTURE_OUTPUT_TEST";
const TIMEOUT_CHILD_ENV: &str = "OKOU_RUN_IGNORED_CHILD_TIMEOUT_TEST";
#[cfg(target_os = "linux")]
const OUTPUT_TIMEOUT_CHILD_ENV: &str = "OKOU_RUN_IGNORED_CHILD_OUTPUT_TIMEOUT_TEST";
#[cfg(target_os = "linux")]
const OUTPUT_TIMEOUT_EXIT_ENV: &str = "OKOU_RUN_IGNORED_CHILD_OUTPUT_TIMEOUT_EXIT";
#[cfg(target_os = "linux")]
const QUIET_CHILD_ENV: &str = "OKOU_RUN_IGNORED_CHILD_QUIET_TEST";
#[cfg(target_os = "linux")]
const QUIET_CHILD_FAIL_ENV: &str = "OKOU_RUN_IGNORED_CHILD_QUIET_FAIL";

#[tokio::test]
async fn run_ignored_child_test_preserves_tail_after_large_output() {
    let output = run_ignored_child_test(
        "test_fixtures::ignored_child::tests::run_ignored_child_test_large_success_output_child",
        (LARGE_SUCCESS_OUTPUT_CHILD_ENV, "1"),
        &[],
        Duration::from_secs(5),
    )
    .await;
    assert!(output.truncated);
    assert!(output.stdout.contains("[truncated "));
}

#[tokio::test]
async fn run_ignored_child_test_returns_complete_small_output() {
    let output = run_ignored_child_test(
        "test_fixtures::ignored_child::tests::run_ignored_child_test_capture_output_child",
        (CAPTURE_OUTPUT_CHILD_ENV, "1"),
        &[],
        Duration::from_secs(5),
    )
    .await;
    assert!(!output.truncated);
    assert!(output.stdout.contains("child stdout capture"));
    assert!(output.stderr.contains("child stderr capture"));
}

#[test]
#[ignore]
fn run_ignored_child_test_capture_output_child() {
    if !ignored_child_test_env_guard_enabled((CAPTURE_OUTPUT_CHILD_ENV, "1")) {
        return;
    }
    println!("child stdout capture");
    eprintln!("child stderr capture");
}

#[test]
#[ignore]
fn run_ignored_child_test_large_success_output_child() {
    if !ignored_child_test_env_guard_enabled((LARGE_SUCCESS_OUTPUT_CHILD_ENV, "1")) {
        return;
    }

    write_large_ignored_child_stdout();
}

#[tokio::test]
#[should_panic(expected = "[truncated ")]
async fn run_ignored_child_test_truncates_large_output() {
    run_ignored_child_test(
        "test_fixtures::ignored_child::tests::run_ignored_child_test_large_output_child",
        (LARGE_OUTPUT_CHILD_ENV, "1"),
        &[],
        Duration::from_secs(5),
    )
    .await;
}

#[test]
#[ignore]
fn run_ignored_child_test_large_output_child() {
    if !ignored_child_test_env_guard_enabled((LARGE_OUTPUT_CHILD_ENV, "1")) {
        return;
    }

    write_large_ignored_child_stdout();
    panic!("large output child failed intentionally");
}

fn write_large_ignored_child_stdout() {
    let output =
        vec![
            b'x';
            CHILD_OUTPUT_HEAD_BYTES + CHILD_OUTPUT_TAIL_BYTES + CHILD_OUTPUT_READ_CHUNK_BYTES
        ];
    std::io::Write::write_all(&mut std::io::stdout().lock(), &output)
        .expect("write large ignored child stdout");
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn run_ignored_child_test_quiet_descendant_after_successful_exit() {
    assert_quiet_descendant_cleaned_up(false).await;
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn run_ignored_child_test_quiet_descendant_after_failed_exit() {
    assert_quiet_descendant_cleaned_up(true).await;
}

#[cfg(target_os = "linux")]
async fn assert_quiet_descendant_cleaned_up(fail: bool) {
    let dir = tempfile::tempdir().unwrap();
    let readiness_path = dir.path().join("descendant-ready");
    let readiness_value = readiness_path.to_str().unwrap().to_owned();
    let child_test_name = "test_fixtures::ignored_child::tests::run_ignored_child_test_quiet_child";
    let task = tokio::spawn(async move {
        run_ignored_child_test(
            child_test_name,
            (QUIET_CHILD_ENV, &readiness_value),
            &[(QUIET_CHILD_FAIL_ENV, Some(if fail { "1" } else { "0" }))],
            Duration::from_secs(5),
        )
        .await;
    });
    let result = task.await;
    let identity = read_descendant_identity(&readiness_path);
    assert_descendant_exited(&identity).await;

    if fail {
        let panic = result
            .expect_err("failed child test must fail the fixture")
            .into_panic();
        let message = panic
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| panic.downcast_ref::<&str>().copied())
            .expect("fixture panic must contain a string");
        for expected in [
            &format!("ignored child test {child_test_name} failed"),
            "status: exit status: 101",
            "quiet child failed intentionally",
            "quiet-child stdout marker",
            "quiet-child stderr marker",
            "[truncated ",
        ] {
            assert!(
                message.contains(expected),
                "missing {expected:?}: {message}"
            );
        }
    } else {
        result.expect("successful child test must pass after descendant cleanup");
    }
}

#[cfg(target_os = "linux")]
#[test]
#[ignore]
fn run_ignored_child_test_quiet_child() {
    let Ok(readiness_path) = std::env::var(QUIET_CHILD_ENV) else {
        return;
    };
    if !ignored_child_test_env_guard_enabled((QUIET_CHILD_ENV, &readiness_path)) {
        return;
    }
    let fail = std::env::var(QUIET_CHILD_FAIL_ENV).expect("quiet child failure mode");
    // The parent fixture owns this descendant after the child test exits.
    let descendant = std::process::Command::new("sleep")
        .arg("60")
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .expect("spawn quiet descendant");
    let pid = descendant.id();
    let ProcessStatRead::Found(stat) = crate::process::read_process_stat_checked_blocking(pid)
    else {
        panic!("quiet descendant stat must be readable");
    };
    assert!(process_stat_is_live(&stat));
    assert_eq!(stat.pgid, i32::try_from(pid).unwrap());
    assert_eq!(
        process_session_id(libc::pid_t::try_from(pid).unwrap()),
        Ok(nix::unistd::getsid(None).unwrap().as_raw())
    );
    write_large_ignored_child_stdout();
    println!("quiet-child stdout marker");
    eprintln!("quiet-child stderr marker");
    std::fs::write(
        &readiness_path,
        format!("{pid} {} {}\n", stat.pgid, stat.starttime),
    )
    .expect("publish quiet descendant readiness");
    // Relinquish the child handle without waiting; the fixture must finish cleanup.
    drop(descendant);
    assert_ne!(fail, "1", "quiet child failed intentionally");
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn run_ignored_child_test_output_timeout_cleans_up_after_failed_exit() {
    assert_output_timeout_cleans_up_descendant("1").await;
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn run_ignored_child_test_output_timeout_cleans_up_after_successful_exit() {
    assert_output_timeout_cleans_up_descendant("0").await;
}

#[cfg(target_os = "linux")]
async fn assert_output_timeout_cleans_up_descendant(exit_code: &'static str) {
    let dir = tempfile::tempdir().unwrap();
    let readiness_path = dir.path().join("descendant-ready");
    let task_readiness_path = readiness_path.clone();
    let readiness_value = readiness_path.to_str().unwrap().to_owned();
    let child_test_name =
        "test_fixtures::ignored_child::tests::run_ignored_child_test_output_timeout_child";
    let task = tokio::spawn(async move {
        run_ignored_child_test_with_readiness(
            child_test_name,
            (OUTPUT_TIMEOUT_CHILD_ENV, &readiness_value),
            &[(OUTPUT_TIMEOUT_EXIT_ENV, Some(exit_code))],
            Duration::from_secs(5),
            Some(&task_readiness_path),
        )
        .await;
    });
    let result = task.await;
    let identity = read_descendant_identity(&readiness_path);
    assert_descendant_exited(&identity).await;

    let panic = result
        .expect_err("inherited output pipe must fail the fixture")
        .into_panic();
    let message = panic
        .downcast_ref::<String>()
        .map(String::as_str)
        .or_else(|| panic.downcast_ref::<&str>().copied())
        .expect("fixture panic must contain a string");
    for expected in [
        child_test_name,
        "collect ignored child test output timed out after",
        &format!("exit status: {exit_code}"),
        "output-timeout stdout marker",
        "output-timeout stderr marker",
        "[truncated ",
    ] {
        assert!(
            message.contains(expected),
            "missing {expected:?}: {message}"
        );
    }
    assert!(
        !message.contains("session cleanup failed"),
        "unexpected cleanup failure: {message}"
    );
}

#[cfg(target_os = "linux")]
#[test]
#[ignore]
fn run_ignored_child_test_output_timeout_child() {
    let Ok(readiness_path) = std::env::var(OUTPUT_TIMEOUT_CHILD_ENV) else {
        return;
    };
    if !ignored_child_test_env_guard_enabled((OUTPUT_TIMEOUT_CHILD_ENV, &readiness_path)) {
        return;
    }
    let exit_code: i32 = std::env::var(OUTPUT_TIMEOUT_EXIT_ENV)
        .expect("output timeout exit code")
        .parse()
        .unwrap();
    let mut command = std::process::Command::new("sleep");
    command
        .arg("60")
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(if exit_code == 1 {
            Stdio::inherit()
        } else {
            Stdio::null()
        })
        .stderr(if exit_code == 0 {
            Stdio::inherit()
        } else {
            Stdio::null()
        });
    // This ignored child exits below; the parent fixture owns descendant cleanup.
    let descendant = command.spawn().expect("spawn output-holding descendant");
    let pid = descendant.id();
    let ProcessStatRead::Found(stat) = crate::process::read_process_stat_checked_blocking(pid)
    else {
        panic!("output-holding descendant stat must be readable");
    };
    assert_eq!(stat.pgid, i32::try_from(pid).unwrap());
    assert_eq!(
        process_session_id(libc::pid_t::try_from(pid).unwrap()),
        Ok(nix::unistd::getsid(None).unwrap().as_raw())
    );
    write_large_ignored_child_stdout();
    println!("output-timeout stdout marker");
    eprintln!("output-timeout stderr marker");
    std::fs::write(
        &readiness_path,
        format!("{pid} {} {}\n", stat.pgid, stat.starttime),
    )
    .expect("publish output-holding descendant readiness");
    std::process::exit(exit_code);
}

#[cfg(target_os = "linux")]
#[tokio::test]
async fn run_ignored_child_test_timeout_kills_separate_process_group_descendant() {
    let dir = tempfile::tempdir().unwrap();
    let readiness_path = dir.path().join("descendant-ready");
    let task_readiness_path = readiness_path.clone();
    let readiness_value = task_readiness_path
        .to_str()
        .expect("temporary readiness path must be UTF-8")
        .to_owned();
    let child_test_name =
        "test_fixtures::ignored_child::tests::run_ignored_child_test_timeout_child";

    let task = tokio::spawn(async move {
        run_ignored_child_test_with_readiness(
            child_test_name,
            (TIMEOUT_CHILD_ENV, &readiness_value),
            &[],
            Duration::from_millis(10),
            Some(&task_readiness_path),
        )
        .await;
    });

    let panic = task
        .await
        .expect_err("timed out ignored child must panic")
        .into_panic();
    let panic_message = panic
        .downcast_ref::<String>()
        .map(String::as_str)
        .or_else(|| panic.downcast_ref::<&str>().copied())
        .expect("ignored child panic must contain a string message");
    assert!(
        panic_message.contains(&format!(
            "ignored child test {child_test_name} timed out after"
        )),
        "unexpected ignored child panic: {panic_message}"
    );
    assert!(
        panic_message.contains("killed child status:"),
        "ignored child cleanup did not complete successfully: {panic_message}"
    );

    let identity = read_descendant_identity(&readiness_path);
    assert_eq!(identity.pgid, i32::try_from(identity.pid).unwrap());
    match read_process_stat_checked(identity.pid).await {
        ProcessStatRead::Found(stat) => assert!(
            stat.starttime != identity.starttime || !process_stat_is_live(&stat),
            "separate-process-group descendant {} remained live after fixture timeout",
            identity.pid
        ),
        ProcessStatRead::Missing => {}
        ProcessStatRead::Unreadable(error) => {
            panic!(
                "could not verify separate-process-group descendant {} cleanup: {error}",
                identity.pid
            );
        }
        ProcessStatRead::Invalid => {
            panic!(
                "could not parse separate-process-group descendant {} state after cleanup",
                identity.pid
            );
        }
    }
}

#[cfg(target_os = "linux")]
#[test]
#[ignore]
fn run_ignored_child_test_timeout_child() {
    let Ok(readiness_path) = std::env::var(TIMEOUT_CHILD_ENV) else {
        return;
    };
    if !ignored_child_test_env_guard_enabled((TIMEOUT_CHILD_ENV, &readiness_path)) {
        return;
    }

    let mut command = std::process::Command::new("sleep");
    command
        .arg("60")
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    let mut descendant = command.spawn().expect("spawn timeout descendant");
    let pid = descendant.id();
    let ProcessStatRead::Found(stat) = crate::process::read_process_stat_checked_blocking(pid)
    else {
        panic!("timeout descendant process stat must be readable");
    };
    assert!(process_stat_is_live(&stat));
    assert_eq!(stat.pgid, i32::try_from(pid).unwrap());
    let child_session = nix::unistd::getsid(None).expect("read ignored child session");
    let descendant_session = nix::unistd::getsid(Some(nix::unistd::Pid::from_raw(
        libc::pid_t::try_from(pid).expect("timeout descendant PID must fit in pid_t"),
    )))
    .expect("read timeout descendant session");
    assert_eq!(descendant_session, child_session);
    std::fs::write(
        &readiness_path,
        format!("{pid} {} {}\n", stat.pgid, stat.starttime),
    )
    .expect("write timeout descendant readiness");

    std::thread::sleep(Duration::from_secs(60));
    descendant.kill().expect("kill timeout descendant");
    descendant.wait().expect("reap timeout descendant");
}

#[cfg(target_os = "linux")]
struct DescendantIdentity {
    pid: u32,
    pgid: i32,
    starttime: u64,
}

#[cfg(target_os = "linux")]
async fn assert_descendant_exited(identity: &DescendantIdentity) {
    // Clean up the controlled descendant even when a regression fails.
    // Bind it before checking its generation, then signal only via the pidfd.
    let pidfd = open_pidfd(libc::pid_t::try_from(identity.pid).unwrap()).unwrap();
    let remained_live = match read_process_stat_checked(identity.pid).await {
        ProcessStatRead::Found(stat) => {
            stat.starttime == identity.starttime && process_stat_is_live(&stat)
        }
        ProcessStatRead::Missing => false,
        ProcessStatRead::Unreadable(error) => panic!("read descendant state: {error}"),
        ProcessStatRead::Invalid => panic!("parse descendant state"),
    };
    if remained_live {
        let pidfd = pidfd.expect("live descendant must have a pidfd");
        signal_pidfd(&pidfd, libc::SIGKILL).expect("clean up leaked test descendant");
        // SAFETY: AsyncFd owns the pidfd and keeps its descriptor unchanged until drop.
        let exit = unsafe { tokio::io::unix::AsyncFd::register(pidfd) }.unwrap();
        let _ready = tokio::time::timeout(CHILD_KILL_WAIT_TIMEOUT, exit.readable())
            .await
            .expect("test descendant cleanup must finish")
            .expect("observe test descendant exit");
    }
    assert!(
        !remained_live,
        "descendant {} remained live after fixture completion",
        identity.pid
    );
    assert_eq!(identity.pgid, i32::try_from(identity.pid).unwrap());
}

#[cfg(target_os = "linux")]
fn read_descendant_identity(path: &Path) -> DescendantIdentity {
    let contents = std::fs::read_to_string(path).expect("read timeout descendant readiness");
    let mut fields = contents.split_whitespace();
    let pid = fields
        .next()
        .expect("timeout descendant readiness must contain PID")
        .parse()
        .expect("timeout descendant PID must be valid");
    let pgid = fields
        .next()
        .expect("timeout descendant readiness must contain PGID")
        .parse()
        .expect("timeout descendant PGID must be valid");
    let starttime = fields
        .next()
        .expect("timeout descendant readiness must contain start time")
        .parse()
        .expect("timeout descendant start time must be valid");
    assert_eq!(fields.next(), None);
    DescendantIdentity {
        pid,
        pgid,
        starttime,
    }
}
