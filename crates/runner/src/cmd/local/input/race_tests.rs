use std::ffi::OsStr;
use std::fs::File;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::panic::{AssertUnwindSafe, resume_unwind};
use std::path::Path;
use std::process::ExitCode;
use std::time::Duration;

use clap::Parser;
use futures_util::FutureExt;
use nix::fcntl::{Flock, FlockArg};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::UnixListener;

use super::run_input_with_home;
use crate::ids::RunId;
use crate::local_queue::{self, ActiveInputEntry, JobRequest, LocalQueue};
use crate::paths::HomePaths;
use crate::test_fixtures::ignored_child::{
    ignored_child_test_env_guard_enabled, run_ignored_child_test,
};

const CHILD_TEST: &str = "cmd::local::input::race_tests::external_publisher_child";
const CLEANUP_CHILD_TEST: &str = "cmd::local::input::race_tests::external_cleanup_child";
const CHILD_SCENARIO: &str = "OKOU_LOCAL_INPUT_RACE_SCENARIO";
const CHILD_HOME: &str = "OKOU_LOCAL_INPUT_RACE_HOME";
const CHILD_RUN: &str = "OKOU_LOCAL_INPUT_RACE_RUN";
const CHILD_SOCKET: &str = "OKOU_LOCAL_INPUT_RACE_SOCKET";
const CLEANUP_FIRST: &str = "cleanup-first";
const PUBLISHER_FIRST: &str = "publisher-first";
const CLEANUP_CONTENDED: &str = "cleanup-contended";
const RENDEZVOUS_TIMEOUT: Duration = Duration::from_secs(5);
const CHILD_TIMEOUT: Duration = Duration::from_secs(15);
const GROUP: &str = "test/group";
const PROFILE: &str = "test/custom";

struct Fixture {
    dir: tempfile::TempDir,
    queue: LocalQueue,
    run_id: RunId,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempfile::tempdir().unwrap();
        let home = HomePaths::with_root(dir.path().to_path_buf());
        let group_dir = home.groups_dir().join(GROUP);
        local_queue::ensure_profile_jobs_dir(&group_dir, PROFILE).unwrap();
        let run_id = RunId::new_v4();
        let request = JobRequest {
            job_id: run_id,
            prompt: "initial prompt".into(),
            cli_agent_type: "claude-code".into(),
            vars: None,
            environment: None,
            secret_environment: None,
            user_timezone: None,
            profile: Some(PROFILE.into()),
            reuse_key: None,
            session_id: None,
            feature_flags: None,
            active_input: Some(true),
        };
        let path = local_queue::job_path(&group_dir, PROFILE, run_id).unwrap();
        local_queue::write_private_file(
            &path,
            &serde_json::to_vec(&request).unwrap(),
            "test job request",
        )
        .unwrap();
        let queue = LocalQueue::new(group_dir);
        assert!(matches!(
            queue.claim_job_sync(run_id, PROFILE, &path),
            local_queue::LocalClaimResult::Claimed { .. }
        ));
        Self { dir, queue, run_id }
    }

    fn complete_and_cleanup(&self) {
        self.queue.complete_job_sync(self.run_id, 0, None);
        let group_dir = self.queue.group_dir();
        assert!(local_queue::result_path(group_dir, self.run_id).exists());
        assert!(!local_queue::run_inputs_dir(group_dir, self.run_id).exists());
        // Exercise submit's real terminal cleanup, including deletion of the
        // result that a delayed external publisher might otherwise rely on.
        crate::cmd::local::submit::cleanup_completed_for_test(group_dir, PROFILE, self.run_id);
        self.assert_cleaned();
    }

    fn assert_cleaned(&self) {
        let group_dir = self.queue.group_dir();
        assert!(
            !local_queue::job_path(group_dir, PROFILE, self.run_id)
                .unwrap()
                .exists()
        );
        assert!(!local_queue::claim_path(group_dir, self.run_id).exists());
        assert!(!local_queue::result_path(group_dir, self.run_id).exists());
        assert!(!local_queue::run_inputs_dir(group_dir, self.run_id).exists());
    }

    async fn run_child(&self, test: &str, scenario: &str, socket_path: &Path) {
        let home = self.dir.path().to_str().unwrap();
        let run_id = self.run_id.to_string();
        let child_env = [
            (CHILD_HOME, Some(home)),
            (CHILD_RUN, Some(run_id.as_str())),
            (CHILD_SOCKET, socket_path.to_str()),
        ];
        run_ignored_child_test(test, (CHILD_SCENARIO, scenario), &child_env, CHILD_TIMEOUT).await;
    }

    async fn run_publisher_after_cleanup(&self) {
        let socket_path = self.dir.path().join("publication.sock");
        let listener = UnixListener::bind(&socket_path).unwrap();
        let child = self.run_child(CHILD_TEST, CLEANUP_FIRST, &socket_path);
        let rendezvous = tokio::time::timeout(RENDEZVOUS_TIMEOUT, async {
            let mut socket = accept_checkpoint(&listener).await;
            self.complete_and_cleanup();
            socket.write_all(&[2]).await.unwrap();
        });
        // The existing harness bounds and reaps the child even if it cannot
        // reach the socket; the socket also has its own bounded rendezvous.
        let (child, rendezvous) = tokio::join!(
            AssertUnwindSafe(child).catch_unwind(),
            AssertUnwindSafe(rendezvous).catch_unwind(),
        );
        child.unwrap_or_else(|panic| resume_unwind(panic));
        rendezvous
            .unwrap_or_else(|panic| resume_unwind(panic))
            .expect("external active-input publisher checkpoint timed out");
    }
}

