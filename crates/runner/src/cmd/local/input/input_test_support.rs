use std::ffi::OsStr;
use std::fs::File;
use std::io::{Read, Write};
use std::os::unix::net::UnixStream;
use std::time::Duration;

use nix::fcntl::{Flock, FlockArg};

pub(super) const CHILD_SCENARIO: &str = "OKOU_LOCAL_INPUT_RACE_SCENARIO";
pub(super) const CHILD_SOCKET: &str = "OKOU_LOCAL_INPUT_RACE_SOCKET";
pub(super) const CLEANUP_FIRST: &str = "cleanup-first";
pub(super) const PUBLISHER_FIRST: &str = "publisher-first";
pub(super) const CLEANUP_CONTENDED: &str = "cleanup-contended";
pub(super) const RENDEZVOUS_TIMEOUT: Duration = Duration::from_secs(5);

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
