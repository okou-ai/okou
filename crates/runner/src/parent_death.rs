//! Linux parent-death setup for runner-owned child commands.

use nix::unistd::Pid;

/// Configure a command with the runner's parent-death contract.
pub(crate) fn configure_parent_death_signal(command: &mut tokio::process::Command) {
    configure_parent_death_signal_for(command, nix::unistd::getpid());
}

fn configure_parent_death_signal_for(command: &mut tokio::process::Command, expected_parent: Pid) {
    // SAFETY: `set_pdeathsig` and `getppid` are async-signal-safe. Installing
    // the signal before checking the captured parent closes the fork-to-prctl
    // race: a reparented child fails before exec instead of running unowned.
    unsafe {
        command.pre_exec(move || {
            nix::sys::prctl::set_pdeathsig(nix::sys::signal::Signal::SIGKILL)
                .map_err(std::io::Error::from)?;
            if nix::unistd::getppid() != expected_parent {
                return Err(std::io::Error::from_raw_os_error(nix::libc::ESRCH));
            }
            Ok(())
        });
    }
}

runner_test_group!(runtime_control; #[cfg(test)]
mod tests {
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
});