async fn accept_checkpoint(listener: &UnixListener) -> tokio::net::UnixStream {
    let (mut socket, _) = listener.accept().await.unwrap();
    let mut ready = [0];
    socket.read_exact(&mut ready).await.unwrap();
    assert_eq!(ready, [1]);
    socket
}

pub(super) fn pre_publication_checkpoint() {
    checkpoint(CLEANUP_FIRST);
}

pub(super) fn publication_locked_checkpoint() {
    checkpoint(PUBLISHER_FIRST);
}

pub(super) fn lock_attempt_checkpoint(file: &File) {
    if std::env::var_os(CHILD_SCENARIO).as_deref() != Some(OsStr::new(CLEANUP_CONTENDED)) {
        return;
    }
    // This executes in the real cleanup's lock helper. Its descriptor must
    // observe the publisher's cross-process lock before either child is
    // released. Submit's later uncontended cleanup skips this.
    match Flock::lock(file.try_clone().unwrap(), FlockArg::LockExclusiveNonblock) {
        Ok(guard) => drop(guard),
        Err((_, error)) => {
            assert_eq!(error, nix::errno::Errno::EWOULDBLOCK);
            checkpoint(CLEANUP_CONTENDED);
        }
    }
}

fn checkpoint(scenario: &str) {
    if std::env::var_os(CHILD_SCENARIO).as_deref() != Some(OsStr::new(scenario)) {
        return;
    }
    let socket_path = std::env::var_os(CHILD_SOCKET).expect("child rendezvous socket");
    let mut socket = UnixStream::connect(socket_path).expect("connect child rendezvous socket");
    socket.set_read_timeout(Some(RENDEZVOUS_TIMEOUT)).unwrap();
    socket.set_write_timeout(Some(RENDEZVOUS_TIMEOUT)).unwrap();
    socket.write_all(&[1]).unwrap();
    let mut resume = [0];
    socket.read_exact(&mut resume).unwrap();
    assert_eq!(resume, [2]);
}

#[tokio::test]
async fn external_publisher_cannot_recreate_inputs_after_terminal_cleanup() {
    let fixture = Fixture::new();
    fixture
        .queue
        .write_active_input_sync(&ActiveInputEntry {
            run_id: fixture.run_id,
            sequence: 1,
            text: "previous input".into(),
        })
        .unwrap();

    fixture.run_publisher_after_cleanup().await;

    // Both terminal owners have gone away before the publisher resumes.
    // Rejection must leave neither a final payload nor a temporary directory.
    fixture.assert_cleaned();
}

