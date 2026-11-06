#![cfg(all(target_os = "linux", feature = "tokio"))]

//! Opt-in native coverage; the caller supplies an empty, owned cgroup leaf.

#[cfg(test)]
mod tests {
    use std::fs::{self, File};
    use std::io;
    use std::os::fd::AsFd;
    use std::os::unix::fs::MetadataExt;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::time::Duration;

    use process_launch::{Command, Credentials, SpawnOptions, Stdio, asynchronous};
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    const TEST: &str = "tests::private_mounts_preserve_identity_and_launch_ownership";
    const PAYLOAD: &str = "OKOU_TEST_MOUNT_NAMESPACE_PAYLOAD";

    fn identity(path: &Path) -> (u64, u64, u64) {
        let metadata = fs::metadata(path).unwrap();
        (metadata.dev(), metadata.ino(), metadata.rdev())
    }

    fn payload() {
        let root = PathBuf::from(std::env::var_os("OKOU_TEST_MOUNT_NAMESPACE_DIR").unwrap());
        let source = PathBuf::from(std::env::var_os(PAYLOAD).unwrap());
        assert_eq!(
            identity(&root.join("root target")),
            identity(Path::new("/dev/null"))
        );
        assert_eq!(identity(&root.join("home target")), identity(&source));
        assert_eq!(
            fs::read(root.join("home target")).unwrap(),
            fs::read(&source).unwrap()
        );
        assert_eq!(
            identity(&root.join("vsock target")),
            identity(&source.with_extension("vsock"))
        );
        let namespace = fs::read_link("/proc/self/ns/mnt").unwrap();
        assert_ne!(
            namespace.as_os_str(),
            std::env::var_os("OKOU_TEST_PARENT_MOUNT_NAMESPACE").unwrap()
        );
        let mounts = fs::read_to_string("/proc/self/mountinfo").unwrap();
        for label in ["root target", "home target"] {
            let target = root
                .join(label)
                .display()
                .to_string()
                .replace('\\', "\\134")
                .replace(' ', "\\040");
            assert_eq!(
                mounts
                    .lines()
                    .filter(|line| line.split_whitespace().nth(4) == Some(target.as_str()))
                    .count(),
                1,
                "stale mount must be removed before the replacement bind"
            );
        }
        let root_mount = mounts
            .lines()
            .find(|line| line.split_whitespace().nth(4) == Some("/"))
            .unwrap();
        let optional = root_mount
            .split(" - ")
            .next()
            .unwrap()
            .split_whitespace()
            .skip(6);
        assert!(
            !optional
                .clone()
                .any(|field| field.starts_with("shared:") || field.starts_with("master:"))
        );
        assert!(
            fs::read_to_string("/proc/self/limits")
                .unwrap()
                .lines()
                .any(|line| {
                    line.starts_with("Max open files")
                        && line.split_whitespace().skip(3).take(2).eq(["2048", "2048"])
                })
        );
        if let Ok(expected) = std::env::var("OKOU_TEST_EXPECTED_CGROUP") {
            assert_eq!(
                fs::read_to_string("/proc/self/cgroup").unwrap().trim(),
                format!("0::{expected}")
            );
        }
        println!("NAMESPACE_READY {}", namespace.display());
        let mut line = String::new();
        io::stdin().read_line(&mut line).unwrap();
        assert_eq!(line, "finish\n");
    }

    fn command(root: &Path, source: &Path) -> Command {
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", TEST, "--ignored", "--nocapture"])
            .env(PAYLOAD, source)
            .env("OKOU_TEST_MOUNT_NAMESPACE_DIR", root)
            .env(
                "OKOU_TEST_PARENT_MOUNT_NAMESPACE",
                fs::read_link("/proc/self/ns/mnt").unwrap(),
            )
            .nofile_limit(2048)
            .stdin(Stdio::Piped)
            .stdout(Stdio::Piped);
        command
            .private_mount_namespace(
                &[&root.join("root target"), &root.join("home target")],
                &[
                    (Path::new("/dev/null"), &root.join("root target")),
                    (source, &root.join("home target")),
                    (&source.with_extension("vsock"), &root.join("vsock target")),
                ],
            )
            .unwrap();
        command
    }

