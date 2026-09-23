//! Privileged process regressions, executed explicitly by the metal CI job.

use super::*;
use std::process::{Child, Stdio};
use std::time::{Duration, Instant};

const OWNER_TEST: &str = "cmd::build::scripts::process_tests::owner_child";
const FIXTURE_ENV: &str = "RUNNER_ROOTFS_PROCESS_FIXTURE";
const MODE_ENV: &str = "RUNNER_ROOTFS_PROCESS_MODE";

struct Owner(Child);

impl Drop for Owner {
    fn drop(&mut self) {
        if self.0.try_wait().unwrap().is_none() {
            self.0.kill().unwrap();
            self.0.wait().unwrap();
        }
    }
}

struct StoppedInit(OwnedFd);

impl Drop for StoppedInit {
    fn drop(&mut self) {
        let _ = rustix::process::pidfd_send_signal(&self.0, rustix::process::Signal::CONT);
    }
}

fn wait_until(label: &str, mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(10);
    while !condition() {
        assert!(Instant::now() < deadline, "timed out: {label}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

fn wait_file(path: &Path) {
    wait_until(&format!("file {}", path.display()), || path.exists());
}

fn namespace_members(namespace: &str) -> Vec<(i32, char)> {
    let mut members = Vec::new();
    for entry in std::fs::read_dir("/proc").unwrap() {
        let entry = entry.unwrap();
        let Ok(pid) = entry.file_name().to_string_lossy().parse::<i32>() else {
            continue;
        };
        let Ok(observed) = std::fs::read_link(entry.path().join("ns/pid")) else {
            continue;
        };
        if observed != Path::new(namespace) {
            continue;
        }
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else {
            continue;
        };
        let state = stat.rsplit_once(") ").unwrap().1.chars().next().unwrap();
        if state != 'Z' {
            members.push((pid, state));
        }
    }
    members
}

fn stop_namespace_init(namespace: &str) -> (StoppedInit, File) {
    let (pid, _) = namespace_members(namespace)
        .into_iter()
        .find(|(pid, _)| {
            std::fs::read_to_string(format!("/proc/{pid}/status"))
                .unwrap()
                .lines()
                .any(|line| {
                    line.starts_with("NSpid:") && line.split_whitespace().last() == Some("1")
                })
        })
        .expect("owned namespace must have an init process");
    let namespace_handle = File::open(format!("/proc/{pid}/ns/pid")).unwrap();
    let pidfd = rustix::process::pidfd_open(
        rustix::process::Pid::from_raw(pid).unwrap(),
        rustix::process::PidfdFlags::empty(),
    )
    .unwrap();
    assert_eq!(
        std::fs::read_link(format!("/proc/{pid}/ns/pid")).unwrap(),
        Path::new(namespace)
    );
    rustix::process::pidfd_send_signal(&pidfd, rustix::process::Signal::STOP).unwrap();
    let stopped = StoppedInit(pidfd);
    wait_until("namespace init stopped", || {
        namespace_members(namespace).contains(&(pid, 'T'))
    });
    (stopped, namespace_handle)
}

fn try_lock(path: &Path) -> Option<Flock<File>> {
    let file = File::options().read(true).write(true).open(path).unwrap();
    match Flock::lock(file, nix::fcntl::FlockArg::LockExclusiveNonblock) {
        Ok(lock) => Some(lock),
        Err((_, error)) => {
            assert_eq!(error, nix::errno::Errno::EWOULDBLOCK);
            None
        }
    }
}

fn acquire_after_cleanup(path: &Path) -> Flock<File> {
    let mut acquired = None;
    wait_until("build lock available after cleanup", || {
        acquired = try_lock(path);
        acquired.is_some()
    });
    acquired.unwrap()
}

#[test]
#[ignore = "requires root and mount/PID namespaces; run explicitly on metal"]
fn rootfs_process_ownership() {
    assert!(nix::unistd::geteuid().is_root());
    for mode in [
        "death",
        "cancel",
        "success",
        "failure",
        "cancel-before-start",
    ] {
        let home = tempfile::tempdir().unwrap();
        let mut owner = Owner(
            std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--ignored", "--exact", OWNER_TEST, "--nocapture"])
                .env(FIXTURE_ENV, home.path())
                .env("TMPDIR", home.path())
                .env(MODE_ENV, mode)
                .stdin(Stdio::null())
                .spawn()
                .unwrap(),
        );

        if mode == "cancel-before-start" {
            wait_file(&home.path().join("cancelled"));
            wait_until("owner exits", || owner.0.try_wait().unwrap().is_some());
            assert!(owner.0.wait().unwrap().success());
            assert!(!home.path().join("ready").exists());
            assert!(try_lock(&home.path().join("rootfs.lock")).is_some());
            assert!(try_lock(&home.path().join("template.lock")).is_some());
            continue;
        }

        wait_file(&home.path().join("ready"));
        let namespace = std::fs::read_to_string(home.path().join("namespace")).unwrap();
        let namespace = namespace.trim();
        assert!(!namespace_members(namespace).is_empty());
        assert!(try_lock(&home.path().join("rootfs.lock")).is_none());
        assert!(try_lock(&home.path().join("template.lock")).is_none());

        let mut namespace_pin = None;
        if mode == "death" || mode == "cancel" {
            // Holding init stopped deterministically separates owner loss from
            // completed cleanup. The canonical flocks must stay unavailable.
            let (stopped, pin) = stop_namespace_init(namespace);
            namespace_pin = Some(pin);
            if mode == "death" {
                owner.0.kill().unwrap();
                assert!(!owner.0.wait().unwrap().success());
            } else {
                std::fs::write(home.path().join("cancel"), b"cancel").unwrap();
                wait_file(&home.path().join("cancelled"));
            }
            assert!(try_lock(&home.path().join("rootfs.lock")).is_none());
            assert!(try_lock(&home.path().join("template.lock")).is_none());
            drop(stopped);
        } else {
            std::fs::write(home.path().join("release"), b"release").unwrap();
            wait_until("completed owner", || owner.0.try_wait().unwrap().is_some());
            assert!(owner.0.wait().unwrap().success());
        }

        let _rootfs = acquire_after_cleanup(&home.path().join("rootfs.lock"));
        let _template = acquire_after_cleanup(&home.path().join("template.lock"));
        assert!(
            namespace_members(namespace).is_empty(),
            "{mode}: lock released before namespace stopped"
        );
        if mode == "death" || mode == "cancel" {
            std::fs::write(home.path().join("release"), b"release").unwrap();
            assert!(
                !home.path().join("survived").exists(),
                "{mode}: orphaned foreground work wrote"
            );
        } else {
            assert!(home.path().join("survived").exists());
        }
        drop(namespace_pin);
        if mode == "cancel" {
            std::fs::write(home.path().join("finish"), b"finish").unwrap();
            wait_until("cancelled owner exits", || {
                owner.0.try_wait().unwrap().is_some()
            });
            assert!(owner.0.wait().unwrap().success());
        }
        println!("rootfs ownership mode={mode}: passed");
    }

    // Killing one owner must not affect an unrelated namespace's work or locks.
    let first = tempfile::tempdir().unwrap();
    let second = tempfile::tempdir().unwrap();
    let launch = |home: &Path| {
        Owner(
            std::process::Command::new(std::env::current_exe().unwrap())
                .args(["--ignored", "--exact", OWNER_TEST, "--nocapture"])
                .env(FIXTURE_ENV, home)
                .env("TMPDIR", home)
                .env(MODE_ENV, "success")
                .stdin(Stdio::null())
                .spawn()
                .unwrap(),
        )
    };
    let mut first_owner = launch(first.path());
    let mut second_owner = launch(second.path());
    wait_file(&first.path().join("ready"));
    wait_file(&second.path().join("ready"));
    let first_namespace = std::fs::read_to_string(first.path().join("namespace")).unwrap();
    let second_namespace = std::fs::read_to_string(second.path().join("namespace")).unwrap();
    assert_ne!(first_namespace, second_namespace);
    first_owner.0.kill().unwrap();
    first_owner.0.wait().unwrap();
    let _first_lock = acquire_after_cleanup(&first.path().join("rootfs.lock"));
    assert!(namespace_members(first_namespace.trim()).is_empty());
    assert!(!namespace_members(second_namespace.trim()).is_empty());
    assert!(try_lock(&second.path().join("rootfs.lock")).is_none());
    assert!(try_lock(&second.path().join("template.lock")).is_none());
    std::fs::write(second.path().join("release"), b"release").unwrap();
    wait_until("unrelated owner completes", || {
        second_owner.0.try_wait().unwrap().is_some()
    });
    assert!(second_owner.0.wait().unwrap().success());
    assert!(second.path().join("survived").exists());
    assert!(!first.path().join("survived").exists());
    println!("rootfs ownership concurrent namespace isolation: passed");
}

#[tokio::test]
#[ignore = "subprocess fixture, invoked only by rootfs_process_ownership"]
async fn owner_child() {
    let home = PathBuf::from(std::env::var_os(FIXTURE_ENV).expect("isolated fixture directory"));
    let mode = std::env::var(MODE_ENV).unwrap();
    let primary = Arc::new(
        runner_host::lock::acquire(home.join("rootfs.lock"))
            .await
            .unwrap(),
    );
    let template = Arc::new(
        runner_host::lock::acquire(home.join("template.lock"))
            .await
            .unwrap(),
    );
    let mut scripts = RootfsScripts::new(primary, Some(template));
    let directory = scripts.path().await.unwrap();
    let prefix_end = TEMPLATE_BUILD_SCRIPT.find("\nshift\n").unwrap() + "\nshift\n".len();
    let worker = format!(
        "{}{}",
        &TEMPLATE_BUILD_SCRIPT[..prefix_end],
        r#"
probe_dir="$1"
readlink /proc/self/ns/pid > "$probe_dir/namespace"
printf ready > "$probe_dir/ready"
for ((attempt = 0; attempt < 1000; attempt++)); do
  if [[ -f "$probe_dir/release" ]]; then
    printf survived > "$probe_dir/survived"
    if [[ "$2" == failure ]]; then exit 17; fi
    exit 0
  fi
  sleep 0.01
done
exit 18
"#
    );
    std::fs::write(directory.join("ownership-worker.sh"), worker).unwrap();
    let mut command = rootfs_script_command(&directory, "ownership-worker.sh").unwrap();
    command.command.arg(&home).arg(&mode);
    drop(directory);
    drop(scripts);
    let task = tokio::spawn(async move { run_rootfs_script(command, "ownership-worker.sh").await });
    if mode == "cancel" || mode == "cancel-before-start" {
        if mode == "cancel" {
            tokio::time::timeout(Duration::from_secs(10), async {
                while !home.join("cancel").exists() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
        }
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        std::fs::write(home.join("cancelled"), b"cancelled").unwrap();
        if mode == "cancel" {
            tokio::time::timeout(Duration::from_secs(10), async {
                while !home.join("finish").exists() {
                    tokio::time::sleep(Duration::from_millis(10)).await;
                }
            })
            .await
            .unwrap();
        }
    } else {
        let status = task.await.unwrap().unwrap();
        assert_eq!(status.code(), Some(if mode == "failure" { 17 } else { 0 }));
    }
}