#[tokio::test]
async fn terminal_cleanup_removes_input_published_by_an_independent_process() {
    let fixture = Fixture::new();
    let publisher_socket = fixture.dir.path().join("publication.sock");
    let cleanup_socket = fixture.dir.path().join("cleanup.sock");
    let publisher_listener = UnixListener::bind(&publisher_socket).unwrap();
    let cleanup_listener = UnixListener::bind(&cleanup_socket).unwrap();
    let (start_cleanup, cleanup_ready) = tokio::sync::oneshot::channel();
    let publisher = fixture.run_child(CHILD_TEST, PUBLISHER_FIRST, &publisher_socket);
    let cleanup = async {
        if cleanup_ready.await.is_ok() {
            fixture
                .run_child(CLEANUP_CHILD_TEST, CLEANUP_CONTENDED, &cleanup_socket)
                .await;
        }
    };
    let rendezvous = tokio::time::timeout(RENDEZVOUS_TIMEOUT, async {
        let mut publisher = accept_checkpoint(&publisher_listener).await;
        assert!(!local_queue::run_inputs_dir(fixture.queue.group_dir(), fixture.run_id).exists());
        start_cleanup.send(()).unwrap();

        // Cleanup has already made the run terminal and is now contending on
        // the admitted publisher's actual flock. Removing cleanup's lock would
        // prevent this rendezvous, so a sequential cleanup cannot pass here.
        let mut cleanup = accept_checkpoint(&cleanup_listener).await;
        assert!(local_queue::result_path(fixture.queue.group_dir(), fixture.run_id).exists());
        assert!(
            !local_queue::job_path(fixture.queue.group_dir(), PROFILE, fixture.run_id)
                .unwrap()
                .exists()
        );
        cleanup.write_all(&[2]).await.unwrap();
        publisher.write_all(&[2]).await.unwrap();
    });
    // Keep both child owners alive until they have reaped their processes,
    // including when a sibling or a checkpoint assertion fails.
    let (publisher, cleanup, rendezvous) = tokio::join!(
        AssertUnwindSafe(publisher).catch_unwind(),
        AssertUnwindSafe(cleanup).catch_unwind(),
        AssertUnwindSafe(rendezvous).catch_unwind(),
    );
    publisher.unwrap_or_else(|panic| resume_unwind(panic));
    cleanup.unwrap_or_else(|panic| resume_unwind(panic));
    rendezvous
        .unwrap_or_else(|panic| resume_unwind(panic))
        .expect("publisher and terminal cleanup contention checkpoint timed out");
    fixture.assert_cleaned();
}

#[test]
#[ignore = "spawned by the concurrent publication and cleanup test"]
fn external_cleanup_child() {
    if !ignored_child_test_env_guard_enabled((CHILD_SCENARIO, CLEANUP_CONTENDED)) {
        return;
    }
    let home = std::env::var_os(CHILD_HOME).expect("child queue home");
    let run_id = std::env::var(CHILD_RUN)
        .expect("child run ID")
        .parse::<RunId>()
        .unwrap();
    let group_dir = HomePaths::with_root(home.into()).groups_dir().join(GROUP);
    let queue = LocalQueue::new(group_dir.clone());
    queue.complete_job_sync(run_id, 0, None);
    assert!(local_queue::result_path(&group_dir, run_id).exists());
    assert!(!local_queue::run_inputs_dir(&group_dir, run_id).exists());
    crate::cmd::local::submit::cleanup_completed_for_test(&group_dir, PROFILE, run_id);
}

#[test]
#[ignore = "spawned by the external publication and cleanup race tests"]
fn external_publisher_child() {
    let Ok(scenario) = std::env::var(CHILD_SCENARIO) else {
        return;
    };
    if !ignored_child_test_env_guard_enabled((CHILD_SCENARIO, &scenario)) {
        return;
    }
    assert!(matches!(scenario.as_str(), CLEANUP_FIRST | PUBLISHER_FIRST));
    let home = std::env::var_os(CHILD_HOME).expect("child queue home");
    let run_id = std::env::var(CHILD_RUN).expect("child run ID");
    let cli = crate::Cli::try_parse_from([
        "runner",
        "local",
        "input",
        "--group",
        GROUP,
        "--run",
        &run_id,
        "--sequence",
        "5",
        "--text",
        "external input",
    ])
    .unwrap();
    let crate::Command::Local(local) = cli.command else {
        panic!("expected local command");
    };
    let crate::cmd::local::LocalCommand::Input(args) = local.command else {
        panic!("expected input command");
    };
    let result = run_input_with_home(args, HomePaths::with_root(home.into()));
    if scenario == CLEANUP_FIRST {
        let error = result.expect_err("terminal cleanup must reject the delayed publisher");
        assert!(
            error.to_string().contains("write local active input"),
            "publisher must reach the write boundary after its preliminary checks: {error}"
        );
        assert!(
            error.to_string().contains("no local job request found"),
            "publication must reject even after submit has removed the result: {error}"
        );
    } else {
        assert_eq!(result.unwrap(), ExitCode::SUCCESS);
    }
}