    async fn launch(
        command: Command,
        cgroup: Option<&File>,
        unprivileged: bool,
    ) -> io::Result<asynchronous::Child> {
        match cgroup {
            Some(cgroup) => {
                asynchronous::spawn(
                    command,
                    cgroup.as_fd(),
                    SpawnOptions {
                        credentials: unprivileged.then_some(Credentials {
                            uid: 65534,
                            gid: 65534,
                            groups: &[],
                        }),
                        ..SpawnOptions::default()
                    },
                )
                .await
            }
            None => {
                let mut command = tokio::process::Command::from(command.into_standard_command());
                command.process_group(0).kill_on_drop(true);
                if unprivileged {
                    command.uid(65534).gid(65534);
                }
                command.spawn().map(asynchronous::Child::from)
            }
        }
    }

    fn assert_reaped(pid: u32) {
        // SAFETY: the owner has already waited; this must not find a waitable child.
        let result = unsafe { libc::waitpid(pid as i32, std::ptr::null_mut(), libc::WNOHANG) };
        assert_eq!(result, -1);
        assert_eq!(
            io::Error::last_os_error().raw_os_error(),
            Some(libc::ECHILD)
        );
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 4)]
    #[ignore = "requires root, mount namespaces, and an explicitly supplied empty cgroup v2 leaf"]
    async fn private_mounts_preserve_identity_and_launch_ownership() {
        if std::env::var_os(PAYLOAD).is_some() {
            payload();
            return;
        }
        // SAFETY: geteuid only reads this process's identity.
        assert_eq!(
            unsafe { libc::geteuid() },
            0,
            "native fixture requires root"
        );
        // Isolate the fixture before the nested harness creates its runtime threads.
        // Only this private parent namespace receives inherited stale mounts.
        const ISOLATED: &str = "OKOU_TEST_MOUNT_NAMESPACE_ISOLATED";
        if std::env::var_os(ISOLATED).is_none() {
            let status = std::process::Command::new("unshare")
                .args(["--mount", "--propagation", "private"])
                .arg(std::env::current_exe().unwrap())
                .args(["--exact", TEST, "--ignored", "--nocapture"])
                .env(ISOLATED, "1")
                .status()
                .unwrap();
            assert!(status.success());
            return;
        }
        let base = PathBuf::from(
            std::env::var_os("OKOU_TEST_MOUNT_NAMESPACE_DIR")
                .expect("supply an owned fixture directory"),
        );
        let root = tempfile::tempdir_in(&base).unwrap().keep();
        let cgroup_path = PathBuf::from(
            std::env::var_os("OKOU_TEST_MOUNT_NAMESPACE_CGROUP")
                .expect("supply an empty owned cgroup leaf"),
        );
        let relative = cgroup_path.strip_prefix("/sys/fs/cgroup").unwrap();
        let expected_cgroup = format!("/{}", relative.display());
        assert_eq!(
            fs::read_to_string(cgroup_path.join("cgroup.procs")).unwrap(),
            ""
        );
        let cgroup = Arc::new(File::open(&cgroup_path).unwrap());
        fs::write(root.join("root target"), "parent root").unwrap();
        fs::write(root.join("home target"), "parent home").unwrap();
        fs::create_dir(root.join("vsock target")).unwrap();
        let original_identity = [
            identity(&root.join("root target")),
            identity(&root.join("home target")),
            identity(&root.join("vsock target")),
        ];
        let stale_home = root.join("stale home");
        fs::write(&stale_home, "parent home").unwrap();
        for (source, target) in [
            (Path::new("/dev/zero"), root.join("root target")),
            (stale_home.as_path(), root.join("home target")),
        ] {
            assert!(
                std::process::Command::new("mount")
                    .arg("--bind")
                    .arg(source)
                    .arg(target)
                    .status()
                    .unwrap()
                    .success()
            );
        }
        let parent_identity = [
            identity(&root.join("root target")),
            identity(&root.join("home target")),
            identity(&root.join("vsock target")),
        ];
        let parent_namespace = fs::read_link("/proc/self/ns/mnt").unwrap();

        for managed in [false, true] {
            let mut tasks = tokio::task::JoinSet::new();
            for slot in 0..6 {
                // Metacharacters remain literal path bytes throughout both owners.
                let source = root.join(format!("home {managed}-{slot};$(literal)"));
                fs::write(&source, format!("private {managed}-{slot}")).unwrap();
                fs::create_dir(source.with_extension("vsock")).unwrap();
                let mut command = command(&root, &source);
                if managed {
                    command.env("OKOU_TEST_EXPECTED_CGROUP", &expected_cgroup);
                }
                let cgroup = cgroup.clone();
                tasks.spawn(async move {
                    let mut child = launch(command, managed.then_some(cgroup.as_ref()), false)
                        .await
                        .unwrap();
                    let pid = child.id().unwrap();
                    let mut stdout = BufReader::new(child.stdout.take().unwrap());
                    let namespace = tokio::time::timeout(Duration::from_secs(5), async {
                        loop {
                            let mut line = String::new();
                            assert!(
                                stdout.read_line(&mut line).await.unwrap() > 0,
                                "payload exited before ready"
                            );
                            if let Some((_, namespace)) = line.split_once("NAMESPACE_READY ") {
                                break namespace.trim().to_owned();
                            }
                        }
                    })
                    .await
                    .unwrap();
                    (child, stdout, pid, namespace)
                });
            }
            let mut children = Vec::new();
            while let Some(child) = tasks.join_next().await {
                children.push(child.unwrap());
            }
            let namespaces: std::collections::BTreeSet<_> =
                children.iter().map(|(_, _, _, ns)| ns).collect();
            assert_eq!(
                namespaces.len(),
                6,
                "all six ready children must have isolated namespaces"
            );
            for (index, (mut child, _stdout, pid, _)) in children.into_iter().enumerate() {
                if index % 2 == 0 {
                    child
                        .stdin
                        .take()
                        .unwrap()
                        .write_all(b"finish\n")
                        .await
                        .unwrap();
                    assert!(
                        tokio::time::timeout(Duration::from_secs(5), child.wait())
                            .await
                            .unwrap()
                            .unwrap()
                            .success()
                    );
                } else {
                    child.kill().await.unwrap();
                }
                assert_reaped(pid);
            }
            let group = managed.then_some(cgroup.as_ref());
            let source = root.join(format!("home {managed}-0;$(literal)"));
            // A failed later bind cannot execute the payload or leak the first bind.
            let marker = root.join("must not execute");
            let mut failed = Command::new("/usr/bin/touch");
            failed
                .arg(&marker)
                .private_mount_namespace(
                    &[],
                    &[
                        (Path::new("/dev/null"), &root.join("root target")),
                        (&root.join("missing source"), &root.join("home target")),
                    ],
                )
                .unwrap();
            let error = launch(failed, group, false)
                .await
                .err()
                .expect("bind failure must fail spawn");
            assert_eq!(error.raw_os_error(), Some(libc::ENOENT));
            assert!(!marker.exists());
            let mut failed = Command::new(root.join("missing executable"));
            failed
                .private_mount_namespace(&[], &[(&source, &root.join("home target"))])
                .unwrap();
            assert_eq!(
                launch(failed, group, false)
                    .await
                    .err()
                    .unwrap()
                    .raw_os_error(),
                Some(libc::ENOENT)
            );
            assert_eq!(
                launch(command(&root, &source), group, true)
                    .await
                    .err()
                    .unwrap()
                    .raw_os_error(),
                Some(libc::EPERM)
            );
            assert_eq!(
                fs::read_link("/proc/self/ns/mnt").unwrap(),
                parent_namespace
            );
            assert_eq!(
                [
                    identity(&root.join("root target")),
                    identity(&root.join("home target")),
                    identity(&root.join("vsock target"))
                ],
                parent_identity
            );
            assert_eq!(
                fs::read_to_string(root.join("home target")).unwrap(),
                "parent home"
            );
            assert_eq!(
                fs::read_to_string(cgroup_path.join("cgroup.procs")).unwrap(),
                ""
            );
        }
        assert!(
            !fs::read_dir("/proc/self/fd")
                .unwrap()
                .filter_map(Result::ok)
                .any(|fd| fs::read_link(fd.path()).is_ok_and(|path| path
                    .as_os_str()
                    .as_encoded_bytes()
                    .windows(5)
                    .any(|bytes| bytes == b"pidfd")))
        );
        for target in [root.join("root target"), root.join("home target")] {
            assert!(
                std::process::Command::new("umount")
                    .arg(target)
                    .status()
                    .unwrap()
                    .success()
            );
        }
        assert_eq!(
            [
                identity(&root.join("root target")),
                identity(&root.join("home target")),
                identity(&root.join("vsock target"))
            ],
            original_identity
        );
        fs::remove_dir_all(root).unwrap();
    }
}
