use super::*;
use std::io::{Read, Write};
use std::process::Stdio;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader, Lines};
use tokio::process::{Child, ChildStdout, Command};

const CHILD_ENV: &str = "OKOU_RUNNER_PUBLICATION_LEGACY_CAPACITY_CHILD";
const CHILD_TEST: &str =
    "home_image_cache::tests::parallel_publication::compatibility::legacy_exclusive_child";

#[test]
#[ignore = "guarded child process invoked by the isolated compatibility parents"]
fn legacy_exclusive_child() {
    let path =
        std::env::var_os(CHILD_ENV).expect("compatibility child requires an explicit fixture path");
    let file = runner_host::lock::open_lock_file(std::path::Path::new(&path)).unwrap();
    println!("LEGACY_WAITING");
    std::io::stdout().flush().unwrap();
    let _exclusive =
        match nix::fcntl::Flock::lock(file, nix::fcntl::FlockArg::LockExclusiveNonblock) {
            Ok(lock) => lock,
            Err((file, nix::errno::Errno::EWOULDBLOCK)) => {
                // The kernel, rather than parent/child scheduling, proves exclusion.
                println!("LEGACY_BLOCKED");
                std::io::stdout().flush().unwrap();
                nix::fcntl::Flock::lock(file, nix::fcntl::FlockArg::LockExclusive).unwrap()
            }
            Err((_, error)) => panic!("legacy capacity acquisition failed: {error}"),
        };
    println!("LEGACY_HELD");
    std::io::stdout().flush().unwrap();
    let mut release = [0];
    std::io::stdin().read_exact(&mut release).unwrap();
}

struct LegacyWindow {
    child: Child,
    output: Lines<BufReader<ChildStdout>>,
}

impl LegacyWindow {
    fn start(f: &Fixture) -> Self {
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                CHILD_TEST,
                "--ignored",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(CHILD_ENV, f.cache.capacity_lock_path())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .unwrap();
        let output = BufReader::new(child.stdout.take().unwrap()).lines();
        Self { child, output }
    }

    async fn marker(&mut self, expected: &str) {
        tokio::time::timeout(Duration::from_secs(5), async {
            for _ in 0..16 {
                let line = self
                    .output
                    .next_line()
                    .await
                    .unwrap()
                    .expect("legacy child ended before its lock boundary");
                if line.ends_with(expected) {
                    return;
                }
            }
            panic!("legacy child did not report its lock boundary");
        })
        .await
        .unwrap();
    }

    async fn release(mut self) {
        self.child
            .stdin
            .take()
            .unwrap()
            .write_all(b"x")
            .await
            .unwrap();
        assert!(
            tokio::time::timeout(Duration::from_secs(5), self.child.wait())
                .await
                .unwrap()
                .unwrap()
                .success()
        );
    }
}

#[tokio::test]
async fn legacy_exclusive_budget_window_excludes_new_cache_tree_growth() {
    let f = Fixture::new().await;
    let owned = context(&f, "legacy-first").await;
    let active = f.paths.active_home_image(&owned.sandbox_id());
    let expected = tokio::fs::read(&active).await.unwrap();
    let mut legacy = LegacyWindow::start(&f);
    legacy.marker("LEGACY_HELD").await;
    let inode = std::fs::metadata(f.cache.capacity_lock_path())
        .unwrap()
        .ino();
    assert!(!f.cache.home_image_cache_dir().exists());
    assert_eq!(
        owned.promote().await.unwrap(),
        HomeImagePromotionOutcome::SkippedUnpublished
    );
    assert!(!f.cache.home_image_cache_dir().exists());
    assert_eq!(tokio::fs::read(&active).await.unwrap(), expected);
    assert_eq!(
        std::fs::metadata(f.cache.capacity_lock_path())
            .unwrap()
            .ino(),
        inode
    );
    legacy.release().await;
    assert_eq!(
        owned.promote().await.unwrap(),
        HomeImagePromotionOutcome::Promoted
    );
    drop(owned);
    published_bytes(&f, "legacy-first", &expected).await;
}

#[tokio::test]
async fn new_shared_physical_tail_excludes_a_legacy_exclusive_collector() {
    let mut f = Fixture::new().await;
    let gate = HomeImageHandoffTestGate::default();
    let _release = gate.release_on_drop();
    f.cache.publication_sync_test_gate = Some(gate.clone());
    let owned = context(&f, "new-first").await;
    let expected = tokio::fs::read(f.paths.active_home_image(&owned.sandbox_id()))
        .await
        .unwrap();
    let task = tokio::spawn(async move { owned.promote().await });
    gate.wait_entered(Duration::from_secs(5)).await;
    let mut legacy = LegacyWindow::start(&f);
    legacy.marker("LEGACY_BLOCKED").await;
    gate.release();
    assert_eq!(
        task.await.unwrap().unwrap(),
        HomeImagePromotionOutcome::Promoted
    );
    legacy.marker("LEGACY_HELD").await;
    legacy.release().await;
    published_bytes(&f, "new-first", &expected).await;
}
