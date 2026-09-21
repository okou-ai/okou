use std::ffi::OsStr;

pub(super) const INTERRUPT_CHILD_ENV: &str = "OKOU_RUNNER_LOCAL_SUBMIT_INTERRUPT_TEST";
pub(super) const INTERRUPT_CHILD_VALUE: &str = "after-job-publication";
pub(super) const SECOND_INTERRUPT_CHILD_VALUE: &str = "second-interrupt-after-claim";

pub(super) fn post_publish_test_checkpoint() {
    let value = std::env::var_os(INTERRUPT_CHILD_ENV);
    if value.as_deref() != Some(OsStr::new(INTERRUPT_CHILD_VALUE))
        && value.as_deref() != Some(OsStr::new(SECOND_INTERRUPT_CHILD_VALUE))
    {
        return;
    }

    send_sigint();
}

pub(super) fn send_sigint() {
    nix::sys::signal::kill(nix::unistd::Pid::this(), nix::sys::signal::Signal::SIGINT)
        .expect("send SIGINT to local submit test process");
}
