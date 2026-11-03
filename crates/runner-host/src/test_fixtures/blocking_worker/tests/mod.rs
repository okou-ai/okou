use super::*;
use std::sync::mpsc::{self, TryRecvError};
use std::time::Duration;

const WAIT: Duration = Duration::from_secs(5);

#[test]
fn unwind_releases_worker_before_join() {
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("released");
    let output = marker.clone();
    let (started, ready) = mpsc::sync_channel(0);
    let (release, wait) = mpsc::channel();
    let worker = std::thread::spawn(move || {
        started.send(()).unwrap();
        wait.recv_timeout(WAIT).unwrap();
        std::fs::write(output, b"released").unwrap();
    });
    ready.recv_timeout(WAIT).unwrap();

    let outcome = std::panic::catch_unwind(|| {
        let _release = BlockingWorkerRelease::new(release);
        panic!("exercise assertion unwinding");
    });
    let completion = worker.join();

    assert!(outcome.is_err());
    completion.unwrap();
    assert_eq!(std::fs::read(marker).unwrap(), b"released");
}

#[test]
fn checked_release_sends_exactly_once() {
    let (release, wait) = mpsc::channel();
    BlockingWorkerRelease::new(release).release().unwrap();

    wait.recv_timeout(WAIT).unwrap();
    assert_eq!(wait.try_recv(), Err(TryRecvError::Disconnected));
}

#[test]
fn disconnected_receiver_is_checked_explicitly_and_tolerated_on_drop() {
    let (release, wait) = mpsc::channel();
    drop(wait);
    assert!(BlockingWorkerRelease::new(release).release().is_err());

    let (release, wait) = mpsc::channel();
    drop(wait);
    drop(BlockingWorkerRelease::new(release));
}
