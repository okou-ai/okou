//! Linux parent-death setup for runner-owned child commands.

use nix::unistd::Pid;

/// Configure a command with the runner's parent-death contract.
pub fn configure_parent_death_signal(command: &mut tokio::process::Command) {
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

#[cfg(test)]
mod tests;
