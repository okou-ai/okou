use tokio::io::AsyncReadExt;

use super::*;

#[tokio::test]
async fn spawned_child_inherits_jailer_nofile_limit() {
    let mut command = Command::new("/bin/sh");
    command.args(["-c", "ulimit -Sn; ulimit -Hn"]);
    let mut child = spawn_firecracker(command, Path::new("/"), None)
        .await
        .unwrap();
    let mut stdout = String::new();
    child
        .stdout
        .take()
        .unwrap()
        .read_to_string(&mut stdout)
        .await
        .unwrap();
    assert!(child.wait().await.unwrap().success());
    assert_eq!(stdout, "2048\n2048\n");
}

#[tokio::test]
async fn invalid_cgroup_fails_closed_without_exec() {
    let temp = tempfile::tempdir().unwrap();
    let marker = temp.path().join("executed");
    let directory = std::fs::File::open(temp.path()).unwrap();
    let mut command = Command::new("/usr/bin/touch");
    command.arg(&marker);

    assert!(
        spawn_firecracker(command, Path::new("/"), Some(directory))
            .await
            .is_err()
    );
    assert!(!marker.exists());
}
