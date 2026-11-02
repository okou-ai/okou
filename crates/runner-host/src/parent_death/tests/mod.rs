use super::*;

#[tokio::test]
async fn configured_child_spawns_with_expected_parent() {
    let mut command = tokio::process::Command::new("/bin/true");
    configure_parent_death_signal(&mut command);

    let status = command.status().await.unwrap();

    assert!(status.success());
}

#[tokio::test]
async fn changed_parent_rejects_child_before_exec() {
    let unexpected_parent = nix::unistd::getppid();
    assert_ne!(unexpected_parent, nix::unistd::getpid());
    let mut command = tokio::process::Command::new("/bin/true");
    configure_parent_death_signal_for(&mut command, unexpected_parent);

    let error = command.status().await.unwrap_err();

    assert_eq!(error.raw_os_error(), Some(nix::libc::ESRCH));
}
